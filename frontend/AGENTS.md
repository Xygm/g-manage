# frontend/AGENTS.md — 前端开发与设计强制规则

在本目录（`frontend/`）新增或修改任何组件前，必须完整遵守 `../docs/DESIGN.md` 的设计系统规范：

1. **只用语义颜色与阴影令牌（严禁裸色值）**
   - 背景海拔：`bg-tray` / `bg-tray-deep`（底托）→ `bg-surface`（主面板）→ `bg-surface-2`（内嵌卡片）→ `bg-fill` / `bg-fill-strong`（悬停与控件填充）。
   - 文字层级：`text-ink`（主文）→ `text-ink-2`（次文）→ `text-ink-3`（弱提示/表头）。
   - 语义强调：`accent`（主题蓝）、`warn`（琥珀预警）、`danger`（高危红）、`ok`（健康绿）、`violet`（Ultra 紫），搭配各自的 `-soft` 与 `-dot`。
   - **禁止**使用 `bg-slate-*`、`text-gray-*`、`border-zinc-*`、`bg-blue-500` 等 Tailwind 原始色板或硬编码 `#hex`，否则 `go test ./...` 中的 `TestDesignTokenPurity` 会直接失败。
2. **几何、边框与数字对齐**
   - 嵌套容器遵守同心圆角：`外圆角 = 内圆角 + 层间内边距`（例如外层 `rounded-[20px] p-1.5` 包裹内层 `rounded-[14px]`）。
   - 分割线与卡片边界优先使用 `0.5px` 内阴影微描边（`shadow-raised`、`hairline-b`、`--line`、`--line-strong`），避免生硬的 `1px` 实线网格感。
   - 所有数字指标（积分、算力、金额、百分比、天数、倒计时、2FA 验证码）必须加 `tnum`（`tabular-nums`）。
   - 列表无某项数据时使用右对齐淡色短横 `—` 锚定列轴线，不要重复渲染满屏「无 / 暂无」。
3. **优先复用 `src/ui/` 原语**
   - 按钮、图标按钮、快捷键与 Tooltip 复用 `src/ui/button.tsx`。
   - 头像、状态胶囊 `Pill`、档位徽标 `TierBadge`、进度条 `QuotaBar`、标签 `TagChip`、2FA 组件复用 `src/ui/display.tsx`。
   - 开关、分段器、输入框复用 `src/ui/form.tsx`；菜单、锚点浮层 `Popover`、就地确认 `ConfirmPop`、抽屉与 Sheet 复用 `src/ui/overlay.tsx`。
4. **动效与 60fps 性能红线**
   - 弹簧与淡入淡出统一引用 `src/lib/motion.ts`（`spring.press / snap / pop / glide / roll`、`fade`），严禁 `transition-all` 或自定义突兀曲线。
   - `src/main/AccountList.tsx` 保持固定行高（`ROW_H = 54`）与虚拟滚动，行内严禁挂载高开销布局观察器或逐帧 JS 定时器。
5. **构建产物同步**
   - 每次修改 `frontend/src/` 后必须运行 `npm --prefix frontend run build`，确保根目录 `../web/` 嵌入产物与源码严格一致。
