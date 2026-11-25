package main

// 把账号写进本机 Antigravity 客户端：凭据管理器、~/.gemini 下的凭据文件、
// 桌面客户端的 state.vscdb 与 storage.json（设备指纹）。写入位置与格式参照
// lbjlaq/Antigravity-Manager 的实现，并按本机实际文件核对过；代码是独立实现的。

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type clientTarget string

const (
	targetCLI     clientTarget = "agy"     // Antigravity CLI（agy 命令行）
	targetIDE     clientTarget = "ide"     // Antigravity IDE（VS Code 架构的编辑器）
	targetClassic clientTarget = "classic" // Antigravity 经典款（原生桌面端）
)

var clientTargets = []clientTarget{targetCLI, targetIDE, targetClassic}

func (t clientTarget) label() string {
	switch t {
	case targetCLI:
		return "CLI"
	case targetIDE:
		return "IDE"
	}
	return "经典款"
}

func (t clientTarget) longName() string {
	switch t {
	case targetCLI:
		return "Antigravity CLI"
	case targetIDE:
		return "Antigravity IDE"
	}
	return "Antigravity 经典款"
}

func parseTarget(s string) (clientTarget, error) {
	for _, t := range clientTargets {
		if string(t) == s {
			return t, nil
		}
	}
	return "", errors.New("target 只能是 agy / ide / classic")
}

// 凭据管理器里三个客户端共用的那条凭据（普通凭据，目标名 gemini:antigravity，用户名 antigravity）。
const (
	keyringTarget = "gemini:antigravity"
	keyringUser   = "antigravity"
)

var errUnsupportedOS = errors.New("切换 Antigravity 账号只支持 Windows")

/* ---------- 桌面客户端定位 ---------- */

type procInfo struct {
	pid, ppid uint32
	exe       string // 完整路径，读不到时为空
}

// desktopClient 是 IDE / 经典款在本机的位置与运行状态。
type desktopClient struct {
	target  clientTarget
	dataDir string   // %APPDATA% 下的数据目录，不存在为空
	exe     string   // 用来重新启动的程序路径（取法见 locateDesktop）
	pids    []uint32 // 正在运行的主进程（关闭时连同子进程一起结束）
}

func (d desktopClient) installed() bool { return d.dataDir != "" || d.exe != "" }

func (d desktopClient) storagePath() string {
	return filepath.Join(d.dataDir, "User", "globalStorage", "storage.json")
}

func (d desktopClient) statePath() string {
	return filepath.Join(d.dataDir, "User", "globalStorage", "state.vscdb")
}

