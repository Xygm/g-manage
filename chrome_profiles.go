package main

// 读取用户日常 Chrome 里已登录的个人资料（不需要登录、不读 Cookie 或密码）：
// Chrome 把每个个人资料的邮箱、名称记在用户数据目录的 "Local State" 文件里。

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

const avatarFile = "Google Profile Picture.png"

// errChromePermission 表示 macOS TCC 等系统隐私机制拒绝读取 Chrome 资料目录。
var errChromePermission = errors.New("没有读取 Chrome 资料目录的权限")

type ChromeProfile struct {
	Dir       string `json:"dir"`        // 文件夹名，如 "Profile 11"
	Email     string `json:"email"`      // 登录的 Google 账号，没登录为空
	Name      string `json:"name"`       // Chrome 里给这个资料起的名字
	GaiaName  string `json:"gaia_name"`  // Google 账号上的姓名
	Created   string `json:"created"`    // 资料文件夹创建日期，可当作首次登录日期
	HasAvatar bool   `json:"has_avatar"` // 是否有 Google 头像
	AccountID int64  `json:"account_id"` // 已在列表中时对应的账号 ID，0 = 未导入
}

func defaultChromeUserData() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "User Data")
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	default:
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", "google-chrome")
	}
}

func chromeUserData(st Settings) string {
	if st.ChromeUserData != "" {
		return st.ChromeUserData
	}
	return defaultChromeUserData()
}

// readChromeProfiles 列出用户数据目录里的个人资料，按文件夹创建时间排序。
func readChromeProfiles(userData string) ([]ChromeProfile, error) {
	raw, err := os.ReadFile(filepath.Join(userData, "Local State"))
	if err != nil {
		if runtime.GOOS == "darwin" && errors.Is(err, os.ErrPermission) {
			return nil, fmt.Errorf("%w（%s）：macOS 拦截了对 Chrome 资料目录的读取，请授予「完全磁盘访问权限」后重启程序再试", errChromePermission, userData)
		}
		return nil, fmt.Errorf("读取 Chrome 资料列表失败（%s）：%w", userData, err)
	}
	var ls struct {
		Profile struct {
			InfoCache map[string]struct {
				Name     string `json:"name"`
				UserName string `json:"user_name"`
				GaiaName string `json:"gaia_name"`
			} `json:"info_cache"`
		} `json:"profile"`
	}
	if err := json.Unmarshal(raw, &ls); err != nil {
		return nil, fmt.Errorf("解析 Chrome 的 Local State 失败：%w", err)
	}
	out := make([]ChromeProfile, 0, len(ls.Profile.InfoCache))
	for dir, info := range ls.Profile.InfoCache {
		p := ChromeProfile{Dir: dir, Email: strings.ToLower(info.UserName), Name: info.Name, GaiaName: info.GaiaName}
		if t, ok := fileCreated(filepath.Join(userData, dir)); ok {
			p.Created = t.Format(dateLayout)
		}
		if _, err := os.Stat(filepath.Join(userData, dir, avatarFile)); err == nil {
			p.HasAvatar = true
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Created != out[j].Created {
			return out[i].Created < out[j].Created
		}
		return out[i].Dir < out[j].Dir
	})
	return out, nil
}

func (a *App) chromeProfiles(w http.ResponseWriter, r *http.Request) {
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	userData := chromeUserData(st)
	profiles, err := readChromeProfiles(userData)
	if err != nil {
		writeErr(w, err)
		return
	}
	accs, err := a.store.ListAccounts()
	if err != nil {
		writeErr(w, err)
		return
	}
	byEmail := make(map[string]Account, len(accs))
	for _, acc := range accs {
		byEmail[acc.Email] = acc
	}
	for i := range profiles {
		if acc, ok := byEmail[profiles[i].Email]; ok && profiles[i].Email != "" {
			profiles[i].AccountID = acc.ID
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"user_data": userData, "profiles": profiles})
}

