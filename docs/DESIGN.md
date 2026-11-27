# DESIGN.md — 视觉美学与交互设计规范

本文档定义 `g-manage` 的产品体验哲学与视觉工程标准。无论是人工迭代还是通过 AI 代理新增功能，都必须以此为准绳，保持克制、通透、高密而不拥挤的原生桌面质感（参考 macOS Sequoia 与 Linear 的设计克制感）。

---

## 一、八大体验铁律

1. **把复杂留给系统，把简单留给人**
   能从会话、日志或配置里自动推断的状态（如会员档位、到期日、授权失效原因、风控剩余天数），系统后台静默算好呈现结论，不让用户填繁琐表单。
2. **此刻没用的，就不出现（渐进披露）**
   全库为 `0` 的异常筛选胶囊（如无停用号时的「已停用」）、全库暂无数据的权益列默认自动收起；只在数据出现或用户显式开启时优雅浮现。
3. **常态静默，异常发声（克制用色）**
   健康的常态（如「已改密」、充足额度、正常续期）使用低饱和中性色沉入背景；高饱和红（`danger`）与琥珀橙（`warn`）只留给真正需要立即干预的风险（如停用、授权失效、5 天内自动扣费）。
4. **界面自己说明自己，不刷屏废话**
   用 `28px` 微表头 + 等宽右对齐数字传达结构；单个账号没有某项权益时，用极淡的 `—` 维持垂直视觉轴线，绝不在几百行里重复印刺眼的「无 / 未开通 / 暂无数据」。
5. **给后悔药，而不是弹窗审问**
   状态切换与常规删除优先立即生效并弹出带「撤销（`⌘Z`）」的 `Toast`；确需二次确认的不可逆操作（如放弃未保存新密码）使用从按钮长出的轻量 `ConfirmPop`，**严禁 `window.alert / confirm / prompt`**。
6. **容器实测自适应，而非死板断点挤压**
   多列列表按容器实测净宽做确定性列预算分配（`src/lib/columns.ts`）：优先保护左侧账号身份可读性，空间收紧时先将「标签」无损折入副行，绝不把邮箱或状态胶囊挤成乱码。
7. **键盘与鼠标同等一等公民**
   高频路径全程支持快捷键（`↑/↓` 或 `J/K` 切号、`/` 搜索、`⌘K` 命令面板、`⌘C` 复制 2FA、`⌘O` 开浏览器、`⌘R` 刷额度），且所有图标按钮必须具备清晰的 `Tooltip`（含快捷键提示）。
8. **百号同屏稳守 60fps**
   设计美感绝不以掉帧为代价：主列表坚持固定行高虚拟化渲染，进度条只动画 `transform: scaleX()`，2FA 倒计时环用纯 CSS `@keyframes` 驱动，完整适配系统「减弱动态效果（`prefers-reduced-motion`）」。

---

## 二、材质海拔与语义色彩令牌

所有颜色与阴影统一定义在 `frontend/src/styles.css`，亮色（`:root`）、手动暗色（`:root[data-theme="dark"]`）与系统跟随暗色（`@media (prefers-color-scheme: dark)`）三处严格同步。**组件代码中严禁使用 Tailwind 原始调色板（如 `bg-gray-100`、`text-blue-600`）或裸 `#hex`。**

### 1. 三层物理海拔（Elevation）

| 层级 | Tailwind 类名 | 视觉角色与用法 |
| :--- | :--- | :--- |
| **L0 底托层** | `bg-tray` / `bg-tray-deep` + `shadow-tray` | 窗口背景与微内凹外框托盘（如左右分栏外框），承托内部凸起面板。 |
| **L1 主表面** | `bg-surface` + `shadow-raised` | 账号列表画布、右侧详情主面板、搜索框、模态框主体。 |
| **L2 内嵌层** | `bg-surface-2` | 详情卡片内的次级数据磁贴（如 Flow / Colab 双格算力卡、视图配置开关底座）。 |
| **交互填充** | `bg-fill` / `bg-fill-strong` | 悬停底色、分段控制器槽底、进度条凹槽、骨架屏与细滚动条。 |

### 2. 文字与语义色令牌

| 类别 | 类名 | 适用场景 |
| :--- | :--- | :--- |
| **文字三级** | `text-ink` / `text-ink-2` / `text-ink-3` | 主标题与核心数值 / 正文与次级指标 / 表头、时间戳、单位与弱占位符。 |
| **微分割线** | `bg-line` / `bg-line-strong` / `hairline-b` | 行间缩进 `0.5px` 细线、浮层分组线、卡片微内描边。 |
| **主题蓝** | `text-accent` / `bg-accent` / `bg-accent-soft` | 主操作按钮、Pro 档位、当前排序指示、选中行左侧 `2.5px` 锚条与焦点光环。 |
| **Ultra 紫** | `text-violet` / `bg-violet-soft` | Ultra / Ultra 5x / Ultra 20x 会员徽标、Claude/GPT 额度池进度条。 |
| **预警琥珀** | `text-warn` / `bg-warn-soft` / `bg-warn-dot` | 待改密、即将到期、当月待领赠金、倒计时最后 5 秒。 |
| **高危红** | `text-danger` / `bg-danger-soft` / `bg-danger-dot` | 服务停用、授权过期、自动扣费临期（防反撸预警）、额度耗尽。 |
| **健康绿** | `text-ok` / `bg-ok-soft` / `bg-ok-dot` | 已改密圆点、复制成功瞬态闪烁、已激活赠金余额。 |