func isIDEPath(p string) bool {
	s := strings.ToLower(p)
	for _, m := range []string{"antigravity ide", "antigravity-ide", "antigravity_ide", "antigravityide"} {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// belongsTo 判断进程是不是这个客户端的（主进程、Electron 辅助进程都算，language_server 由主进程树带走）。
func belongsTo(t clientTarget, exe string) bool {
	if exe == "" {
		return false
	}
	base := strings.ToLower(filepath.Base(exe))
	switch t {
	case targetIDE:
		return isIDEPath(exe) && strings.HasSuffix(base, ".exe") && !strings.Contains(base, "language_server") && base != "agy.exe"
	case targetClassic:
		return base == "antigravity.exe" && !isIDEPath(exe)
	}
	return false
}

func dataFolders(t clientTarget) []string {
	if t == targetIDE {
		return []string{"Antigravity IDE", "antigravity-ide", "antigravity_ide"}
	}
	return []string{"Antigravity"}
}

func exeCandidates(t clientTarget) []string {
	names := []string{"Antigravity.exe"}
	if t == targetIDE {
		names = []string{"Antigravity IDE.exe", "antigravity-ide.exe", "Antigravity.exe"}
	}
	var roots []string
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		roots = append(roots, filepath.Join(local, "Programs"), local)
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		if v := os.Getenv(env); v != "" {
			roots = append(roots, v)
		}
	}
	var out []string
	for _, root := range roots {
		for _, folder := range dataFolders(t) {
			for _, name := range names {
				out = append(out, filepath.Join(root, folder, name))
			}
		}
	}
	return out
}

func locateDesktop(t clientTarget, configuredExe string, procs []procInfo) desktopClient {
	d := desktopClient{target: t}
	if appData := os.Getenv("APPDATA"); appData != "" {
		for _, folder := range dataFolders(t) {
			if dir := filepath.Join(appData, folder); fileExists(filepath.Join(dir, "User")) {
				d.dataDir = dir
				break
			}
		}
	}
	mine := map[uint32]procInfo{}
	for _, p := range procs {
		if belongsTo(t, p.exe) {
			mine[p.pid] = p
		}
	}
	running := ""
	for _, p := range mine {
		if _, child := mine[p.ppid]; !child {
			d.pids = append(d.pids, p.pid)
			running = p.exe
		}
	}
	// 重启用的程序：设置里填的 > 常见安装位置 > 正在运行的那个。正在运行的可能是自动更新时
	// 挪到临时目录里的旧版本（本机实测过），所以排在最后，并且不用临时目录里的。
	if configuredExe != "" && fileExists(configuredExe) {
		d.exe = configuredExe
	}
	for _, c := range exeCandidates(t) {
		if d.exe == "" && fileExists(c) {
			d.exe = c
		}
	}
	if d.exe == "" && running != "" && !strings.Contains(strings.ToLower(running), `\appdata\local\temp\`) {
		d.exe = running
	}
	return d
}

func cliInstalled() bool {
	if _, err := exec.LookPath("agy"); err == nil {
		return true
	}
	dir, err := geminiDir()
	return err == nil && fileExists(filepath.Join(dir, "antigravity-cli"))
}

func cliRunning(procs []procInfo) bool {
	for _, p := range procs {
		if strings.EqualFold(filepath.Base(p.exe), "agy.exe") && !isIDEPath(p.exe) {
			return true
		}
	}
	return false
}

/* ---------- ~/.gemini 凭据文件 ---------- */

func geminiDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".gemini"), nil
}

func cliTokenPath(dir string) string {
	return filepath.Join(dir, "antigravity-cli", "antigravity-oauth-token")
}

// writeFileCredentials 写 ~/.gemini 下的凭据文件：语言服务的回退凭据、Gemini 格式的 oauth_creds.json
// 和当前账号记录；forCLI 时另写 agy 专用的凭据（切 IDE / 经典款时不动它）。
func writeFileCredentials(dir string, c agyCreds, forCLI bool) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	pretty, _ := json.MarshalIndent(json.RawMessage(credentialJSON(c)), "", "  ")
	var errs []error
	if err := os.WriteFile(filepath.Join(dir, "jetski-standalone-oauth-token"), pretty, 0o600); err != nil {
		errs = append(errs, err)
	}
	if forCLI {
		p := cliTokenPath(dir)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			errs = append(errs, err)
		} else if err := os.WriteFile(p, pretty, 0o600); err != nil {
			errs = append(errs, err)
		}
	}
	creds, _ := json.MarshalIndent(map[string]any{
		"access_token":  c.AccessToken,
		"refresh_token": c.RefreshToken,
		"token_type":    "Bearer",
		"expiry_date":   c.Expiry.UnixMilli(),
		"id_token":      c.IDToken,
		"scope":         oauthScopes,
	}, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "oauth_creds.json"), creds, 0o600); err != nil {
		errs = append(errs, err)
	}
	if err := setActiveGoogleAccount(filepath.Join(dir, "google_accounts.json"), c.Email); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// setActiveGoogleAccount 只改 active，保留文件里其它字段。
func setActiveGoogleAccount(path, email string) error {
	m := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &m)
	}
	m["active"], _ = json.Marshal(email)
	out, _ := json.MarshalIndent(m, "", "  ")
	return os.WriteFile(path, out, 0o600)
}

func readCLIFileCredential(dir string) (refreshToken, email string, err error) {
	raw, err := os.ReadFile(cliTokenPath(dir))
	if err != nil {
		return "", "", err
	}
	return parseCredential(raw)
}

/* ---------- state.vscdb ---------- */

func openStateDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

type sqlExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func putItem(ex sqlExecer, key, value string) error {
	_, err := ex.Exec(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, key, value)
	return err
}

// injectStateDB 把账号写进桌面客户端的 state.vscdb（客户端需已关闭）。
func injectStateDB(path string, c agyCreds) error {
	db, err := openStateDB(path)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var current sql.NullString
	err = tx.QueryRow(`SELECT value FROM ItemTable WHERE key = ?`, topicOAuthToken).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("读取登录状态失败：%w", err)
	}
	var topic []byte
	if current.String != "" {
		if topic, err = base64.StdEncoding.DecodeString(current.String); err != nil {
			return fmt.Errorf("登录状态格式不对：%w", err)
		}
	}
	if topic, err = setTopicEntry(topic, sentinelOAuth, encodeOAuthTokenInfo(c)); err != nil {
		return fmt.Errorf("登录状态格式不对：%w", err)
	}
	gcp := "false"
	if c.GCP {
		gcp = "true"
	}
	items := [][2]string{
		{topicOAuthToken, base64.StdEncoding.EncodeToString(topic)},
		{topicUserStatus, base64.StdEncoding.EncodeToString(topicEntry(sentinelUserStatus, userStatusPayload(c.Email)))},
		{"antigravityOnboarding", "true"},
		{"agy.onboarding.lastLoginUsername", c.Email},
		{"agy.onboarding.lastLoginIsGcpTos", gcp},
		{"jetski.onboarding.lastLoginUsername", c.Email},
		{"jetski.onboarding.lastLoginIsGcpTos", gcp},
	}
	if c.GCP && c.Project != "" {
		items = append(items, [2]string{topicEnterprise,
			base64.StdEncoding.EncodeToString(topicEntry(sentinelProject, pbAppendString(nil, 3, c.Project)))})
	} else if _, err := tx.Exec(`DELETE FROM ItemTable WHERE key = ?`, topicEnterprise); err != nil {
		return err
	}
	for _, kv := range items {
		if err := putItem(tx, kv[0], kv[1]); err != nil {
			return fmt.Errorf("写入登录状态失败：%w", err)
		}
	}
	// 旧格式的初始化状态里存着上一个号的用户 ID，留着会让新号读不到历史会话。
	if _, err := tx.Exec(`DELETE FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'`); err != nil {
		return err
	}
	return tx.Commit()
}

// readStateDB 读出 state.vscdb 里当前登录账号的 refresh token 和邮箱。
func readStateDB(path string) (refreshToken, email string, err error) {
	db, err := openStateDB(path)
	if err != nil {
		return "", "", err
	}
	defer db.Close()
	payload := func(key, sentinel string) []byte {
		var v string
		if db.QueryRow(`SELECT value FROM ItemTable WHERE key = ?`, key).Scan(&v) != nil {
			return nil
		}
		topic, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			return nil
		}
		p, _ := topicPayload(topic, sentinel)
		return p
	}
	if p := payload(topicOAuthToken, sentinelOAuth); p != nil {
		var idToken string
		refreshToken, idToken, _ = decodeOAuthTokenInfo(p)
		email = jwtEmail(idToken)
	}
	if email == "" {
		if p := payload(topicUserStatus, sentinelUserStatus); p != nil {
			email = strings.ToLower(userStatusEmail(p))
		}
	}
	if refreshToken == "" && email == "" {
		return "", "", errors.New("没有登录信息")
	}
	return refreshToken, email, nil
}

