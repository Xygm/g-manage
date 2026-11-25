package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const dateLayout = "2006-01-02"

var (
	ErrNotFound  = errors.New("账号不存在")
	ErrDuplicate = errors.New("这个邮箱已经存在")
)

type Account struct {
	ID             int64    `json:"id"`
	Email          string   `json:"email"`
	Note           string   `json:"note"`
	Tags           []string `json:"tags"`             // 账号标签列表，如 ["Jio", "印度Pro"]
	LoginDate      string   `json:"login_date"`       // 首次登录日期 YYYY-MM-DD
	RiskDays       int      `json:"risk_days"`        // 风控期天数
	PwdChangedDate string   `json:"pwd_changed_date"` // 改密日期，空 = 本次登录后还没改
	Proxy          string   `json:"proxy"`            // 空 = 用设置里的默认代理
	ProfileDir     string   `json:"profile_dir"`      // Chrome 用户数据目录；空 = 数据目录/profiles/<邮箱>
	ChromeProfile  string   `json:"chrome_profile"`   // 用户数据目录里的个人资料文件夹，如 "Profile 11"；空 = 独立浏览器
	CreatedAt      int64    `json:"created_at"`

	// 只写：提交时非空才覆盖，返回给界面前清空。
	RefreshToken string `json:"refresh_token,omitempty"`
	Password     string `json:"password,omitempty"`    // 账号密码，明文保存
	TotpSecret   string `json:"totp_secret,omitempty"` // 2FA 密钥（规范化的 Base32），明文保存
	// 提交时为 true 表示清除已保存的密码 / 2FA 密钥（同时填了新值则以新值为准）。
	ClearPassword bool `json:"clear_password,omitempty"`
	ClearTotp     bool `json:"clear_totp,omitempty"`

	PendingPassword  string `json:"-"` // 改密时生成、还没确认改成功的新密码
	PreviousPassword string `json:"-"` // 上一次确认改密前的旧密码

	QuotaJSON  string `json:"-"`           // QuotaInfo 的 JSON，空 = 还没查到过
	QuotaError string `json:"quota_error"` // 最近一次查询失败的原因
	QuotaAt    int64  `json:"quota_at"`    // 最近一次查询时间（Unix 秒）

	DeviceProfile string `json:"-"` // 切号时写给 Antigravity 的设备指纹（deviceProfile 的 JSON），空 = 还没切过
	SwitchedAt    int64  `json:"-"` // 最近一次被切成客户端当前账号的时间（Unix 秒），「切下个」按它轮换
}

type Settings struct {
	ChromePath      string            `json:"chrome_path"`
	ChromeUserData  string            `json:"chrome_user_data"` // 日常 Chrome 的用户数据目录，空 = 默认位置
	DefaultProxy    string            `json:"default_proxy"`
	DefaultRiskDays int               `json:"default_risk_days"`
	TagColors       map[string]string `json:"tag_colors,omitempty"` // 标签名（小写）→ 调色板名称
	IDEPath         string            `json:"ide_path"`             // Antigravity IDE 程序路径，空 = 自动查找
	ClassicPath     string            `json:"classic_path"`         // Antigravity 经典款程序路径，空 = 自动查找
	NextPool        string            `json:"next_pool"`            // 「切下个」看哪个额度池：any / gemini / claude
	NextThreshold   int               `json:"next_threshold"`       // 「切下个」要求该池剩余额度至少多少 %
}

var defaultSettings = Settings{DefaultRiskDays: 7, NextPool: poolAny, NextThreshold: 10}

// UIPrefs 是托盘小窗的偏好，和设置弹窗分开存，避免保存设置时被覆盖。
type UIPrefs struct {
	Lightweight bool `json:"lightweight"` // 关闭主控制台时直接销毁窗口释放内存（否则只隐藏）
	MiniPinned  bool `json:"mini_pinned"` // 小窗置顶且失焦不收起
}

func today() string { return time.Now().Format(dateLayout) }

