package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type App struct {
	store   *Store
	dataDir string
	addr    string

	mu      sync.Mutex
	pending map[string]pendingAuth // OAuth state → 正在授权的账号
	vault   vaultState             // 查看密码的解锁状态，受 mu 保护

	browserLocks sync.Map   // 邮箱 → *sync.Mutex：同一账号的浏览器资料同时只做一件事（写密码库 / 启动）
	switchMu     sync.Mutex // 同一时间只做一次切号（会关闭 / 重启客户端、改凭据管理器）
}

type pendingAuth struct {
	accountID int64
	expires   time.Time
}

const authTimeout = 15 * time.Minute

// 风控状态
const (
	statusRisk    = "risk"    // 还在风控期内
	statusDue     = "due"     // 风控期已过，该改密码了
	statusChanged = "changed" // 本次登录后已改过密码
)

type AccountView struct {
	Account
	LoginDays   int        `json:"login_days"`
	RiskLeft    int        `json:"risk_left"`
	Status      string     `json:"status"`
	ProfilePath string     `json:"profile_path"`
	HasToken    bool       `json:"has_token"`
	HasAvatar   bool       `json:"has_avatar"`
	HasPassword bool       `json:"has_password"`
	HasTotp     bool       `json:"has_totp"`
	HasPending  bool       `json:"has_pending_password"` // 有生成了但还没确认的新密码
	Quota       *QuotaInfo `json:"quota"`
}

func daysBetween(from, to string) int {
	f, err1 := time.Parse(dateLayout, from)
	t, err2 := time.Parse(dateLayout, to)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(t.Sub(f) / (24 * time.Hour))
}

func (a *App) view(acc Account, now string) AccountView {
	v := AccountView{
		Account:     acc,
		LoginDays:   daysBetween(acc.LoginDate, now),
		ProfilePath: a.profilePath(acc),
		HasToken:    acc.RefreshToken != "",
	}
	// 只写字段绝不回传给界面（创建时 acc 里还带着明文）。
	v.RefreshToken, v.Password, v.TotpSecret = "", "", ""
	v.ClearPassword, v.ClearTotp = false, false
	v.HasPassword = acc.Password != ""
	v.HasTotp = acc.TotpSecret != ""
	v.HasPending = acc.PendingPassword != ""
	v.HasAvatar = fileExists(a.avatarPath(acc))
	if acc.QuotaJSON != "" {
		var q QuotaInfo
		if json.Unmarshal([]byte(acc.QuotaJSON), &q) == nil {
			v.Quota = &q
		}
	}
	v.Status, v.RiskLeft = accountStatus(acc, now)
	return v
}

// accountStatus 返回风控状态；还在风控期内时同时返回剩余天数。
func accountStatus(acc Account, now string) (status string, riskLeft int) {
	loginDays := daysBetween(acc.LoginDate, now)
	switch {
	case acc.PwdChangedDate != "" && acc.PwdChangedDate >= acc.LoginDate:
		return statusChanged, 0
	case loginDays >= acc.RiskDays:
		return statusDue, 0
	}
	return statusRisk, acc.RiskDays - loginDays
}

func (a *App) profilePath(acc Account) string {
	if acc.ProfileDir != "" {
		return acc.ProfileDir
	}
	return filepath.Join(a.dataDir, "profiles", profileDirName(acc.Email))
}

// proxyFor：账号自己的代理优先，否则用默认代理；浏览器和额度查询走同一个出口。
func proxyFor(acc Account, st Settings) string {
	if acc.Proxy != "" {
		return acc.Proxy
	}
	return st.DefaultProxy
}

