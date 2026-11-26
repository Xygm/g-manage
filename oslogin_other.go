//go:build !windows && !darwin

package main

import "errors"

// 非 Windows 只用于开发调试，没有系统密码校验。
func verifyOSPassword(string) error {
	return errors.New("查看密码需要在 Windows 上运行")
}
