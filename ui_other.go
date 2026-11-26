//go:build !windows && !darwin

package main

import (
	"fmt"
	"log"
	"os"
)

// 非 Windows 只用于开发调试：不开窗口，用浏览器访问页面（小窗是 /mini.html）。
func runUI(pageURL, dataDir string, _ func() UIPrefs) {
	log.Printf("开发模式：用浏览器打开 %s", pageURL)
	select {}
}

func uiShowMain()   {}
func uiApplyPrefs() {}

func showError(msg string) { fmt.Fprintln(os.Stderr, msg) }
