//go:build !windows

package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// chromeRunning 判断指定 user-data-dir 的 Chrome 是否仍在运行。
// 注意：macOS / Linux 绝不可像 Windows 那样 os.Remove 锁文件（POSIX unlink 会删掉运行中进程的软链）。
// 优先探测 Chrome 监听的 SingletonSocket，再回退校验 SingletonLock 软链里的 PID 与进程名，避免崩溃残留 PID 被其它进程复用造成误判。
func chromeRunning(userDataDir string) bool {
	sock := filepath.Join(userDataDir, "SingletonSocket")
	if c, err := net.DialTimeout("unix", sock, 200*time.Millisecond); err == nil {
		_ = c.Close()
		return true
	}

	target, err := os.Readlink(filepath.Join(userDataDir, "SingletonLock"))
	if err != nil {
		return false
	}
	idx := strings.LastIndexByte(target, '-')
	if idx < 0 || idx == len(target)-1 {
		return false
	}
	pid, err := strconv.Atoi(target[idx+1:])
	if err != nil || pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	if err != nil {
		return false
	}
	comm := strings.ToLower(strings.TrimSpace(string(out)))
	return strings.Contains(comm, "chrome") || strings.Contains(comm, "chromium")
}
