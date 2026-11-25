//go:build windows

package main

// 桌面界面：主控制台窗口 + 托盘图标 + 托盘小窗（无边框，点托盘在图标旁弹出，失焦自动收起，图钉固定后常驻置顶）。
// 窗口、托盘和两个 WebView2 都在同一个系统线程上，由这里的消息循环驱动。

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

// WebView2 要求窗口在创建它的系统线程上运行消息循环。
func init() { runtime.LockOSThread() }

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")
	dwmapi  = windows.NewLazySystemDLL("dwmapi.dll")

	pRegisterClassExW       = user32.NewProc("RegisterClassExW")
	pCreateWindowExW        = user32.NewProc("CreateWindowExW")
	pDefWindowProcW         = user32.NewProc("DefWindowProcW")
	pDestroyWindow          = user32.NewProc("DestroyWindow")
	pShowWindow             = user32.NewProc("ShowWindow")
	pSetWindowPos           = user32.NewProc("SetWindowPos")
	pGetMessageW            = user32.NewProc("GetMessageW")
	pTranslateMessage       = user32.NewProc("TranslateMessage")
	pDispatchMessageW       = user32.NewProc("DispatchMessageW")
	pPostMessageW           = user32.NewProc("PostMessageW")
	pPostQuitMessage        = user32.NewProc("PostQuitMessage")
	pLoadCursorW            = user32.NewProc("LoadCursorW")
	pGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	pSetForegroundWindow    = user32.NewProc("SetForegroundWindow")
	pCreatePopupMenu        = user32.NewProc("CreatePopupMenu")
	pAppendMenuW            = user32.NewProc("AppendMenuW")
	pTrackPopupMenu         = user32.NewProc("TrackPopupMenu")
	pDestroyMenu            = user32.NewProc("DestroyMenu")
	pGetCursorPos           = user32.NewProc("GetCursorPos")
	pMonitorFromPoint       = user32.NewProc("MonitorFromPoint")
	pGetMonitorInfoW        = user32.NewProc("GetMonitorInfoW")
	pRegisterWindowMessageW = user32.NewProc("RegisterWindowMessageW")
	pIsWindowVisible        = user32.NewProc("IsWindowVisible")
	pIsIconic               = user32.NewProc("IsIconic")
	pCreateIconFromResEx    = user32.NewProc("CreateIconFromResourceEx")
	pMessageBoxW            = user32.NewProc("MessageBoxW")
	pShellNotifyIconW       = shell32.NewProc("Shell_NotifyIconW")
	pDwmSetWindowAttribute  = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	wsOverlappedWindow = 0x00CF0000
	wsPopup            = 0x80000000
	wsClipChildren     = 0x02000000
	wsExToolWindow     = 0x00000080
	csDropShadow       = 0x00020000
	cwUseDefault       = 0x80000000

	swHide    = 0
	swShow    = 5
	swRestore = 9

	wmDestroy     = 0x0002
	wmMove        = 0x0003
	wmSize        = 0x0005
	wmActivate    = 0x0006
	wmClose       = 0x0010
	wmNull        = 0x0000
	wmLButtonUp   = 0x0202
	wmLButtonDbl  = 0x0203
	wmRButtonUp   = 0x0205
	wmApp         = 0x8000
	wmTray        = wmApp + 1
	wmShowMain    = wmApp + 2
	wmApplyPrefs  = wmApp + 3
	waInactive    = 0
	hwndTopmost   = ^uintptr(0)     // -1
	hwndNoTopmost = ^uintptr(0) - 1 // -2
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpShowWindow = 0x0040

	nimAdd     = 0
	nimDelete  = 2
	nifMessage = 1
	nifIcon    = 2
	nifTip     = 4

	tpmReturnCmd   = 0x0100
	tpmRightButton = 0x0002
	mfString       = 0x0000
	mfSeparator    = 0x0800

	smCxScreen = 0
	smCyScreen = 1
	smCxSmIcon = 49

	monitorDefaultToNearest = 2
	idcArrow                = 32512

	mainWidth, mainHeight = 1320, 820
	miniWidth, miniHeight = 400, 486
	trayIconID            = 1
)

type wndClassExW struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      winPoint
}

type winPoint struct{ X, Y int32 }

type winRect struct{ Left, Top, Right, Bottom int32 }

type monitorInfo struct {
	Size    uint32
	Monitor winRect
	Work    winRect
	Flags   uint32
}

