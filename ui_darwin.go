//go:build darwin

package main

// macOS 桌面界面：主控制台窗口 + 菜单栏图标 + 菜单栏小窗，用 Cocoa + WKWebView 实现（ui_darwin.m）。
// NSApplication 必须跑在主线程上；其它 goroutine 的请求都派发到主队列执行。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit -framework QuartzCore
#include <stdlib.h>

void gamRun(const char *pageURL, int devtools);
void gamShowMainAsync(void);
void gamApplyPrefsAsync(void);
void gamShowMain(void);
void gamHideMini(void);
void gamQuit(void);
void gamDragWindow(int win);
void gamZoomWindow(int win);
void gamSetClipboard(const char *text);
void gamSetAppearance(const char *mode);
void gamShowError(const char *msg);
*/
import "C"

import (
	"log"
	"os"
	"runtime"
	"strings"
	"unsafe"
)

// Cocoa 要求界面跑在主线程：main goroutine 在 init 时就固定在主线程上。
func init() { runtime.LockOSThread() }

// 与 ui_darwin.m 里的 kMain / kMini 对应。
const (
	macWinMain = 0
	macWinMini = 1
)

var macUI struct {
	loadPrefs func() UIPrefs
}

func runUI(pageURL, dataDir string, loadPrefs func() UIPrefs) {
	// GAM_HEADLESS=1：只跑内核不开窗口（前端开发、自动化截图用）。
	if os.Getenv("GAM_HEADLESS") == "1" {
		log.Printf("无界面模式：用浏览器打开 %s", pageURL)
		select {}
	}
	macUI.loadPrefs = loadPrefs
	devtools := 0
	if os.Getenv("GAM_DEVTOOLS") == "1" {
		devtools = 1
	}
	cURL := C.CString(pageURL)
	defer C.free(unsafe.Pointer(cURL))
	C.gamRun(cURL, C.int(devtools)) // 退出时 AppKit 直接结束进程
}

// uiShowMain 可在任意线程调用：让主线程把主控制台调到前台。
func uiShowMain() { C.gamShowMainAsync() }

// uiApplyPrefs 可在任意线程调用：小窗偏好改了，让主线程重新读取并生效。
func uiApplyPrefs() { C.gamApplyPrefsAsync() }

func showError(msg string) {
	if os.Getenv("GAM_HEADLESS") == "1" {
		os.Stderr.WriteString(msg + "\n")
		return
	}
	c := C.CString(msg)
	defer C.free(unsafe.Pointer(c))
	C.gamShowError(c)
}

// goGamOnMessage 处理页面通过 webkit.messageHandlers.gam.postMessage 发来的指令（主线程）。
//
//export goGamOnMessage
func goGamOnMessage(win C.int, msg *C.char) {
	m := C.GoString(msg)
	switch {
	case m == "mini:hide":
		C.gamHideMini()
	case m == "main:show":
		if win == macWinMini {
			C.gamHideMini()
		}
		C.gamShowMain()
	case m == "app:quit":
		C.gamQuit()
	case m == "window:drag":
		C.gamDragWindow(win)
	case m == "window:zoom":
		C.gamZoomWindow(win)
	case strings.HasPrefix(m, "clip:"):
		c := C.CString(strings.TrimPrefix(m, "clip:"))
		C.gamSetClipboard(c)
		C.free(unsafe.Pointer(c))
	case strings.HasPrefix(m, "theme:"):
		c := C.CString(strings.TrimPrefix(m, "theme:"))
		C.gamSetAppearance(c)
		C.free(unsafe.Pointer(c))
	}
}

// goGamLoadPrefs 供主线程读取小窗偏好。
//
//export goGamLoadPrefs
func goGamLoadPrefs(lightweight, pinned *C.int) {
	var p UIPrefs
	if macUI.loadPrefs != nil {
		p = macUI.loadPrefs()
	}
	*lightweight, *pinned = 0, 0
	if p.Lightweight {
		*lightweight = 1
	}
	if p.MiniPinned {
		*pinned = 1
	}
}

//export goGamLog
func goGamLog(msg *C.char) { log.Print(C.GoString(msg)) }
