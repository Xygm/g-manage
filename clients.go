package main

// 切换本机 Antigravity 客户端（CLI / IDE / 经典款）当前登录的账号，以及「切下个」和三端当前账号的探测。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	poolAny    = "any"
	poolGemini = "gemini"
	poolClaude = "claude"
)

var (
	errSwitchBusy  = errors.New("正在切换账号，请等这次切完")
	errNoCandidate = errors.New("没有可切换的账号")
)

// 桌面客户端正常关闭的等待时间：IDE 可能弹「是否保存」，多等一会儿。
var closeTimeout = map[clientTarget]time.Duration{targetIDE: 20 * time.Second, targetClassic: 10 * time.Second}

type clientStatus struct {
	Target    clientTarget `json:"target"`
	Label     string       `json:"label"`
	Installed bool         `json:"installed"`
	Running   bool         `json:"running"`
	AccountID int64        `json:"account_id"` // 当前登录的是列表里的哪个号，0 = 不是 / 读不到
	Email     string       `json:"email"`      // 当前登录的邮箱（可能不在列表里）
	HasBackup bool         `json:"has_backup"` // 有本机原始设备指纹的备份，可恢复
}

type switchResult struct {
	Target  clientTarget `json:"target"`
	Email   string       `json:"email"`
	Warning string       `json:"warning,omitempty"` // 账号已切好，但有附带步骤没成功
}

func readKeyring() (refreshToken, email string) {
	raw, err := credRead(keyringTarget)
	if err != nil {
		return "", ""
	}
	refreshToken, email, _ = parseCredential(raw)
	return refreshToken, email
}

func matchAccount(accs []Account, refreshToken, email string) (Account, bool) {
	if refreshToken != "" {
		for _, acc := range accs {
			if acc.RefreshToken == refreshToken {
				return acc, true
			}
		}
	}
	if email != "" {
		for _, acc := range accs {
			if sameGoogleAccount(acc.Email, email) {
				return acc, true
			}
		}
	}
	return Account{}, false
}

// clientStatuses 探测三端的安装、运行状态和当前登录的账号。
// CLI 和经典款都读凭据管理器里的同一条凭据；IDE 以它自己的 state.vscdb 为准。
func (a *App) clientStatuses() ([]clientStatus, error) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		return nil, err
	}
	st, err := a.store.GetSettings()
	if err != nil {
		return nil, err
	}
	procs, err := listProcesses()
	if err != nil {
		log.Printf("读取进程列表失败：%v", err)
	}
	keyRT, keyEmail := readKeyring()
	gdir, _ := geminiDir()

	out := make([]clientStatus, 0, len(clientTargets))
	for _, t := range clientTargets {
		s := clientStatus{Target: t, Label: t.label()}
		var rt, email string
		if t == targetCLI {
			s.Installed, s.Running = cliInstalled(), cliRunning(procs)
			if s.Installed {
				rt, email = keyRT, keyEmail
				if rt == "" && email == "" {
					rt, email, _ = readCLIFileCredential(gdir)
				}
			}
		} else {
			d := locateDesktop(t, configuredExe(t, st), procs)
			s.Installed, s.Running = d.installed(), len(d.pids) > 0
			s.HasBackup = fileExists(a.fingerprintBackupPath(t))
			if s.Installed {
				var dbRT, dbEmail string
				if d.dataDir != "" && fileExists(d.statePath()) {
					dbRT, dbEmail, _ = readStateDB(d.statePath())
				}
				primaryRT, primaryEmail, fallbackRT, fallbackEmail := keyRT, keyEmail, dbRT, dbEmail
				if t == targetIDE {
					primaryRT, primaryEmail, fallbackRT, fallbackEmail = dbRT, dbEmail, keyRT, keyEmail
				}
				rt, email = primaryRT, primaryEmail
				if rt == "" && email == "" {
					rt, email = fallbackRT, fallbackEmail
				}
			}
		}
		if acc, ok := matchAccount(accs, rt, email); ok {
			s.AccountID, email = acc.ID, acc.Email
		}
		s.Email = email
		out = append(out, s)
	}
	return out, nil
}

func configuredExe(t clientTarget, st Settings) string {
	if t == targetIDE {
		return st.IDEPath
	}
	return st.ClassicPath
}

