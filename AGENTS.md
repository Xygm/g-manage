# AGENTS.md — 项目协作与工程总纲

本文件是 AI 编码代理（Antigravity、Codex、Cursor、Claude Code、Copilot 等）与人类协作者的统一工程入口。修改代码前请先阅读并遵守以下约束。

## 1. 项目概览与目录职责

`g-manage`（谷歌账号管理）是一款面向百号级 Google / Antigravity 账号池的跨平台原生桌面工具（macOS Cocoa WebView + Windows WebView2），采用 **Go 单体后端 + 内嵌前端静态资源** 架构：

- 根目录 `*.go` / `*.m`：Go 后端、SQLite 存储（`store.go`）、系统保险箱（`vault.go`）、OAuth 与额度检测（`google.go` / `service.go`）、本地无依赖 CDP 会员权益同步（`cdp.go` / `perks_sync.go`）及原生窗口外壳（`ui_darwin.*` / `ui_windows.go`）。
- `frontend/`：React 19 + TypeScript + Tailwind CSS v4 双入口前端（主窗口 `index.html` + 托盘迷你窗 `mini.html`），编译产物直接输出至根目录 `web/`。
- `web/`：由 `npm --prefix frontend run build` 生成并通过 `embed.FS` 编入 Go 二进制的静态资源。**严禁手动编辑 `web/` 下的文件**；凡修改 `frontend/`，提交前必须重新构建并一并提交 `web/`。
- `docs/DESIGN.md`：**UI 视觉美学与交互设计宪法**。凡涉及前端界面、样式、文案、动画或列表布局改动，**必须先阅读 `docs/DESIGN.md` 与 `frontend/AGENTS.md`**。

## 2. 核心工程红线（不可破坏）

1. **视觉与交互统一性**：
   - 严禁在 `.tsx` / `.ts` 中使用原生 Tailwind 调色板类名（如 `bg-blue-500`、`text-gray-400`、`border-slate-200`）或硬编码 `#hex` 颜色；必须使用 `frontend/src/styles.css` 定义的语义令牌（如 `bg-surface`、`text-ink-2`、`bg-danger-soft`），确保亮/暗双主题自动适配。
   - 严禁使用阻塞式原生弹窗（`window.alert` / `confirm` / `prompt`），统一使用就地 `ConfirmPop` 或带 `undo` 的 `toast`。
   - 严禁手写 `transition-all`；动画曲线统一从 `frontend/src/lib/motion.ts` 获取。
   - 主账号列表（`AccountList.tsx`）必须保持固定行高虚拟滚动（`ROW_H = 54`），确保 100+ 账号同屏稳守 60fps。
2. **数据与浏览器安全**：
   - SQLite 读写（尤其 JSON 合并更新如 `Store.UpdatePerks`）必须在互斥锁 + 事务内原子完成；人工显式设置的覆盖字段（如 `BillingManual`、`TierOverride`）不得被后台自动同步覆盖。
   - 浏览器进程控制严禁对运行中的用户 Chrome 发送 `SIGKILL` 强杀，确保 Cookie 与会话正常落盘；本地 CDP 严禁添加 `--remote-allow-origins=*`。
3. **跨平台编译兼容**：
   - 平台特定代码必须通过文件名后缀或 build tag 严格隔离（`*_darwin.go` / `*_windows.go` / `*_unix.go` / `*_other.go`）。在 macOS 上改动不得破坏 Windows 交叉编译，反之亦然。

## 3. 常用命令与提交前必跑门禁

```bash
# 1. 前端类型检查与生产构建（修改 frontend/ 后必跑，同步更新 web/）
npm --prefix frontend run build

# 2. 后端全量单测 + 竞态检测 + 前端设计/工程守护校验（guardrails_test.go）
go test -race ./...

# 3. 跨平台编译自检（确保未破坏另一端）
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .
CGO_ENABLED=1 go build -o /dev/null .   # macOS 本机（Cocoa WKWebView 需开启 cgo）

# 4. 桌面安装包打包（按本机平台）
./build_mac.sh          # macOS -> dist/谷歌账号管理.app
./build.sh              # Linux/WSL -> dist/g-manage.exe（需 mingw-w64 windres）
```

> 可运行 `./scripts/install-hooks.sh` 一键启用本地 Git `pre-commit` 钩子，在每次提交前自动拦截令牌违规与 `web/` 漏构建问题。
