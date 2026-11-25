package main

// 查看账号密码前要先输入 Windows 登录密码；验证通过后 5 分钟内可查看。
// 2FA 验证码不需要验证，直接显示。

import (
	"errors"
	"fmt"
	"net/http"
	"os/user"
	"strconv"
	"strings"
	"time"
)

const (
	vaultUnlockFor   = 5 * time.Minute
	vaultMaxFailures = 5
	vaultBlockFor    = 5 * time.Minute
)

var (
	ErrVaultLocked   = errors.New("需要先验证电脑密码")
	ErrBadOSPassword = errors.New("电脑密码不对")
	errTooManyTries  = errors.New("密码错误次数太多")
)

type vaultState struct {
	unlockedUntil time.Time
	failures      int
	blockedUntil  time.Time
}

func (a *App) vaultUnlocked(now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return now.Before(a.vault.unlockedUntil)
}

func osUserName() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	if i := strings.LastIndexByte(u.Username, '\\'); i >= 0 {
		return u.Username[i+1:]
	}
	return u.Username
}

func (a *App) vaultStatus(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	until := a.vault.unlockedUntil
	a.mu.Unlock()
	var ts int64
	if time.Now().Before(until) {
		ts = until.Unix()
	}
	writeJSON(w, http.StatusOK, map[string]any{"unlocked_until": ts, "user": osUserName()})
}

func (a *App) vaultUnlock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, err)
		return
	}
	now := time.Now()
	a.mu.Lock()
	blocked := a.vault.blockedUntil
	a.mu.Unlock()
	if now.Before(blocked) {
		writeErr(w, fmt.Errorf("%w，请 %d 分钟后再试", errTooManyTries, int(blocked.Sub(now).Minutes())+1))
		return
	}
	if req.Password == "" {
		writeErr(w, ErrBadOSPassword)
		return
	}

	err := verifyOSPassword(req.Password)
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case err == nil:
		a.vault.failures = 0
		a.vault.unlockedUntil = now.Add(vaultUnlockFor)
		writeJSON(w, http.StatusOK, map[string]int64{"unlocked_until": a.vault.unlockedUntil.Unix()})
	case errors.Is(err, ErrBadOSPassword):
		a.vault.failures++
		if a.vault.failures >= vaultMaxFailures {
			a.vault.failures = 0
			a.vault.blockedUntil = now.Add(vaultBlockFor)
			writeErr(w, fmt.Errorf("%w，请 %d 分钟后再试", errTooManyTries, int(vaultBlockFor.Minutes())))
			return
		}
		writeErr(w, fmt.Errorf("%w，还可以再试 %d 次", ErrBadOSPassword, vaultMaxFailures-a.vault.failures))
	default:
		writeErr(w, err)
	}
}

func (a *App) vaultLock(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.vault.unlockedUntil = time.Time{}
	a.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) revealPassword(w http.ResponseWriter, r *http.Request) {
	if !a.vaultUnlocked(time.Now()) {
		writeErr(w, ErrVaultLocked)
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
	if acc.Password == "" {
		writeErr(w, errors.New("这个账号没有保存密码"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"password": acc.Password, "previous_password": acc.PreviousPassword})
}

// totpCodes 返回所有存了 2FA 密钥的账号当前的验证码；密钥本身不出后端。
func (a *App) totpCodes(w http.ResponseWriter, r *http.Request) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		writeErr(w, err)
		return
	}
	now := time.Now()
	codes := map[string]string{}
	errs := map[string]string{}
	for _, acc := range accs {
		if acc.TotpSecret == "" {
			continue
		}
		key := strconv.FormatInt(acc.ID, 10)
		code, err := totpCode(acc.TotpSecret, now)
		if err == nil {
			codes[key] = code
		}
		if err != nil {
			errs[key] = err.Error()
		}
	}
	periodEnd := (now.Unix()/totpPeriod + 1) * totpPeriod
	writeJSON(w, http.StatusOK, map[string]any{"codes": codes, "errors": errs, "period_end": periodEnd, "period": totpPeriod})
}
