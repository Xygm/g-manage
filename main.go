// 谷歌账号管理：记录每个号的登录天数和风控期、直接向 Google 查询反重力额度、
// 一键用该号独立的 Chrome 资料目录打开浏览器 / Gmail。
package main

import (
	"embed"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

// 默认固定端口：OAuth 回调地址要用它，同时用来防止重复启动。
const defaultAddr = "127.0.0.1:17800"

func fatal(msg string) {
	log.Print(msg)
	showError(msg)
	os.Exit(1)
}

func main() {
	dataDir := flag.String("data", "", "数据目录（默认：程序所在目录下的 data）")
	listenAddr := flag.String("addr", defaultAddr, "监听地址（开发调试用，避免和正在运行的实例冲突）")
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		exe, err := os.Executable()
		if err != nil {
			fatal("找不到程序所在目录：" + err.Error())
		}
		dir = defaultDataDir(exe)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal("创建数据目录失败：" + err.Error())
	}
	if f, err := os.OpenFile(filepath.Join(dir, "app.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		// 文件在前：Windows 窗口程序没有控制台，写 stderr 会失败，MultiWriter 遇错即停。
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}

	ln, err := net.Listen("tcp", *listenAddr)
	if err != nil {
		if wakeRunningInstance(*listenAddr) {
			return // 已在运行：把它的主控制台调出来就行
		}
		fatal("程序已经在运行了（或端口 " + *listenAddr + " 被其它程序占用）。\n\n" + err.Error())
	}

	store, err := OpenStore(filepath.Join(dir, "gam.db"))
	if err != nil {
		fatal("打开数据库失败：" + err.Error())
	}

	app := &App{store: store, dataDir: dir, addr: *listenAddr, pending: map[string]pendingAuth{}}
	srv := &http.Server{Handler: app.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			fatal("内部服务异常退出：" + err.Error())
		}
	}()
	log.Printf("已启动，数据目录：%s", dir)

	runUI("http://"+*listenAddr+"/", dir, func() UIPrefs {
		p, err := store.GetUIPrefs()
		if err != nil {
			log.Printf("读取小窗偏好失败：%v", err)
		}
		return p
	}) // 退出时返回
}

// defaultDataDir：默认放在程序旁边的 data 目录；macOS 打包成 .app 后程序在包内，
// 改放到 ~/Library/Application Support/谷歌账号管理（包内会被替换、也可能只读）。
func defaultDataDir(exe string) string {
	if runtime.GOOS == "darwin" && strings.Contains(exe, ".app/Contents/MacOS") {
		if base, err := os.UserConfigDir(); err == nil {
			return filepath.Join(base, "谷歌账号管理")
		}
	}
	return filepath.Join(filepath.Dir(exe), "data")
}

// wakeRunningInstance 请已经在运行的实例显示主控制台（关窗后程序留在托盘，再次双击程序时用到）。
func wakeRunningInstance(addr string) bool {
	req, err := http.NewRequest(http.MethodPost, "http://"+addr+"/api/ui/show-main", nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Requested-With", "gam")
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusNoContent
}