type notifyIconData struct {
	Size            uint32
	Wnd             uintptr
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            uintptr
	Tip             [128]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	Version         uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GUIDItem        windows.GUID
	BalloonIcon     uintptr
}

type webWindow struct {
	hwnd uintptr
	view *edge.Chromium
	mini bool
}

// uiState 只在界面线程上读写；trayHwnd 供其它线程 PostMessage。
var ui struct {
	pageURL, dataDir string
	loadPrefs        func() UIPrefs
	prefs            UIPrefs
	instance         windows.Handle
	icon             uintptr
	main, mini       *webWindow
	windows          map[uintptr]*webWindow
	trayOK           bool
	taskbarCreated   uintptr
	miniHiddenAt     time.Time
	// creating 为 true 表示正在创建 WebView2：创建期间 Embed 会在内部跑消息循环，这时再收到托盘点击
	// 会重入、嵌套再创建一个（本机见过连点托盘后堆出 9 个空小窗、一个都没显示出来）。
	creating bool
}

var trayHwnd atomic.Uintptr

func call(p *windows.LazyProc, args ...uintptr) uintptr {
	r, _, _ := p.Call(args...)
	return r
}

func utf16(s string) *uint16 {
	p, _ := windows.UTF16PtrFromString(s)
	return p
}

func runUI(pageURL, dataDir string, loadPrefs func() UIPrefs) {
	ui.pageURL, ui.dataDir, ui.loadPrefs = pageURL, dataDir, loadPrefs
	ui.prefs = loadPrefs()
	ui.windows = map[uintptr]*webWindow{}
	_ = windows.GetModuleHandleEx(0, nil, &ui.instance)
	ui.icon = makeAppIcon()

	proc := windows.NewCallback(wndProc)
	cursor := call(pLoadCursorW, 0, idcArrow)
	for _, c := range []struct {
		name  string
		style uint32
	}{{"gamMain", 0}, {"gamMini", csDropShadow}, {"gamTray", 0}} {
		wc := wndClassExW{
			Style: c.style, WndProc: proc, Instance: ui.instance, ClassName: utf16(c.name),
			Icon: windows.Handle(ui.icon), IconSm: windows.Handle(ui.icon), Cursor: windows.Handle(cursor),
		}
		wc.Size = uint32(unsafe.Sizeof(wc))
		call(pRegisterClassExW, uintptr(unsafe.Pointer(&wc)))
	}

	// 托盘图标挂在一个不显示的顶层窗口上（纯消息窗口收不到资源管理器重启的广播）。
	tray := call(pCreateWindowExW, 0, uintptr(unsafe.Pointer(utf16("gamTray"))), uintptr(unsafe.Pointer(utf16("谷歌账号管理"))),
		0, 0, 0, 0, 0, 0, 0, uintptr(ui.instance), 0)
	trayHwnd.Store(tray)
	ui.taskbarCreated = call(pRegisterWindowMessageW, uintptr(unsafe.Pointer(utf16("TaskbarCreated"))))
	ui.trayOK = addTrayIcon()

	if !showMain() {
		fatal("无法创建窗口：本机缺少 Microsoft Edge WebView2 运行时。\n" +
			"请到 https://developer.microsoft.com/microsoft-edge/webview2/ 下载安装「常青版」后重试。")
	}

	var msg winMsg
	for {
		r := int32(call(pGetMessageW, uintptr(unsafe.Pointer(&msg)), 0, 0, 0))
		if r <= 0 {
			break
		}
		call(pTranslateMessage, uintptr(unsafe.Pointer(&msg)))
		call(pDispatchMessageW, uintptr(unsafe.Pointer(&msg)))
	}
	removeTrayIcon()
}

func wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	w := ui.windows[hwnd]
	switch {
	case msg == wmSize && w != nil && w.view != nil:
		w.view.Resize()
	case msg == wmMove && w != nil && w.view != nil:
		_ = w.view.NotifyParentWindowPositionChanged()
	case msg == wmActivate && w != nil:
		if wp&0xffff == waInactive {
			if w.mini && !ui.prefs.MiniPinned {
				hideMini()
			}
		} else if w.view != nil {
			w.view.Focus()
		}
	case msg == wmClose && w != nil:
		if w.mini {
			hideMini()
		} else {
			closeMain()
		}
		return 0
	case msg == wmDestroy && w != nil:
		delete(ui.windows, hwnd)
		return 0
	case msg == wmTray:
		switch lp & 0xffff {
		case wmLButtonUp:
			toggleMini()
		case wmLButtonDbl:
			showMain()
		case wmRButtonUp:
			showTrayMenu(hwnd)
		}
		return 0
	case msg == wmShowMain:
		showMain()
		return 0
	case msg == wmApplyPrefs:
		ui.prefs = ui.loadPrefs()
		if ui.mini != nil && isVisible(ui.mini.hwnd) {
			setTopmost(ui.mini.hwnd, ui.prefs.MiniPinned)
		}
		return 0
	case msg == ui.taskbarCreated && msg != 0:
		ui.trayOK = addTrayIcon()
		return 0
	}
	return call(pDefWindowProcW, hwnd, msg, wp, lp)
}

