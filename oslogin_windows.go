//go:build windows

package main

import (
	"errors"
	"fmt"
	"os/user"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procLogonUserW = windows.NewLazySystemDLL("advapi32.dll").NewProc("LogonUserW")

const (
	logon32LogonInteractive = 2
	logon32ProviderDefault  = 0
)

// verifyOSPassword 用当前 Windows 用户名和输入的密码做一次登录校验。
func verifyOSPassword(password string) error {
	u, err := user.Current()
	if err != nil {
		return err
	}
	domain, name := ".", u.Username
	if i := strings.IndexByte(u.Username, '\\'); i >= 0 {
		domain, name = u.Username[:i], u.Username[i+1:]
	}
	pName, _ := windows.UTF16PtrFromString(name)
	pDomain, _ := windows.UTF16PtrFromString(domain)
	pwd, err := windows.UTF16FromString(password)
	if err != nil {
		return ErrBadOSPassword
	}
	defer clear(pwd)

	var token windows.Token
	r, _, callErr := procLogonUserW.Call(
		uintptr(unsafe.Pointer(pName)), uintptr(unsafe.Pointer(pDomain)), uintptr(unsafe.Pointer(&pwd[0])),
		logon32LogonInteractive, logon32ProviderDefault, uintptr(unsafe.Pointer(&token)))
	if r == 0 {
		switch {
		case errors.Is(callErr, windows.ERROR_LOGON_FAILURE):
			return ErrBadOSPassword
		case errors.Is(callErr, windows.ERROR_ACCOUNT_RESTRICTION):
			return errors.New("这个 Windows 账户没有设置登录密码，无法用来验证；请先在 Windows 设置里给账户设置密码")
		}
		return fmt.Errorf("验证 Windows 密码失败：%w", callErr)
	}
	token.Close()
	return nil
}