// freshCreds 用账号的 refresh token 换一份新的 access token，组成写给客户端的凭据。
func (a *App) freshCreds(ctx context.Context, acc Account, st Settings) (agyCreds, error) {
	g, err := newGoogleClient(proxyFor(acc, st))
	if err != nil {
		return agyCreds{}, err
	}
	tok, client, err := g.refreshAccess(ctx, acc.RefreshToken)
	if err != nil {
		return agyCreds{}, fmt.Errorf("刷新 %s 的登录凭证失败：%w", acc.Email, err)
	}
	if e := jwtEmail(tok.IDToken); e != "" && !sameGoogleAccount(e, acc.Email) {
		return agyCreds{}, fmt.Errorf("这个号保存的授权属于 %s，不是 %s，请重新授权", e, acc.Email)
	}
	c := agyCreds{
		Email:        acc.Email,
		AccessToken:  tok.AccessToken,
		RefreshToken: acc.RefreshToken,
		IDToken:      tok.IDToken,
		Expiry:       freshExpiry(tok.ExpiresIn),
		GCP:          client == 1,
	}
	if c.GCP {
		c.Project, _, _, _ = g.resolveCodeAssist(ctx, tok.AccessToken)
	}
	return c, nil
}

// deviceProfileFor 返回账号固定的设备指纹，第一次切号时生成并保存。
func (a *App) deviceProfileFor(acc Account) (deviceProfile, error) {
	var p deviceProfile
	if acc.DeviceProfile != "" && json.Unmarshal([]byte(acc.DeviceProfile), &p) == nil && p.MachineID != "" {
		return p, nil
	}
	p = newDeviceProfile()
	raw, _ := json.Marshal(p)
	return p, a.store.SetDeviceProfile(acc.ID, string(raw))
}

func (a *App) fingerprintBackupPath(t clientTarget) string {
	return filepath.Join(a.dataDir, "client-backup", string(t)+"-fingerprint.json")
}

