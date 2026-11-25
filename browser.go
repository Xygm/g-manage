package main

import (
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// 点击按钮后在该账号的浏览器里打开的页面。
var openTargets = map[string]string{
	"browser":  "https://myaccount.google.com/",
	"mail":     "https://mail.google.com/mail/u/0/",
	"password": "https://myaccount.google.com/signinoptions/password",
}

// allowGoogleURL 校验要在账号独立浏览器里打开的 Google 官方链接（如账号安全验证页）。
func allowGoogleURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "-") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if host != "google.com" && !strings.HasSuffix(host, ".google.com") {
		return "", false
	}
	return u.String(), true
}

func findChrome(configured string) (string, error) {
	if configured != "" {
		if _, err := os.Stat(configured); err != nil {
			return "", errors.New("设置里的 Chrome 路径不存在：" + configured)
		}
		return configured, nil
	}
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			if base := os.Getenv(env); base != "" {
				candidates = append(candidates, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
	case "darwin":
		candidates = append(candidates, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
			if p, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, p)
			}
		}
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", errors.New("没找到 Chrome，请在设置里填写 chrome.exe 的完整路径")
}

// profileDirName 把邮箱变成可用作文件夹名的字符串。
func profileDirName(email string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_', r == '@':
			return r
		}
		return '_'
	}, email)
}

// launchChrome 在指定资料目录里打开 url。
// chromeProfile 非空表示用户日常 Chrome 里的某个个人资料（如 "Profile 11"）：这些资料共用一个
// 浏览器进程，此时不传代理参数，否则会让整个 Chrome 的所有资料都改走这个代理。
func launchChrome(chrome, userDataDir, chromeProfile, proxy, url string) error {
	if err := os.MkdirAll(userDataDir, 0o755); err != nil {
		return err
	}
	args := []string{"--user-data-dir=" + userDataDir}
	if chromeProfile != "" {
		args = append(args, "--profile-directory="+chromeProfile)
	} else {
		args = append(args, "--no-first-run", "--no-default-browser-check")
		if proxy != "" {
			args = append(args, "--proxy-server="+proxy)
		}
	}
	args = append(args, url)
	cmd := exec.Command(chrome, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait() // 回收子进程
	return nil
}
