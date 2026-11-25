package main

// 半自动改密：生成新密码并先存为「待确认」，用户在浏览器里改完后点「改好了」才替换；
// 旧密码保留在 previous_password，误点确认也能找回。

import (
	"crypto/rand"
	"errors"
	"math/big"
	"net/http"
	"time"
)

const newPasswordLength = 16

var passwordClasses = []string{
	"ABCDEFGHJKLMNPQRSTUVWXYZ", // 去掉易混的 I、O
	"abcdefghijkmnpqrstuvwxyz", // 去掉易混的 l、o
	"23456789",                 // 去掉易混的 0、1
	"!@#$%^&*-_=+?",
}

func randIndex(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err) // 系统随机数不可用，无法安全生成密码
	}
	return int(v.Int64())
}

// generatePassword 生成 newPasswordLength 位密码，每类字符至少一个。
func generatePassword() string {
	all := ""
	for _, c := range passwordClasses {
		all += c
	}
	pw := make([]byte, 0, newPasswordLength)
	for _, c := range passwordClasses {
		pw = append(pw, c[randIndex(len(c))])
	}
	for len(pw) < newPasswordLength {
		pw = append(pw, all[randIndex(len(all))])
	}
	for i := len(pw) - 1; i > 0; i-- {
		j := randIndex(i + 1)
		pw[i], pw[j] = pw[j], pw[i]
	}
	return string(pw)
}

// startPasswordChange 返回当前密码和待确认的新密码；已有待确认的新密码时沿用，regenerate 时换一个。
func (a *App) startPasswordChange(w http.ResponseWriter, r *http.Request) {
	if !a.vaultUnlocked(time.Now()) {
		writeErr(w, ErrVaultLocked)
		return
	}
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var req struct {
		Regenerate bool `json:"regenerate"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, err)
		return
	}
	acc, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	if acc.PendingPassword == "" || req.Regenerate {
		acc.PendingPassword = generatePassword()
		if err := a.store.SetPendingPassword(id, acc.PendingPassword); err != nil {
			writeErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"current_password": acc.Password, "new_password": acc.PendingPassword})
}

func (a *App) confirmPasswordChange(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err == nil {
		err = a.store.ConfirmPasswordChange(id, today())
	}
	if err == nil {
		a.syncPasswordLater(id)
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

func (a *App) cancelPasswordChange(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err == nil {
		err = a.store.SetPendingPassword(id, "")
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var errNoPendingPassword = errors.New("没有待确认的新密码，请重新开始改密")
