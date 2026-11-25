//go:build windows

package main

// 把账号密码写进程序自带浏览器（独立 Chrome 资料）的密码库，打开 Google 登录页时可以直接从下拉里选。
//
// Chrome 新写入的密码用 App-Bound 加密（v20，外部程序无法生成），但仍能读取旧格式 v10：
// AES-256-GCM，密钥在 Local State 的 os_crypt.encrypted_key 里、由当前 Windows 用户的 DPAPI 保护。
// 只能在这个资料的 Chrome 没运行时写，运行中的 Chrome 独占着数据库。

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	googleSignonRealm = "https://accounts.google.com/"
	chromeV10Prefix   = "v10"
	// PasswordForm::Type::kImported，和 Chrome「导入密码」写入的条目一样。
	passwordTypeImported = 4
)

var errChromeRunning = errors.New("这个账号的浏览器正开着，下次关掉后再打开时会自动写入")

// syncChromePassword 确保独立浏览器资料里存着这个账号的 Google 密码；已经一致时不动。
func syncChromePassword(chrome, userDataDir, proxy, email, password string) error {
	if err := ensureChromeProfile(chrome, userDataDir, proxy); err != nil {
		return err
	}
	if chromeRunning(userDataDir) {
		return errChromeRunning
	}
	key, err := chromeOSCryptKey(userDataDir)
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(userDataDir, "Default", "Login Data")+"?_pragma=busy_timeout(0)")
	if err != nil {
		return err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT id, password_value FROM logins WHERE signon_realm = ? AND username_value = ?`, googleSignonRealm, email)
	if err != nil {
		return fmt.Errorf("读取浏览器密码库失败：%w", err)
	}
	var stale []int64
	found := false
	for rows.Next() {
		var id int64
		var blob []byte
		if err := rows.Scan(&id, &blob); err != nil {
			rows.Close()
			return err
		}
		found = true
		if plain, ok := decryptV10(key, blob); !ok || plain != password {
			stale = append(stale, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if found && len(stale) == 0 {
		return nil // 已是最新
	}

	blob, err := encryptV10(key, password)
	if err != nil {
		return err
	}
	now := chromeTime(time.Now())
	if !found {
		_, err = db.Exec(`INSERT INTO logins (origin_url, action_url, username_element, username_value, password_element, password_value,
			submit_element, signon_realm, date_created, blacklisted_by_user, scheme, password_type, times_used, date_password_modified)
			VALUES (?, '', '', ?, '', ?, '', ?, ?, 0, 0, ?, 0, ?)`,
			googleSignonRealm, email, blob, googleSignonRealm, now, passwordTypeImported, now)
	} else {
		for _, id := range stale {
			if _, err = db.Exec(`UPDATE logins SET password_value = ?, date_password_modified = ? WHERE id = ?`, blob, now, id); err != nil {
				break
			}
		}
	}
	if err != nil {
		return fmt.Errorf("写入浏览器密码库失败：%w", err)
	}
	return nil
}

// chromeRunning：运行中的 Chrome 独占 user-data-dir\lockfile，删不掉就说明在运行（残留的锁文件删掉无害）。
func chromeRunning(userDataDir string) bool {
	err := os.Remove(filepath.Join(userDataDir, "lockfile"))
	return err != nil && !errors.Is(err, os.ErrNotExist)
}

// ensureChromeProfile：资料还没被 Chrome 初始化过（没有密钥和密码库）时，用无界面模式启动一次让它生成。
// 带上账号的代理，避免初始化时 Chrome 的后台请求从本机 IP 发出。
func ensureChromeProfile(chrome, userDataDir, proxy string) error {
	ready := func() bool {
		if _, err := os.Stat(filepath.Join(userDataDir, "Default", "Login Data")); err != nil {
			return false
		}
		_, err := chromeOSCryptKey(userDataDir)
		return err == nil
	}
	if ready() {
		return nil
	}
	if err := os.MkdirAll(userDataDir, 0o755); err != nil {
		return err
	}
	args := []string{"--headless=new", "--user-data-dir=" + userDataDir, "--no-first-run", "--no-default-browser-check"}
	if proxy != "" {
		args = append(args, "--proxy-server="+proxy)
	}
	cmd := exec.Command(chrome, append(args, "about:blank")...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("初始化浏览器资料失败：%w", err)
	}
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
		// 等子进程随主进程退出、释放锁文件，避免紧接着的正常启动连到这个无界面实例。
		for deadline := time.Now().Add(5 * time.Second); chromeRunning(userDataDir) && time.Now().Before(deadline); {
			time.Sleep(200 * time.Millisecond)
		}
	}()
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if ready() {
			return nil
		}
	}
	return errors.New("初始化浏览器资料超时")
}

func chromeOSCryptKey(userDataDir string) ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(userDataDir, "Local State"))
	if err != nil {
		return nil, err
	}
	var ls struct {
		OSCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := json.Unmarshal(raw, &ls); err != nil {
		return nil, err
	}
	enc, err := base64.StdEncoding.DecodeString(ls.OSCrypt.EncryptedKey)
	if err != nil || !bytes.HasPrefix(enc, []byte("DPAPI")) {
		return nil, errors.New("浏览器资料里没有可用的加密密钥")
	}
	enc = enc[len("DPAPI"):]
	in := windows.DataBlob{Size: uint32(len(enc)), Data: unsafe.SliceData(enc)}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, fmt.Errorf("解开浏览器密钥失败：%w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	key := append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
	if len(key) != 32 {
		return nil, errors.New("浏览器密钥长度不对")
	}
	return key, nil
}

func encryptV10(key []byte, plain string) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte(chromeV10Prefix), nonce...)
	return gcm.Seal(out, nonce, []byte(plain), nil), nil
}

func decryptV10(key, blob []byte) (string, bool) {
	gcm, err := newGCM(key)
	if err != nil || !bytes.HasPrefix(blob, []byte(chromeV10Prefix)) {
		return "", false
	}
	blob = blob[len(chromeV10Prefix):]
	if len(blob) < gcm.NonceSize() {
		return "", false
	}
	plain, err := gcm.Open(nil, blob[:gcm.NonceSize()], blob[gcm.NonceSize():], nil)
	return string(plain), err == nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// chromeTime：Chrome 的时间戳是从 1601-01-01 起的微秒数。
func chromeTime(t time.Time) int64 {
	return t.UnixMicro() + 11644473600*1_000_000
}
