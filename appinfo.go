package main

import (
	"net/http"
	"runtime"
)

// appInfo 告诉界面当前运行的平台和可用的功能，界面据此隐藏不支持的入口。
func (a *App) appInfo(w http.ResponseWriter, r *http.Request) {
	win := runtime.GOOS == "windows"
	writeJSON(w, http.StatusOK, map[string]any{
		"platform": runtime.GOOS,
		"capabilities": map[string]bool{
			"switch_clients":       win, // 切号：改 Windows 凭据管理器、重启客户端
			"chrome_password_sync": win, // 写入 Chrome 密码库：依赖 Windows DPAPI
			"os_unlock":            win || runtime.GOOS == "darwin",
			"tray":                 true,
		},
		"os_user": osUserName(),
	})
}
