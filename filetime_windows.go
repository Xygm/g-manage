//go:build windows

package main

import (
	"os"
	"syscall"
	"time"
)

// fileCreated 返回文件（夹）的创建时间。
func fileCreated(path string) (time.Time, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	d, ok := fi.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return fi.ModTime(), true
	}
	return time.Unix(0, d.CreationTime.Nanoseconds()), true
}
