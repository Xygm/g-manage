//go:build !windows && !darwin

package main

import (
	"os"
	"time"
)

// fileCreated：非 Windows 没有可移植的创建时间，用修改时间近似（仅开发调试用）。
func fileCreated(path string) (time.Time, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	return fi.ModTime(), true
}