// createWebWindow 创建窗口并记录耗时：创建卡住时日志里能看到只有开始没有结束。
func createWebWindow(mini bool) *webWindow {
	name := "主控制台"
	if mini {
		name = "小窗"
	}
	start := time.Now()
	log.Printf("开始创建%s", name)
	w := newWebWindow(mini)
	if w == nil {
		log.Printf("创建%s失败", name)
	} else {
		log.Printf("%s创建完成，用时 %v", name, time.Since(start).Round(time.Millisecond))
	}
	return w
}

func newWebWindow(mini bool) *webWindow {
	var hwnd uintptr
	if mini {
		hwnd = call(pCreateWindowExW, wsExToolWindow, uintptr(unsafe.Pointer(utf16("gamMini"))), uintptr(unsafe.Pointer(utf16("谷歌账号管理"))),
			wsPopup|wsClipChildren, 0, 0, miniWidth, miniHeight, 0, 0, uintptr(ui.instance), 0)
		// Windows 11 圆角（旧系统忽略）。
		corner := uint32(2) // DWMWCP_ROUND
		call(pDwmSetWindowAttribute, hwnd, 33, uintptr(unsafe.Pointer(&corner)), 4)
	} else {
		sw, sh := int(call(pGetSystemMetrics, smCxScreen)), int(call(pGetSystemMetrics, smCyScreen))
		w, h := min(mainWidth, sw), min(mainHeight, sh-40)
		hwnd = call(pCreateWindowExW, 0, uintptr(unsafe.Pointer(utf16("gamMain"))), uintptr(unsafe.Pointer(utf16("谷歌账号管理"))),
			wsOverlappedWindow|wsClipChildren, uintptr((sw-w)/2), uintptr(max(0, (sh-h)/2-20)), uintptr(w), uintptr(h), 0, 0, uintptr(ui.instance), 0)
	}
	if hwnd == 0 {
		return nil
	}
	ww := &webWindow{hwnd: hwnd, mini: mini}
	ui.windows[hwnd] = ww
	if !mini {
		call(pShowWindow, hwnd, swShow)
	}

	view := edge.NewChromium()
	view.DataPath = filepath.Join(ui.dataDir, "webview")
	view.SetPermission(edge.CoreWebView2PermissionKindClipboardRead, edge.CoreWebView2PermissionStateAllow)
	view.MessageCallback = func(m string) { onWebMessage(ww, m) }
	if !view.Embed(hwnd) {
		delete(ui.windows, hwnd)
		call(pDestroyWindow, hwnd)
		return nil
	}
	if settings, err := view.GetSettings(); err == nil {
		_ = settings.PutAreDefaultContextMenusEnabled(false)
		_ = settings.PutAreDevToolsEnabled(false)
	}
	ww.view = view
	view.Resize()
	page := ui.pageURL
	if mini {
		page += "mini.html"
	}
	view.Navigate(page)
	return ww
}

// onWebMessage 处理页面通过 chrome.webview.postMessage 发来的指令。
func onWebMessage(w *webWindow, m string) {
	switch m {
	case "mini:hide":
		hideMini()
	case "main:show":
		if w.mini {
			hideMini()
		}
		showMain()
	case "app:quit":
		call(pPostQuitMessage, 0)
	}
}

func isVisible(hwnd uintptr) bool { return call(pIsWindowVisible, hwnd) != 0 }

func setTopmost(hwnd uintptr, on bool) {
	after := hwndNoTopmost
	if on {
		after = hwndTopmost
	}
	call(pSetWindowPos, hwnd, after, 0, 0, 0, 0, swpNoMove|swpNoSize)
}

