import type { TargetAndTransition, Transition } from "motion/react";

/**
 * 全项目唯一的一套动效参数。新增动画只能从这里取，不要在组件里另起曲线。
 *  press：按下回弹，干脆（常规 0.97、小图标 0.93；行与菜单项只变底色）
 *  snap ：位置 / 尺寸重排（分段滑块、选中高亮、标签增删、卡片撑开），近临界阻尼、不回弹
 *  pop  ：锚点弹层（菜单、⌘K、确认、提示），约 160ms
 *  glide：大面板进出（侧栏抽屉、对话框），约 320ms
 *  roll ：数字滚动（计数、天数），不过冲
 *  fade ：内容替换、图标交叉淡入；退场比进场快
 */
export const spring = {
  press: { type: "spring", stiffness: 700, damping: 40, mass: 0.6 } satisfies Transition,
  snap: { type: "spring", stiffness: 520, damping: 42, mass: 1 } satisfies Transition,
  pop: { type: "spring", stiffness: 550, damping: 38, mass: 0.8 } satisfies Transition,
  glide: { type: "spring", stiffness: 360, damping: 36, mass: 1 } satisfies Transition,
  roll: { type: "spring", stiffness: 460, damping: 42, mass: 0.8 } satisfies Transition,
} as const;

export const ease = [0.2, 0, 0, 1] as const;

export const fade = {
  in: { duration: 0.15, ease } satisfies Transition,
  out: { duration: 0.1, ease } satisfies Transition,
  bar: { duration: 0.28, ease } satisfies Transition,
} as const;

export const PRESS_SCALE = 0.97;
export const PRESS_SCALE_ICON = 0.93;

/** 锚点弹层：从触发点长出。 */
export const popIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: spring.pop },
  exit: { opacity: 0, scale: 0.97, transition: fade.out },
};

/** 面板与卡片内容切换：纯透明度，避免大面积高斯模糊掉帧。 */
export const swap = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade.in },
  exit: { opacity: 0, transition: fade.out },
};

/** 图标瞬态切换：轻缩放 + 淡入淡出，干脆不糊。 */
export const swapIcon = {
  initial: { opacity: 0, scale: 0.72 },
  animate: { opacity: 1, scale: 1, transition: fade.in },
  exit: { opacity: 0, scale: 0.72, transition: fade.out },
};

/** 输错时横向轻抖。 */
export const shake: TargetAndTransition = { x: [0, -6, 6, -4, 4, 0], transition: { duration: 0.28, ease: "easeOut" } };
