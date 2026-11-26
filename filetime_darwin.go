//go:build darwin

package main

import (
	"os"
	"syscall"
	"time"
)

// fileCreated 返回文件（夹）的创建时间（APFS / HFS+ 的 birthtime）。
func fileCreated(path string) (time.Time, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Birthtimespec.Sec == 0 {
		return fi.ModTime(), true
	}
	return time.Unix(st.Birthtimespec.Unix()), true
}