func showMain() bool {
	if ui.main == nil {
		if ui.creating {
			return true
		}
		ui.creating = true
		ui.main = createWebWindow(false)
		ui.creating = false
		if ui.main == nil {
			return false
		}
	} else {
		if call(pIsIconic, ui.main.hwnd) != 0 {
			call(pShowWindow, ui.main.hwnd, swRestore)
		} else {
			call(pShowWindow, ui.main.hwnd, swShow)
		}
		_ = ui.main.view.Show()
	}
	call(pSetForegroundWindow, ui.main.hwnd)
	return true
}

// closeMain：有托盘时关窗只是收到托盘；轻量模式下连 WebView2 一起销毁释放内存，下次打开重新创建。
func closeMain() {
	m := ui.main
	if m == nil {
		return
	}
	if !ui.trayOK {
		call(pPostQuitMessage, 0)
		return
	}
	if !ui.prefs.Lightweight {
		_ = m.view.Hide()
		call(pShowWindow, m.hwnd, swHide)
		return
	}
	ui.main = nil
	closeController(m.view)
	call(pDestroyWindow, m.hwnd)
}

// closeController 调 ICoreWebView2Controller::Close（vtable 第 24 项），让 WebView2 释放这个页面占用的进程和内存。
func closeController(view *edge.Chromium) {
	ctrl := view.GetController()
	if ctrl == nil {
		return
	}
	vtbl := *(**[26]uintptr)(unsafe.Pointer(ctrl))
	syscall.SyscallN(vtbl[24], uintptr(unsafe.Pointer(ctrl)))
}

func toggleMini() {
	if ui.mini != nil && isVisible(ui.mini.hwnd) {
		hideMini()
		return
	}
	// 点托盘图标时小窗先失焦收起，紧接着的这次点击不应再把它打开。
	if time.Since(ui.miniHiddenAt) < 400*time.Millisecond {
		return
	}
	showMini()
}

func showMini() {
	x, y := miniPosition() // 按点击时的鼠标位置算，创建 WebView2 要一两秒，期间鼠标可能已经移开
	if ui.mini == nil {
		if ui.creating {
			return
		}
		ui.creating = true
		ui.mini = createWebWindow(true)
		ui.creating = false
		if ui.mini == nil {
			return
		}
	}
	after := hwndNoTopmost
	if ui.prefs.MiniPinned {
		after = hwndTopmost
	}
	call(pSetWindowPos, ui.mini.hwnd, after, uintptr(x), uintptr(y), miniWidth, miniHeight, swpShowWindow)
	_ = ui.mini.view.Show()
	call(pSetForegroundWindow, ui.mini.hwnd)
	ui.mini.view.Eval("window.gamMini && gamMini.onShow()")
}

func hideMini() {
	if ui.mini == nil || !isVisible(ui.mini.hwnd) {
		return
	}
	call(pShowWindow, ui.mini.hwnd, swHide)
	_ = ui.mini.view.Hide()
	ui.miniHiddenAt = time.Now()
	ui.mini.view.Eval("window.gamMini && gamMini.onHide()")
}

// miniPosition 让小窗在鼠标（刚点过的托盘图标）旁弹出：任务栏在下方时往上弹，并保证不超出屏幕工作区。
// 不用 Shell_NotifyIconGetRect：本机实测它给的位置和图标实际位置对不上（小窗弹到了另一块屏幕上）。
func miniPosition() (int32, int32) {
	var pt winPoint
	call(pGetCursorPos, uintptr(unsafe.Pointer(&pt)))
	mi := monitorInfo{}
	mi.Size = uint32(unsafe.Sizeof(mi))
	mon := call(pMonitorFromPoint, uintptr(uint32(pt.X))|uintptr(uint32(pt.Y))<<32, monitorDefaultToNearest)
	call(pGetMonitorInfoW, mon, uintptr(unsafe.Pointer(&mi)))
	work := mi.Work
	const gap = 12
	x := pt.X - miniWidth/2
	y := pt.Y + gap
	if pt.Y > (mi.Monitor.Top+mi.Monitor.Bottom)/2 {
		y = pt.Y - miniHeight - gap
	}
	x = max(work.Left+gap, min(x, work.Right-miniWidth-gap))
	y = max(work.Top+gap, min(y, work.Bottom-miniHeight-gap))
	return x, y
}