// parseProxy 接受 host:port、http://、https://、socks5://；
// 账号密码不支持（Chrome 的 --proxy-server 不支持）。
func parseProxy(p string) (*url.URL, error) {
	if !strings.Contains(p, "://") {
		p = "http://" + p
	}
	u, err := url.Parse(p)
	if err != nil || u.Hostname() == "" || u.Port() == "" {
		return nil, errors.New("代理格式应为 socks5://IP:端口 或 http://IP:端口")
	}
	switch u.Scheme {
	case "http", "https", "socks5":
	default:
		return nil, errors.New("代理只支持 http / https / socks5")
	}
	if u.User != nil {
		return nil, errors.New("代理不支持账号密码，请先用本地代理软件转成无密码端口")
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, nil
}

func normalizeProxy(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", nil
	}
	u, err := parseProxy(p)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (a *Account) normalize() error {
	a.Email = strings.ToLower(strings.TrimSpace(a.Email))
	a.Note = strings.TrimSpace(a.Note)
	tags, err := normalizeTags(a.Tags)
	if err != nil {
		return err
	}
	a.Tags = tags
	a.LoginDate = strings.TrimSpace(a.LoginDate)
	a.PwdChangedDate = strings.TrimSpace(a.PwdChangedDate)
	a.ProfileDir = strings.TrimSpace(a.ProfileDir)
	a.ChromeProfile = strings.TrimSpace(a.ChromeProfile)
	a.RefreshToken = strings.TrimSpace(a.RefreshToken)

	if at := strings.IndexByte(a.Email, '@'); at <= 0 || at == len(a.Email)-1 {
		return errors.New("邮箱格式不对")
	}
	if _, err := time.Parse(dateLayout, a.LoginDate); err != nil {
		return errors.New("首次登录日期格式应为 YYYY-MM-DD")
	}
	if a.LoginDate > today() {
		return errors.New("首次登录日期不能晚于今天")
	}
	if a.PwdChangedDate != "" {
		if _, err := time.Parse(dateLayout, a.PwdChangedDate); err != nil {
			return errors.New("改密日期格式应为 YYYY-MM-DD")
		}
	}
	if a.RiskDays < 0 {
		return errors.New("风控期天数不能是负数")
	}
	if a.TotpSecret != "" {
		if a.TotpSecret, err = parseTotpSecret(a.TotpSecret); err != nil {
			return err
		}
	}
	if a.ChromeProfile != "" && (strings.ContainsAny(a.ChromeProfile, `/\`) || strings.Contains(a.ChromeProfile, "..")) {
		return errors.New("个人资料文件夹只填文件夹名，如 Profile 11")
	}
	if a.ChromeProfile != "" && a.ProfileDir == "" {
		return errors.New("填了个人资料文件夹，就要同时填 Chrome 用户数据目录")
	}
	a.Proxy, err = normalizeProxy(a.Proxy)
	return err
}

// normalizeTags 逐条去空格、校验长度并按不区分大小写去重（不按逗号拆，一个就是一条）。
func normalizeTags(items []string) ([]string, error) {
	seen := map[string]bool{}
	tags := make([]string, 0, len(items))
	for _, item := range items {
		tag := strings.TrimSpace(item)
		if tag == "" {
			continue
		}
		if len([]rune(tag)) > 30 {
			return nil, errors.New("单个标签不能超过 30 个字符")
		}
		key := strings.ToLower(tag)
		if !seen[key] {
			seen[key] = true
			tags = append(tags, tag)
		}
	}
	if len(tags) > 20 {
		return nil, errors.New("每个账号最多 20 个标签")
	}
	return tags, nil
}

func encodeTags(tags []string) string {
	if len(tags) == 0 {
		return ""
	}
	b, _ := json.Marshal(tags)
	return string(b)
}

// decodeTags 兼容新格式 JSON 数组与旧格式逗号分隔字符串。
func decodeTags(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}
	}
	if strings.HasPrefix(raw, "[") {
		var list []string
		if json.Unmarshal([]byte(raw), &list) == nil {
			if list == nil {
				return []string{}
			}
			return list
		}
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '，' || r == ';' || r == '；'
	})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

type Store struct{ db *sql.DB }

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// 单连接：本地单用户程序，避免 SQLite 写锁竞争，PRAGMA 也只需设一次。
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS accounts (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	email            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
	note             TEXT    NOT NULL DEFAULT '',
	login_date       TEXT    NOT NULL,
	risk_days        INTEGER NOT NULL,
	pwd_changed_date TEXT    NOT NULL DEFAULT '',
	proxy            TEXT    NOT NULL DEFAULT '',
	profile_dir      TEXT    NOT NULL DEFAULT '',
	created_at       INTEGER NOT NULL,
	refresh_token    TEXT    NOT NULL DEFAULT '',
	quota_json       TEXT    NOT NULL DEFAULT '',
	quota_error      TEXT    NOT NULL DEFAULT '',
	quota_at         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);`); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据库：%w", err)
	}
	// 旧版本建的表缺少后加的列，在这里补上。
	for _, c := range []struct{ name, def string }{
		{"chrome_profile", `TEXT NOT NULL DEFAULT ''`},
		{"tags", `TEXT NOT NULL DEFAULT ''`},
		{"password", `TEXT NOT NULL DEFAULT ''`},
		{"totp_secret", `TEXT NOT NULL DEFAULT ''`},
		{"pending_password", `TEXT NOT NULL DEFAULT ''`},
		{"previous_password", `TEXT NOT NULL DEFAULT ''`},
		{"device_profile", `TEXT NOT NULL DEFAULT ''`},
		{"switched_at", `INTEGER NOT NULL DEFAULT 0`},
	} {
		if err := addColumnIfMissing(db, "accounts", c.name, c.def); err != nil {
			db.Close()
			return nil, fmt.Errorf("升级数据库：%w", err)
		}
	}
	return &Store{db: db}, nil
}

func addColumnIfMissing(db *sql.DB, table, column, def string) error {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	_, err = db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + def)
	return err
}