// importChromeProfiles 把选中的个人资料导入为账号（用程序自带的独立浏览器打开），并把头像拷到 data 目录；
// 邮箱已存在的跳过。
func (a *App) importChromeProfiles(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dirs []string `json:"dirs"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, err)
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	userData := chromeUserData(st)
	profiles, err := readChromeProfiles(userData)
	if err != nil {
		writeErr(w, err)
		return
	}
	byDir := make(map[string]ChromeProfile, len(profiles))
	for _, p := range profiles {
		byDir[p.Dir] = p
	}

	added, existed := 0, 0
	for _, dir := range req.Dirs {
		p, ok := byDir[dir]
		if !ok || p.Email == "" {
			continue // 不存在或没登录 Google 的资料
		}
		if _, err := a.store.FindByEmail(p.Email); err == nil {
			existed++
			continue
		} else if !errors.Is(err, ErrNotFound) {
			writeErr(w, err)
			return
		}
		acc := Account{Email: p.Email, Note: p.Name, LoginDate: p.Created, RiskDays: st.DefaultRiskDays}
		if acc.LoginDate == "" || acc.LoginDate > today() {
			acc.LoginDate = today()
		}
		if err := acc.normalize(); err != nil {
			writeErr(w, fmt.Errorf("%s：%w", p.Email, err))
			return
		}
		if err := a.store.CreateAccount(&acc); err != nil {
			writeErr(w, fmt.Errorf("%s：%w", p.Email, err))
			return
		}
		a.keepAvatar(acc.Email, filepath.Join(userData, p.Dir, avatarFile))
		added++
	}
	writeJSON(w, http.StatusOK, map[string]int{"added": added, "existed": existed})
}

// detachChromeProfiles 把还关联着日常 Chrome 个人资料的账号全部改为用程序自带的独立浏览器打开，
// 之后就可以删掉日常 Chrome 里的这些资料。头像先拷到 data 目录保留。
func (a *App) detachChromeProfiles(w http.ResponseWriter, r *http.Request) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		writeErr(w, err)
		return
	}
	n := 0
	for _, acc := range accs {
		if acc.ChromeProfile == "" {
			continue
		}
		a.keepAvatar(acc.Email, filepath.Join(acc.ProfileDir, acc.ChromeProfile, avatarFile))
		if err := a.store.SetBrowserProfile(acc.ID, "", ""); err != nil {
			writeErr(w, err)
			return
		}
		n++
	}
	writeJSON(w, http.StatusOK, map[string]int{"converted": n})
}

// detachAccountChrome 把单个仍关联日常 Chrome 资料的账号改为程序自带的独立浏览器，不影响其它账号。
func (a *App) detachAccountChrome(w http.ResponseWriter, r *http.Request) {
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
	if acc.ChromeProfile != "" {
		a.keepAvatar(acc.Email, filepath.Join(acc.ProfileDir, acc.ChromeProfile, avatarFile))
	}
	if err := a.store.SetBrowserProfile(acc.ID, "", ""); err != nil {
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

func (a *App) savedAvatarPath(email string) string {
	return filepath.Join(a.dataDir, "avatars", profileDirName(email)+".png")
}

// keepAvatar 把头像拷进 data/avatars；源文件不存在时什么也不做。
func (a *App) keepAvatar(email, src string) {
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	dst := a.savedAvatarPath(email)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err == nil {
		err = os.WriteFile(dst, data, 0o644)
	}
	if err != nil {
		log.Printf("保存 %s 的头像失败：%v", email, err)
	}
}

func serveAvatar(w http.ResponseWriter, r *http.Request, path string) {
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, path)
}

// chromeProfileAvatar 只接受 Local State 里登记过的文件夹名，防止路径穿越。
func (a *App) chromeProfileAvatar(w http.ResponseWriter, r *http.Request) {
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	userData := chromeUserData(st)
	profiles, err := readChromeProfiles(userData)
	if err != nil {
		writeErr(w, err)
		return
	}
	dir := r.PathValue("dir")
	for _, p := range profiles {
		if p.Dir == dir {
			serveAvatar(w, r, filepath.Join(userData, dir, avatarFile))
			return
		}
	}
	http.NotFound(w, r)
}

// avatarPath：优先用保存到 data/avatars 的头像，否则用浏览器资料里的 Google 头像（独立浏览器用 Default 资料）。
func (a *App) avatarPath(acc Account) string {
	if p := a.savedAvatarPath(acc.Email); fileExists(p) {
		return p
	}
	profile := acc.ChromeProfile
	if profile == "" {
		profile = "Default"
	}
	return filepath.Join(a.profilePath(acc), profile, avatarFile)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (a *App) accountAvatar(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	acc, err := a.store.GetAccount(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveAvatar(w, r, a.avatarPath(acc))
}

func currentAppBundlePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	for p := exe; p != "/" && p != "."; p = filepath.Dir(p) {
		if strings.HasSuffix(p, ".app") {
			return p
		}
	}
	return exe
}

// openFullDiskAccess 在 macOS 上直接打开「系统设置 → 隐私与安全性 → 完全磁盘访问权限」。
func (a *App) openFullDiskAccess(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "darwin" {
		writeErr(w, errors.New("仅 macOS 支持此操作"))
		return
	}
	cmd := exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
	if err := cmd.Start(); err != nil {
		writeErr(w, fmt.Errorf("打开系统设置失败：%w", err))
		return
	}
	go cmd.Wait()
	w.WriteHeader(http.StatusNoContent)
}

// revealApp 在 macOS 访达中定位当前 .app，方便拖进「完全磁盘访问权限」列表。
func (a *App) revealApp(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "darwin" {
		writeErr(w, errors.New("仅 macOS 支持此操作"))
		return
	}
	p := currentAppBundlePath()
	if p == "" {
		writeErr(w, errors.New("未能定位当前程序路径"))
		return
	}
	cmd := exec.Command("open", "-R", p)
	if err := cmd.Start(); err != nil {
		writeErr(w, fmt.Errorf("打开访达失败：%w", err))
		return
	}
	go cmd.Wait()
	w.WriteHeader(http.StatusNoContent)
}
