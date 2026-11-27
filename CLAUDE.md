# CLAUDE.md

请严格遵循项目根目录总纲与视觉交互设计规范：

- @AGENTS.md
- @docs/DESIGN.md
- @frontend/AGENTS.md

## 速查底线
1. 改 `frontend/` 前必读 `docs/DESIGN.md`：只用 `frontend/src/styles.css` 语义令牌（禁用 `bg-gray-*`/`text-blue-*`/裸 `#hex`），数字必加 `tnum`，动画只取 `frontend/src/lib/motion.ts`（禁用 `transition-all`），禁用 `window.alert/confirm/prompt`。
2. 改完 `frontend/` 必须执行 `npm --prefix frontend run build` 并一并提交更新后的 `web/`。
3. 提交前必须通过 `go test -race ./...`（含 `guardrails_test.go` 自动化审美与架构校验）及跨平台编译检查。