const accountCols = `id, email, note, tags, login_date, risk_days, pwd_changed_date, proxy, profile_dir, chrome_profile, created_at,
	refresh_token, quota_json, quota_error, quota_at, password, totp_secret, pending_password, previous_password, device_profile, switched_at`

func scanAccount(row interface{ Scan(...any) error }) (Account, error) {
	var a Account
	var tagsRaw string
	err := row.Scan(&a.ID, &a.Email, &a.Note, &tagsRaw, &a.LoginDate, &a.RiskDays, &a.PwdChangedDate, &a.Proxy, &a.ProfileDir, &a.ChromeProfile, &a.CreatedAt,
		&a.RefreshToken, &a.QuotaJSON, &a.QuotaError, &a.QuotaAt, &a.Password, &a.TotpSecret, &a.PendingPassword, &a.PreviousPassword, &a.DeviceProfile, &a.SwitchedAt)
	a.Tags = decodeTags(tagsRaw)
	return a, err
}

func (s *Store) ListAccounts() ([]Account, error) {
	rows, err := s.db.Query(`SELECT ` + accountCols + ` FROM accounts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetAccount(id int64) (Account, error) {
	a, err := scanAccount(s.db.QueryRow(`SELECT `+accountCols+` FROM accounts WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

func isUniqueErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func (s *Store) CreateAccount(a *Account) error {
	a.CreatedAt = time.Now().Unix()
	res, err := s.db.Exec(`INSERT INTO accounts (email, note, tags, login_date, risk_days, pwd_changed_date, proxy, profile_dir, chrome_profile, created_at, refresh_token,
		password, totp_secret)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.Email, a.Note, encodeTags(a.Tags), a.LoginDate, a.RiskDays, a.PwdChangedDate, a.Proxy, a.ProfileDir, a.ChromeProfile, a.CreatedAt, a.RefreshToken,
		a.Password, a.TotpSecret)
	if isUniqueErr(err) {
		return ErrDuplicate
	}
	if err != nil {
		return err
	}
	a.ID, err = res.LastInsertId()
	return err
}

// UpdateAccount 更新编辑弹窗里的字段（不动标签，标签由列表行内 SetTags 独立保存）。
// RefreshToken、Password、TotpSecret 为空时保留原值；ClearPassword / ClearTotp 为 true 且没填新值时清除。
func (s *Store) UpdateAccount(a Account) error {
	setPassword := a.Password != "" || a.ClearPassword
	setTotp := a.TotpSecret != "" || a.ClearTotp
	res, err := s.db.Exec(`UPDATE accounts SET email = ?, note = ?, login_date = ?, risk_days = ?, pwd_changed_date = ?, proxy = ?, profile_dir = ?, chrome_profile = ?,
		refresh_token = CASE WHEN ? = '' THEN refresh_token ELSE ? END,
		password = CASE WHEN ? THEN ? ELSE password END,
		totp_secret = CASE WHEN ? THEN ? ELSE totp_secret END
		WHERE id = ?`,
		a.Email, a.Note, a.LoginDate, a.RiskDays, a.PwdChangedDate, a.Proxy, a.ProfileDir, a.ChromeProfile, a.RefreshToken, a.RefreshToken,
		setPassword, a.Password, setTotp, a.TotpSecret, a.ID)
	if isUniqueErr(err) {
		return ErrDuplicate
	}
	return affectedOne(res, err)
}

func (s *Store) SetTags(id int64, tags []string) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET tags = ? WHERE id = ?`, encodeTags(tags), id))
}

func (s *Store) SetRefreshToken(id int64, token string) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET refresh_token = ? WHERE id = ?`, token, id))
}

func (s *Store) SetPendingPassword(id int64, pw string) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET pending_password = ? WHERE id = ?`, pw, id))
}