// backupFingerprint 第一次改某个客户端的指纹前，把本机原始指纹存下来（之后不再覆盖）。
func (a *App) backupFingerprint(d desktopClient) error {
	path := a.fingerprintBackupPath(d.target)
	if fileExists(path) {
		return nil
	}
	p, err := readDeviceProfile(d.storagePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil // 新装的客户端还没生成指纹，没有可备份的
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(p, "", "  ")
	return os.WriteFile(path, raw, 0o600)
}

func (a *App) switchTo(ctx context.Context, acc Account, t clientTarget) (switchResult, error) {
	if !a.switchMu.TryLock() {
		return switchResult{}, errSwitchBusy
	}
	defer a.switchMu.Unlock()
	if acc.RefreshToken == "" {
		return switchResult{}, fmt.Errorf("%s 还没授权，先点「授权」", acc.Email)
	}
	st, err := a.store.GetSettings()
	if err != nil {
		return switchResult{}, err
	}
	creds, err := a.freshCreds(ctx, acc, st)
	if err != nil {
		return switchResult{}, err
	}
	gdir, err := geminiDir()
	if err != nil {
		return switchResult{}, err
	}
	res := switchResult{Target: t, Email: acc.Email}
	var warnings []string
	if t == targetCLI {
		if err := writeKeyringVerified(creds); err != nil {
			return switchResult{}, err
		}
		if err := writeFileCredentials(gdir, creds, true); err != nil {
			warnings = append(warnings, "凭据文件没写全："+err.Error())
		}
	} else {
		if warnings, err = a.switchDesktop(acc, t, st, creds, gdir); err != nil {
			return switchResult{}, err
		}
	}
	if err := a.store.SetSwitchedAt(acc.ID, time.Now().Unix()); err != nil {
		log.Printf("记录 %s 的切换时间失败：%v", acc.Email, err)
	}
	res.Warning = strings.Join(warnings, "；")
	log.Printf("已把 %s 切换为 %s", t.longName(), acc.Email)
	return res, nil
}

func writeKeyringVerified(c agyCreds) error {
	if err := credWrite(keyringTarget, keyringUser, credentialJSON(c)); err != nil {
		return err
	}
	raw, err := credRead(keyringTarget)
	if err != nil {
		return err
	}
	if rt, _, err := parseCredential(raw); err != nil || rt != c.RefreshToken {
		return errors.New("写入凭据管理器后读回的内容不一致，可能被其它程序改回去了")
	}
	return nil
}

// switchDesktop：关掉客户端 → 写设备指纹 → 写 state.vscdb、凭据管理器和凭据文件 → 重新启动。
func (a *App) switchDesktop(acc Account, t clientTarget, st Settings, c agyCreds, gdir string) (warnings []string, err error) {
	procs, err := listProcesses()
	if err != nil {
		return nil, fmt.Errorf("读取进程列表失败：%w", err)
	}
	d := locateDesktop(t, configuredExe(t, st), procs)
	if !d.installed() {
		return nil, fmt.Errorf("没找到 %s（没安装，或装在不常见的位置：可在设置里填程序路径）", t.longName())
	}
	if err := closeProcessTrees(d.pids, closeTimeout[t]); err != nil {
		return nil, fmt.Errorf("关闭 %s 失败：%w", t.longName(), err)
	}

	if d.dataDir != "" {
		profile, err := a.deviceProfileFor(acc)
		if err != nil {
			return nil, err
		}
		if err := a.backupFingerprint(d); err != nil {
			return nil, fmt.Errorf("备份本机原始设备指纹失败：%w", err)
		}
		if err := applyDeviceProfile(d, profile); err != nil {
			return nil, fmt.Errorf("写入设备指纹失败：%w", err)
		}
	}

	dbDone := false
	if d.dataDir != "" && fileExists(d.statePath()) {
		if err := injectStateDB(d.statePath(), c); err != nil {
			return nil, fmt.Errorf("写入 %s 的登录状态失败：%w", t.longName(), err)
		}
		dbDone = true
	}
	if err := writeKeyringVerified(c); err != nil {
		if !dbDone {
			return nil, err
		}
		warnings = append(warnings, err.Error())
	}
	if err := writeFileCredentials(gdir, c, false); err != nil {
		warnings = append(warnings, "凭据文件没写全："+err.Error())
	}

	if d.exe == "" {
		warnings = append(warnings, fmt.Sprintf("账号已写好，但没找到 %s 的程序，请手动打开（或在设置里填程序路径）", t.longName()))
	} else if err := startProgram(d.exe); err != nil {
		warnings = append(warnings, fmt.Sprintf("账号已写好，但启动 %s 失败：%v", t.longName(), err))
	}
	return warnings, nil
}

/* ---------- 切下个 ---------- */

func poolOf(groupName string) string {
	n := strings.ToLower(groupName)
	switch {
	case strings.Contains(n, "claude") || strings.Contains(n, "gpt"):
		return poolClaude
	case strings.Contains(n, "gemini"):
		return poolGemini
	}
	return ""
}

// poolRemaining 返回某个池所有窗口（5 小时、周）里最少的剩余比例；pool = any 时取两个池里更少的那个。
// 没有该池的数据返回 -1。
func poolRemaining(q QuotaInfo, pool string) float64 {
	rem := map[string]float64{}
	for _, g := range q.Groups {
		p := poolOf(g.DisplayName)
		if p == "" {
			continue
		}
		for _, b := range g.Buckets {
			if cur, ok := rem[p]; !ok || b.RemainingFraction < cur {
				rem[p] = b.RemainingFraction
			}
		}
	}
	if pool != poolAny {
		if v, ok := rem[pool]; ok {
			return v
		}
		return -1
	}
	if len(rem) == 0 {
		return -1
	}
	least := 1.0
	for _, v := range rem {
		least = min(least, v)
	}
	return least
}

var tierRank = map[string]int{"ULTRA": 3, "PRO": 2, "ENTERPRISE": 1}

// nextScore 判断账号能不能作为「切下个」的目标，能的话返回目标池的剩余比例。
func nextScore(acc Account, st Settings, now string, currentID int64) (float64, string, bool) {
	if acc.ID == currentID || acc.ServiceDisabled || acc.RefreshToken == "" || acc.QuotaError != "" || acc.QuotaJSON == "" {
		return 0, "", false
	}
	if status, _ := accountStatus(acc, now); status == statusRisk {
		return 0, "", false
	}
	var q QuotaInfo
	if json.Unmarshal([]byte(acc.QuotaJSON), &q) != nil {
		return 0, "", false
	}
	rem := poolRemaining(q, st.NextPool)
	if rem < 0 || rem*100 < float64(st.NextThreshold) {
		return 0, "", false
	}
	return rem, q.Tier, true
}

// nextCandidates 按「付费等级 > 目标池剩余额度 > 最久没被切过」排序。
func nextCandidates(accs []Account, st Settings, now string, currentID int64) []Account {
	type cand struct {
		acc   Account
		score float64
		tier  int
	}
	var cs []cand
	for _, acc := range accs {
		if score, tier, ok := nextScore(acc, st, now, currentID); ok {
			cs = append(cs, cand{acc, score, tierRank[tier]})
		}
	}
	sort.SliceStable(cs, func(i, j int) bool {
		x, y := cs[i], cs[j]
		if x.tier != y.tier {
			return x.tier > y.tier
		}
		if x.score != y.score {
			return x.score > y.score
		}
		if x.acc.SwitchedAt != y.acc.SwitchedAt {
			return x.acc.SwitchedAt < y.acc.SwitchedAt
		}
		return x.acc.ID < y.acc.ID
	})
	out := make([]Account, len(cs))
	for i, c := range cs {
		out[i] = c.acc
	}
	return out
}

// switchNext 挑下一个号并切换；挑中的号先实时查一次额度，不达标就换下一个候选（最多试 3 个）。
func (a *App) switchNext(ctx context.Context, t clientTarget) (switchResult, error) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		return switchResult{}, err
	}
	st, err := a.store.GetSettings()
	if err != nil {
		return switchResult{}, err
	}
	statuses, err := a.clientStatuses()
	if err != nil {
		return switchResult{}, err
	}
	var currentID int64
	for _, s := range statuses {
		if s.Target == t {
			currentID = s.AccountID
		}
	}
	now := today()
	cands := nextCandidates(accs, st, now, currentID)
	for i, acc := range cands {
		if i == 3 {
			break
		}
		if err := a.refreshQuota(ctx, acc, st); err != nil {
			log.Printf("切下个：%s 额度查询失败，跳过：%v", acc.Email, err)
			continue
		}
		fresh, err := a.store.GetAccount(acc.ID)
		if err != nil {
			return switchResult{}, err
		}
		if _, _, ok := nextScore(fresh, st, now, currentID); ok {
			return a.switchTo(ctx, fresh, t)
		}
	}
	return switchResult{}, fmt.Errorf("%w：需要已授权、不在风控期、%s剩余额度不低于 %d%%",
		errNoCandidate, map[string]string{poolAny: "Gemini 和 Claude 两个池", poolGemini: "Gemini 池", poolClaude: "Claude / GPT 池"}[st.NextPool], st.NextThreshold)
}

