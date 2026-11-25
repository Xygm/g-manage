//go:build !windows

package main

import "errors"

// 非 Windows 只用于开发调试，不支持写浏览器密码库。
func syncChromePassword(chrome, userDataDir, proxy, email, password string) error {
	return errors.New("写入浏览器密码库只支持 Windows")
}
