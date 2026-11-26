//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"
)

// verifyOSPassword 用 dscl 校验当前 macOS 用户的登录密码（dscl 只能从参数接收密码）。
func verifyOSPassword(password string) error {
	name := osUserName()
	if name == "" {
		return errors.New("取不到当前 macOS 用户名")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/dscl", ".", "-authonly", name, password).CombinedOutput()
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return errors.New("验证电脑密码超时，请重试")
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		log.Printf("dscl 验证失败：%s", strings.TrimSpace(string(out)))
		return ErrBadOSPassword
	}
	return fmt.Errorf("验证电脑密码失败：%w", err)
}