// ConfirmPasswordChange 把待确认的新密码转为当前密码，旧密码存入 previous_password，并记录改密日期。
func (s *Store) ConfirmPasswordChange(id int64, date string) error {
	res, err := s.db.Exec(`UPDATE accounts SET previous_password = password, password = pending_password, pending_password = '', pwd_changed_date = ?
		WHERE id = ? AND pending_password != ''`, date, id)
	err = affectedOne(res, err)
	if !errors.Is(err, ErrNotFound) {
		return err
	}
	if _, err := s.GetAccount(id); err != nil {
		return err // 账号本身不存在
	}
	return errNoPendingPassword
}

// SetBrowserProfile 设置账号用哪个浏览器资料打开；两者都为空 = 程序自带的独立浏览器。
func (s *Store) SetBrowserProfile(id int64, userDataDir, profile string) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET profile_dir = ?, chrome_profile = ? WHERE id = ?`, userDataDir, profile, id))
}

// FindByEmail 按邮箱查账号（不区分大小写）。
func (s *Store) FindByEmail(email string) (Account, error) {
	a, err := scanAccount(s.db.QueryRow(`SELECT `+accountCols+` FROM accounts WHERE email = ?`, email))
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// SetQuota 记录一次额度查询结果：成功时覆盖额度并清掉错误；失败时保留上次的额度，只记错误。
func (s *Store) SetQuota(id int64, info *QuotaInfo, queryErr error) error {
	now := time.Now().Unix()
	if queryErr != nil {
		return affectedOne(s.db.Exec(`UPDATE accounts SET quota_error = ?, quota_at = ? WHERE id = ?`, queryErr.Error(), now, id))
	}
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	return affectedOne(s.db.Exec(`UPDATE accounts SET quota_json = ?, quota_error = '', quota_at = ? WHERE id = ?`, string(raw), now, id))
}

func (s *Store) SetPasswordChanged(id int64, date string) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET pwd_changed_date = ? WHERE id = ?`, date, id))
}

func (s *Store) SetDeviceProfile(id int64, raw string) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET device_profile = ? WHERE id = ?`, raw, id))
}

func (s *Store) SetSwitchedAt(id int64, at int64) error {
	return affectedOne(s.db.Exec(`UPDATE accounts SET switched_at = ? WHERE id = ?`, at, id))
}

func (s *Store) DeleteAccount(id int64) error {
	return affectedOne(s.db.Exec(`DELETE FROM accounts WHERE id = ?`, id))
}

func affectedOne(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) GetSettings() (Settings, error) {
	st := defaultSettings
	var raw string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = 'app'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal([]byte(raw), &st)
}

func (s *Store) SaveSettings(st Settings) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings (key, value) VALUES ('app', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(raw))
	return err
}

func (s *Store) GetUIPrefs() (UIPrefs, error) {
	var p UIPrefs
	var raw string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = 'ui'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	return p, json.Unmarshal([]byte(raw), &p)
}

func (s *Store) SaveUIPrefs(p UIPrefs) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings (key, value) VALUES ('ui', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(raw))
	return err
}