/* ---------- 接口 ---------- */

func (a *App) listClients(w http.ResponseWriter, r *http.Request) {
	statuses, err := a.clientStatuses()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, statuses)
}

func (a *App) switchAccount(w http.ResponseWriter, r *http.Request) {
	t, err := parseTarget(r.URL.Query().Get("target"))
	if err != nil {
		writeErr(w, err)
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
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	res, err := a.switchTo(ctx, acc, t)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *App) switchNextAccount(w http.ResponseWriter, r *http.Request) {
	t, err := parseTarget(r.PathValue("target"))
	if err != nil {
		writeErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	res, err := a.switchNext(ctx, t)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// restoreFingerprint 把客户端的设备指纹恢复成第一次切号前的本机原始值（登录的账号不变），并重启客户端。
func (a *App) restoreFingerprint(w http.ResponseWriter, r *http.Request) {
	t, err := parseTarget(r.PathValue("target"))
	if err != nil || t == targetCLI {
		writeErr(w, errors.New("只有 IDE 和经典款有设备指纹"))
		return
	}
	raw, err := os.ReadFile(a.fingerprintBackupPath(t))
	if err != nil {
		writeErr(w, errors.New("没有本机原始指纹的备份（还没切过号）"))
		return
	}
	var p deviceProfile
	if err := json.Unmarshal(raw, &p); err != nil {
		writeErr(w, err)
		return
	}
	if !a.switchMu.TryLock() {
		writeErr(w, errSwitchBusy)
		return
	}
	defer a.switchMu.Unlock()
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	procs, err := listProcesses()
	if err != nil {
		writeErr(w, err)
		return
	}
	d := locateDesktop(t, configuredExe(t, st), procs)
	if d.dataDir == "" {
		writeErr(w, fmt.Errorf("没找到 %s 的数据目录", t.longName()))
		return
	}
	wasRunning := len(d.pids) > 0
	if err := closeProcessTrees(d.pids, closeTimeout[t]); err != nil {
		writeErr(w, fmt.Errorf("关闭 %s 失败：%w", t.longName(), err))
		return
	}
	if err := applyDeviceProfile(d, p); err != nil {
		writeErr(w, err)
		return
	}
	var warning string
	if wasRunning && d.exe != "" {
		if err := startProgram(d.exe); err != nil {
			warning = "指纹已恢复，但重新启动失败：" + err.Error()
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"warning": warning})
}

func (a *App) getUIPrefs(w http.ResponseWriter, r *http.Request) {
	p, err := a.store.GetUIPrefs()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *App) putUIPrefs(w http.ResponseWriter, r *http.Request) {
	var p UIPrefs
	if err := readJSON(w, r, &p); err != nil {
		writeErr(w, err)
		return
	}
	if err := a.store.SaveUIPrefs(p); err != nil {
		writeErr(w, err)
		return
	}
	uiApplyPrefs()
	writeJSON(w, http.StatusOK, p)
}

// showMainWindow 供重复启动的第二个实例调用：把已在运行的实例的主控制台调出来。
func (a *App) showMainWindow(w http.ResponseWriter, r *http.Request) {
	uiShowMain()
	w.WriteHeader(http.StatusNoContent)
}