func (a *App) redirectURI() string { return "http://" + a.addr + "/oauth/callback" }

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	static, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /oauth/callback", a.oauthCallback)
	mux.HandleFunc("GET /api/accounts", a.listAccounts)
	mux.HandleFunc("POST /api/accounts", a.createAccount)
	mux.HandleFunc("PUT /api/accounts/{id}", a.updateAccount)
	mux.HandleFunc("DELETE /api/accounts/{id}", a.deleteAccount)
	mux.HandleFunc("PUT /api/accounts/{id}/tags", a.updateTags)
	mux.HandleFunc("POST /api/accounts/{id}/open", a.openAccount)
	mux.HandleFunc("POST /api/accounts/{id}/authorize", a.authorize)
	mux.HandleFunc("POST /api/accounts/{id}/password-changed", a.passwordChanged)
	mux.HandleFunc("POST /api/quota/refresh", a.refreshAllQuota)
	mux.HandleFunc("GET /api/accounts/{id}/avatar", a.accountAvatar)
	mux.HandleFunc("GET /api/chrome-profiles", a.chromeProfiles)
	mux.HandleFunc("POST /api/chrome-profiles/import", a.importChromeProfiles)
	mux.HandleFunc("GET /api/chrome-profiles/{dir}/avatar", a.chromeProfileAvatar)
	mux.HandleFunc("POST /api/accounts/detach-chrome", a.detachChromeProfiles)
	mux.HandleFunc("POST /api/accounts/{id}/reveal-password", a.revealPassword)
	mux.HandleFunc("POST /api/accounts/{id}/password-change/start", a.startPasswordChange)
	mux.HandleFunc("POST /api/accounts/{id}/password-change/confirm", a.confirmPasswordChange)
	mux.HandleFunc("POST /api/accounts/{id}/password-change/cancel", a.cancelPasswordChange)
	mux.HandleFunc("GET /api/totp", a.totpCodes)
	mux.HandleFunc("GET /api/vault", a.vaultStatus)
	mux.HandleFunc("POST /api/vault/unlock", a.vaultUnlock)
	mux.HandleFunc("POST /api/vault/lock", a.vaultLock)
	mux.HandleFunc("GET /api/settings", a.getSettings)
	mux.HandleFunc("PUT /api/settings", a.putSettings)
	mux.HandleFunc("PUT /api/tag-colors", a.putTagColor)
	mux.HandleFunc("GET /api/clients", a.listClients)
	mux.HandleFunc("POST /api/accounts/{id}/switch", a.switchAccount)
	mux.HandleFunc("POST /api/clients/{target}/next", a.switchNextAccount)
	mux.HandleFunc("POST /api/clients/{target}/restore-fingerprint", a.restoreFingerprint)
	mux.HandleFunc("GET /api/ui-prefs", a.getUIPrefs)
	mux.HandleFunc("PUT /api/ui-prefs", a.putUIPrefs)
	mux.HandleFunc("POST /api/ui/show-main", a.showMainWindow)
	return a.guard(mux)
}

// guard 防止其它网页借浏览器调用本地接口（启动 Chrome、改数据）：
// 校验 Host 防 DNS 重绑定；写操作要求自定义请求头，跨站请求会被 CORS 预检拦下。
func (a *App) guard(next http.Handler) http.Handler {
	_, port, _ := net.SplitHostPort(a.addr)
	allowed := map[string]bool{a.addr: true, "127.0.0.1:" + port: true, "localhost:" + port: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[r.Host] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Requested-With") != "gam" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, ErrDuplicate):
		status = http.StatusConflict
	case errors.Is(err, ErrVaultLocked):
		status = http.StatusUnauthorized
	case errors.Is(err, errTooManyTries):
		status = http.StatusTooManyRequests
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		return errors.New("请求格式不对：" + err.Error())
	}
	return nil
}

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return 0, ErrNotFound
	}
	return id, nil
}

func (a *App) writeViews(w http.ResponseWriter) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		writeErr(w, err)
		return
	}
	now := today()
	views := make([]AccountView, 0, len(accs))
	for _, acc := range accs {
		views = append(views, a.view(acc, now))
	}
	writeJSON(w, http.StatusOK, views)
}

func (a *App) listAccounts(w http.ResponseWriter, r *http.Request) { a.writeViews(w) }