func showTrayMenu(hwnd uintptr) {
	menu := call(pCreatePopupMenu)
	if menu == 0 {
		return
	}
	defer call(pDestroyMenu, menu)
	call(pAppendMenuW, menu, mfString, 1, uintptr(unsafe.Pointer(utf16("打开主控制台"))))
	call(pAppendMenuW, menu, mfString, 2, uintptr(unsafe.Pointer(utf16("额度小窗"))))
	call(pAppendMenuW, menu, mfSeparator, 0, 0)
	call(pAppendMenuW, menu, mfString, 3, uintptr(unsafe.Pointer(utf16("退出"))))
	var pt winPoint
	call(pGetCursorPos, uintptr(unsafe.Pointer(&pt)))
	call(pSetForegroundWindow, hwnd) // 否则点菜单外不会收起
	cmd := call(pTrackPopupMenu, menu, tpmReturnCmd|tpmRightButton, uintptr(pt.X), uintptr(pt.Y), 0, hwnd, 0)
	call(pPostMessageW, hwnd, wmNull, 0, 0)
	switch cmd {
	case 1:
		showMain()
	case 2:
		showMini()
	case 3:
		call(pPostQuitMessage, 0)
	}
}

func trayData() notifyIconData {
	d := notifyIconData{Wnd: trayHwnd.Load(), ID: trayIconID, Flags: nifMessage | nifIcon | nifTip, CallbackMessage: wmTray, Icon: ui.icon}
	d.Size = uint32(unsafe.Sizeof(d))
	tip, _ := windows.UTF16FromString("谷歌账号管理")
	copy(d.Tip[:len(d.Tip)-1], tip)
	return d
}

func addTrayIcon() bool {
	d := trayData()
	if call(pShellNotifyIconW, nimAdd, uintptr(unsafe.Pointer(&d))) == 0 {
		log.Print("添加托盘图标失败")
		return false
	}
	return true
}

func removeTrayIcon() {
	d := trayData()
	call(pShellNotifyIconW, nimDelete, uintptr(unsafe.Pointer(&d)))
}

// makeAppIcon 画一个品牌色圆角方块 + 白色盾牌对勾的图标，用于托盘和窗口（程序本身没有图标资源）。
func makeAppIcon() uintptr {
	const n = 64
	img := image.NewNRGBA(image.Rect(0, 0, n, n))
	blue := color.NRGBA{0x00, 0x71, 0xE3, 0xFF}
	white := color.NRGBA{0xFF, 0xFF, 0xFF, 0xFF}
	inRoundRect := func(x, y, r float64) bool {
		dx := math.Max(math.Max(r-x, x-(n-r)), 0)
		dy := math.Max(math.Max(r-y, y-(n-r)), 0)
		return dx*dx+dy*dy <= r*r
	}
	// 盾牌：上半是矩形，下半收成尖角。
	inShield := func(x, y float64) bool {
		if y < 14 || y > 52 || x < 18 || x > 46 {
			return false
		}
		if y <= 34 {
			return true
		}
		half := 14 * (52 - y) / 18
		return math.Abs(x-32) <= half
	}
	nearSegment := func(px, py, ax, ay, bx, by, w float64) bool {
		vx, vy := bx-ax, by-ay
		t := math.Max(0, math.Min(1, ((px-ax)*vx+(py-ay)*vy)/(vx*vx+vy*vy)))
		dx, dy := px-(ax+t*vx), py-(ay+t*vy)
		return dx*dx+dy*dy <= w*w
	}
	for y := range n {
		for x := range n {
			fx, fy := float64(x)+0.5, float64(y)+0.5
			if !inRoundRect(fx, fy, 14) {
				continue
			}
			c := blue
			if inShield(fx, fy) {
				c = white
				if nearSegment(fx, fy, 24, 32, 30, 38, 2.6) || nearSegment(fx, fy, 30, 38, 41, 26, 2.6) {
					c = blue
				}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if png.Encode(&buf, img) != nil {
		return 0
	}
	size := call(pGetSystemMetrics, smCxSmIcon) * 2
	b := buf.Bytes()
	return call(pCreateIconFromResEx, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 1, 0x00030000, size, size, 0)
}

// uiShowMain 可在任意线程调用：让界面线程把主控制台调到前台。
func uiShowMain() {
	if h := trayHwnd.Load(); h != 0 {
		call(pPostMessageW, h, wmShowMain, 0, 0)
	}
}

// uiApplyPrefs 可在任意线程调用：小窗偏好改了，让界面线程重新读取并生效。
func uiApplyPrefs() {
	if h := trayHwnd.Load(); h != 0 {
		call(pPostMessageW, h, wmApplyPrefs, 0, 0)
	}
}

func showError(msg string) {
	call(pMessageBoxW, 0, uintptr(unsafe.Pointer(utf16(msg))), uintptr(unsafe.Pointer(utf16("谷歌账号管理"))), 0x10) // MB_ICONERROR
}