/* ---------- 设备指纹 ---------- */

// deviceProfile 是 storage.json 里的遥测标识；每个号固定一套，切号时写入，让不同号看起来来自不同设备。
type deviceProfile struct {
	MachineID    string `json:"machine_id"`
	MacMachineID string `json:"mac_machine_id"`
	DevDeviceID  string `json:"dev_device_id"`
	SqmID        string `json:"sqm_id"`
}

func randomUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func newDeviceProfile() deviceProfile {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	var b [32]byte
	rand.Read(b[:])
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return deviceProfile{
		MachineID:    "auth0|user_" + string(b[:]),
		MacMachineID: randomUUID(),
		DevDeviceID:  randomUUID(),
		SqmID:        "{" + strings.ToUpper(randomUUID()) + "}",
	}
}

var telemetryKeys = [4]string{"machineId", "macMachineId", "devDeviceId", "sqmId"}

func (p deviceProfile) values() [4]string {
	return [4]string{p.MachineID, p.MacMachineID, p.DevDeviceID, p.SqmID}
}

// readDeviceProfile 读 storage.json 里的指纹（兼容嵌套的 telemetry 对象和平铺的 telemetry.xxx）。
func readDeviceProfile(storagePath string) (deviceProfile, error) {
	raw, err := os.ReadFile(storagePath)
	if err != nil {
		return deviceProfile{}, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return deviceProfile{}, err
	}
	nested := map[string]string{}
	if t, ok := m["telemetry"]; ok {
		_ = json.Unmarshal(t, &nested)
	}
	var vals [4]string
	for i, k := range telemetryKeys {
		if v := nested[k]; v != "" {
			vals[i] = v
		} else if flat, ok := m["telemetry."+k]; ok {
			_ = json.Unmarshal(flat, &vals[i])
		}
		if vals[i] == "" {
			return deviceProfile{}, errors.New("storage.json 里没有完整的设备指纹")
		}
	}
	return deviceProfile{vals[0], vals[1], vals[2], vals[3]}, nil
}

// applyDeviceProfile 写入 storage.json（嵌套与平铺两种写法都写，其它字段原样保留），
// 并同步 storage.serviceMachineId（storage.json 与 state.vscdb 各一份）。
func applyDeviceProfile(d desktopClient, p deviceProfile) error {
	path := d.storagePath()
	m := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &m); err != nil {
			return fmt.Errorf("storage.json 格式不对：%w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	nested := map[string]json.RawMessage{}
	if t, ok := m["telemetry"]; ok {
		_ = json.Unmarshal(t, &nested)
	}
	for i, v := range p.values() {
		enc, _ := json.Marshal(v)
		nested[telemetryKeys[i]] = enc
		m["telemetry."+telemetryKeys[i]] = enc
	}
	m["telemetry"], _ = json.Marshal(nested)
	m["storage.serviceMachineId"], _ = json.Marshal(p.DevDeviceID)
	out, _ := json.MarshalIndent(m, "", "\t")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".gam-tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	if !fileExists(d.statePath()) {
		return nil
	}
	db, err := openStateDB(d.statePath())
	if err != nil {
		return err
	}
	defer db.Close()
	return putItem(db, "storage.serviceMachineId", p.DevDeviceID)
}

func freshExpiry(expiresIn int64) time.Time {
	if expiresIn <= 0 {
		expiresIn = 3599
	}
	return time.Now().Add(time.Duration(expiresIn) * time.Second).Truncate(time.Second)
}