func (a *App) createAccount(w http.ResponseWriter, r *http.Request) {
	var acc Account
	if err := readJSON(w, r, &acc); err != nil {
		writeErr(w, err)
		return
	}
	if err := acc.normalize(); err != nil {
		writeErr(w, err)
		return
	}
	if err := a.store.CreateAccount(&acc); err != nil {
		writeErr(w, err)
		return
	}
	a.syncPasswordLater(acc.ID)
	writeJSON(w, http.StatusCreated, a.view(acc, today()))
}

func (a *App) updateAccount(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var acc Account
	if err := readJSON(w, r, &acc); err != nil {
		writeErr(w, err)
		return
	}
	acc.ID = id
	if err := acc.normalize(); err != nil {
		writeErr(w, err)
		return
	}
	if err := a.store.UpdateAccount(acc); err != nil {
		writeErr(w, err)
		return
	}
	saved, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	if acc.Password != "" {
		a.syncPasswordLater(id)
	}
	writeJSON(w, http.StatusOK, a.view(saved, today()))
}

func (a *App) deleteAccount(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err == nil {
		err = a.store.DeleteAccount(id)
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) updateTags(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var req struct {
		Tags []string `json:"tags"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, err)
		return
	}
	tags, err := normalizeTags(req.Tags)
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := a.store.SetTags(id, tags); err != nil {
		writeErr(w, err)
		return
	}
	saved, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.view(saved, today()))
}

func (a *App) lockBrowser(email string) func() {
	m, _ := a.browserLocks.LoadOrStore(email, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// syncBrowserPassword 把账号密码写进程序自带浏览器的密码库（日常 Chrome 资料和没存密码的账号跳过）。
// 调用方需持有 lockBrowser。
func (a *App) syncBrowserPassword(acc Account, chrome string, st Settings) error {
	if acc.ChromeProfile != "" || acc.Password == "" {
		return nil
	}
	return syncChromePassword(chrome, a.profilePath(acc), proxyFor(acc, st), acc.Email, acc.Password)
}

// syncPasswordLater 在后台把刚保存的密码写进浏览器；浏览器开着时写不了，下次打开时会再写。
func (a *App) syncPasswordLater(id int64) {
	go func() {
		acc, err := a.store.GetAccount(id)
		if err != nil || acc.ChromeProfile != "" || acc.Password == "" {
			return
		}
		st, err := a.store.GetSettings()
		if err != nil {
			return
		}
		chrome, err := findChrome(st.ChromePath)
		if err != nil {
			return
		}
		defer a.lockBrowser(acc.Email)()
		if err := a.syncBrowserPassword(acc, chrome, st); err != nil {
			log.Printf("把 %s 的密码存进浏览器失败：%v", acc.Email, err)
		}
	}()
}

// launchFor 在账号自己的 Chrome 资料目录里打开 url。返回的 warning 非空表示密码没能写进浏览器，但浏览器已打开。
func (a *App) launchFor(acc Account, url string) (warning string, err error) {
	st, err := a.store.GetSettings()
	if err != nil {
		return "", err
	}
	chrome, err := findChrome(st.ChromePath)
	if err != nil {
		return "", err
	}
	defer a.lockBrowser(acc.Email)()
	if err := a.syncBrowserPassword(acc, chrome, st); err != nil {
		log.Printf("把 %s 的密码存进浏览器失败：%v", acc.Email, err)
		warning = "密码没能存进浏览器：" + err.Error()
	}
	if err := launchChrome(chrome, a.profilePath(acc), acc.ChromeProfile, proxyFor(acc, st), url); err != nil {
		return "", errors.New("启动 Chrome 失败：" + err.Error())
	}
	return warning, nil
}

func writeLaunched(w http.ResponseWriter, warning string) {
	writeJSON(w, http.StatusOK, map[string]string{"warning": warning})
}

func (a *App) openAccount(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	target, ok := openTargets[q.Get("target")]
	if !ok {
		target, ok = allowGoogleURL(q.Get("url"))
	}
	if !ok {
		writeErr(w, errors.New("target 只能是 browser / mail / password 或 Google 官方 https 链接"))
		return
	}
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	acc, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	warning, err := a.launchFor(acc, target)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeLaunched(w, warning)
}

// authorize 在该账号的 Chrome 里打开 Google 授权页；授权完成后 Google 回调 /oauth/callback。
func (a *App) authorize(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	acc, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	state := randomState()
	a.mu.Lock()
	now := time.Now()
	for s, p := range a.pending {
		if now.After(p.expires) {
			delete(a.pending, s)
		}
	}
	a.pending[state] = pendingAuth{accountID: id, expires: now.Add(authTimeout)}
	a.mu.Unlock()

	warning, err := a.launchFor(acc, authURL(a.redirectURI(), state, acc.Email))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeLaunched(w, warning)
}

var callbackPage = template.Must(template.New("cb").Parse(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{{.Title}}</title>
<style>body{font:16px/1.6 "Microsoft YaHei",system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px}
h1{font-size:22px;color:{{if .OK}}#1a7f37{{else}}#cf222e{{end}}}</style></head>
<body><h1>{{.Title}}</h1><p>{{.Message}}</p><p>可以关闭这个页面，回到「谷歌账号管理」。</p></body></html>`))

func renderCallback(w http.ResponseWriter, ok bool, title, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
	}
	callbackPage.Execute(w, map[string]any{"OK": ok, "Title": title, "Message": msg})
}