### 3. 代码正反例对照

```tsx
// ❌ 反例：硬编码色板与粗边框，暗色模式必崩且充满廉价后台感
<div className="rounded-xl border border-gray-200 bg-white p-3 text-slate-600 transition-all">
  <span className="text-blue-500">{credits}</span>
</div>

// ✅ 正例：使用语义令牌、0.5px 内描边与等宽数字，双主题自动浑然一体
<div className="rounded-[10px] bg-surface-2 p-3 text-ink-2 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
  <span className="font-semibold tnum text-ink">{credits.toLocaleString("en-US")}</span>
</div>
```

---

## 三、几何比例、排版与对齐纪律

1. **同心圆角公式**
   内外层嵌套容器必须满足 `R_outer = R_inner + padding`，消除拐角厚薄不均的视觉违和感：
   - 主分栏托盘：外托盘 `rounded-[20px]` = 内面板 `rounded-[14px]` + 托盘内边距 `p-1.5`（`6px`）。
   - 面板内卡片与列表行：`rounded-[10px]`，内部次级磁贴与按钮：`rounded-[7px]`–`rounded-[8px]`，微型档位徽标：`rounded-[5px]`。
2. **微描边优于粗实线**
   卡片、胶囊与徽标优先采用 `0.5px` `inset` 阴影描边（如 `shadow-[inset_0_0_0_0.5px_var(--line-strong)]`），并给选中态上的徽标保留 `var(--surface)` 混色衬底，避免徽标融进浅蓝选中背景。
3. **紧凑而呼吸清晰的桌面字阶**
   - `text-2xs`（`10.5px/14px`）：微型徽标、次级单位（`CU`）、辅助角标。
   - `text-xs`（`11.5px/16px`）：表头、胶囊文字、副行备注、时间戳。
   - `text-sm`（`12.5px/18px`）：按钮、菜单项、正文与列表指标数值。
   - `text-base`（`13px/20px`）– `text-md`（`14px/20px`）：列表主邮箱（`13.5px`）、卡片标题。
   - `text-lg`（`16px`）– `text-xl`（`20px`）：详情页核心算力大字与 2FA 大号验证码。
4. **同轴激光对齐与数字格式化**
   - **数值右对齐 + `tnum`**：列表中的 `Flow`、`Colab`、`赠金`、`账期`、`额度百分比` 与吸顶表头共享同一套像素列宽与内边距，确保表头与数值 0px 垂直对齐。
   - **精确整数优先**：十万以内的积分与算力展示完整千分位（如 `10,050`、`24,500`），不随意四舍五入为 `10.1k` 吞掉有效变动信息。
   - **状态圆点同轴**：列表「状态」列中，常态 `• 已改密` 的圆点左边距需与告警 `Pill` 内的圆点保持同一垂直线，扫视百行不跳眼。

---

## 四、动效体系与原语复用

1. **唯一动效源（`frontend/src/lib/motion.ts`）**
   - `spring.press`：按钮点按微缩回弹（常规 `0.97`、小图标 `0.93`；列表行与菜单项只变底色不缩放）。
   - `spring.snap`：分段滑块、列表选中框滑动、面板高度自适应，近临界阻尼不过冲。
   - `spring.pop` / `popIn`：Popover、菜单、命令面板从锚点轻快弹出（约 `160ms`）。
   - `spring.glide`：抽屉与模态面板进出场。
   - `fade.in` / `fade.out`：退场（`100ms`）始终快于进场（`150ms`），操作干脆不拖泥带水。
2. **原语先行（改业务前先查 `frontend/src/ui/`）**
   - `ui/button.tsx`：`Button`、`IconButton`、`CopyButton`、`Tooltip`、`Kbd`
   - `ui/display.tsx`：`Avatar`、`Pill`、`TierBadge`、`TagChip`、`QuotaBar`、`TotpDigits`、`TotpRing`、`RollingNumber`
   - `ui/form.tsx`：`Segmented`、`Switch`、`Field`
   - `ui/overlay.tsx`：`Popover`、`Menu`、`ConfirmPop`、`Drawer`、`Sheet`
   - `ui/toaster.tsx`：全局 `Toaster`（配合 `lib/toast.ts`）