func (a *App) oauthCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	a.mu.Lock()
	p, ok := a.pending[q.Get("state")]
	delete(a.pending, q.Get("state"))
	a.mu.Unlock()
	if !ok || time.Now().After(p.expires) {
		renderCallback(w, false, "授权链接已失效", "请回到程序里重新点「授权」。")
		return
	}
	if e := q.Get("error"); e != "" {
		renderCallback(w, false, "授权被取消", "Google 返回："+e)
		return
	}
	acc, err := a.store.GetAccount(p.accountID)
	if err != nil {
		renderCallback(w, false, "授权失败", err.Error())
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		renderCallback(w, false, "授权失败", err.Error())
		return
	}
	g, err := newGoogleClient(proxyFor(acc, st))
	if err != nil {
		renderCallback(w, false, "授权失败", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	tok, err := g.exchangeCode(ctx, q.Get("code"), a.redirectURI())
	if err != nil {
		renderCallback(w, false, "授权失败", err.Error())
		return
	}
	if tok.RefreshToken == "" {
		renderCallback(w, false, "授权失败", "Google 没有返回 refresh token，请重新授权一次。")
		return
	}
	email, err := g.userEmail(ctx, tok.AccessToken)
	if err != nil {
		renderCallback(w, false, "授权失败", "读取账号邮箱失败："+err.Error())
		return
	}
	if !sameGoogleAccount(email, acc.Email) {
		renderCallback(w, false, "授权的账号不对",
			fmt.Sprintf("这次授权的是 %s，但要授权的是 %s。请在授权页选对账号后重试。", email, acc.Email))
		return
	}
	if err := a.store.SetRefreshToken(acc.ID, tok.RefreshToken); err != nil {
		renderCallback(w, false, "授权失败", err.Error())
		return
	}
	acc.RefreshToken = tok.RefreshToken
	if err := a.refreshQuota(ctx, acc, st); err != nil {
		renderCallback(w, true, "授权成功", "但查询额度失败："+err.Error())
		return
	}
	renderCallback(w, true, "授权成功", acc.Email+" 的反重力额度已更新。")
}

// refreshQuota 查询一个账号的额度并写入数据库，返回查询错误（已记录到账号上）。
func (a *App) refreshQuota(ctx context.Context, acc Account, st Settings) error {
	g, err := newGoogleClient(proxyFor(acc, st))
	if err != nil {
		return err
	}
	info, qerr := g.fetchQuota(ctx, acc.RefreshToken)
	if err := a.store.SetQuota(acc.ID, &info, qerr); err != nil {
		log.Printf("保存 %s 的额度失败：%v", acc.Email, err)
	}
	return qerr
}

// refreshAllQuota 刷新所有已授权账号的额度；带 ?ids=1,2 时只刷新这几个。
func (a *App) refreshAllQuota(w http.ResponseWriter, r *http.Request) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		writeErr(w, err)
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	var only map[int64]bool
	if raw := r.URL.Query().Get("ids"); raw != "" {
		only = map[int64]bool{}
		for _, s := range strings.Split(raw, ",") {
			if id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil {
				only[id] = true
			}
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()

	sem := make(chan struct{}, 4) // 并发上限，避免短时间内大量请求
	var wg sync.WaitGroup
	for _, acc := range accs {
		if acc.RefreshToken == "" || (only != nil && !only[acc.ID]) {
			continue
		}
		wg.Add(1)
		go func(acc Account) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := a.refreshQuota(ctx, acc, st); err != nil {
				log.Printf("刷新 %s 的额度失败：%v", acc.Email, err)
			}
		}(acc)
	}
	wg.Wait()
	a.writeViews(w)
}

func (a *App) passwordChanged(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err == nil {
		err = a.store.SetPasswordChanged(id, today())
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	acc, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.view(acc, today()))
}

func (a *App) getSettings(w http.ResponseWriter, r *http.Request) {
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": st, "data_dir": a.dataDir, "default_chrome_user_data": defaultChromeUserData()})
}

var validTagHues = map[string]bool{
	"blue": true, "violet": true, "emerald": true, "amber": true,
	"rose": true, "cyan": true, "orange": true, "indigo": true,
}

func (a *App) putSettings(w http.ResponseWriter, r *http.Request) {
	var st Settings
	if err := readJSON(w, r, &st); err != nil {
		writeErr(w, err)
		return
	}
	prev, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	st.ChromePath = strings.Trim(strings.TrimSpace(st.ChromePath), `"`)
	st.ChromeUserData = strings.Trim(strings.TrimSpace(st.ChromeUserData), `"`)
	st.IDEPath = strings.Trim(strings.TrimSpace(st.IDEPath), `"`)
	st.ClassicPath = strings.Trim(strings.TrimSpace(st.ClassicPath), `"`)
	switch st.NextPool {
	case poolAny, poolGemini, poolClaude:
	case "":
		st.NextPool = poolAny
	default:
		writeErr(w, errors.New("「切下个」的额度池只能是 any / gemini / claude"))
		return
	}
	if st.NextThreshold < 0 || st.NextThreshold > 99 {
		writeErr(w, errors.New("「切下个」的额度门槛要在 0–99% 之间"))
		return
	}
	if st.DefaultProxy, err = normalizeProxy(st.DefaultProxy); err != nil {
		writeErr(w, err)
		return
	}
	if st.DefaultRiskDays < 0 {
		writeErr(w, errors.New("默认风控期天数不能是负数"))
		return
	}
	if st.TagColors == nil {
		st.TagColors = prev.TagColors
	}
	if err := a.store.SaveSettings(st); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (a *App) putTagColor(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Tag   string `json:"tag"`
		Color string `json:"color"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, err)
		return
	}
	key := strings.ToLower(strings.TrimSpace(req.Tag))
	if key == "" {
		writeErr(w, errors.New("标签名不能为空"))
		return
	}
	hue := strings.TrimSpace(req.Color)
	if hue != "" && !validTagHues[hue] {
		writeErr(w, errors.New("不支持的标签颜色"))
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	if st.TagColors == nil {
		st.TagColors = map[string]string{}
	}
	if hue == "" {
		delete(st.TagColors, key)
	} else {
		st.TagColors[key] = hue
	}
	if err := a.store.SaveSettings(st); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tag_colors": st.TagColors})
}
