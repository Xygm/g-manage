import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PRESS_SCALE, PRESS_SCALE_ICON, fade, spring, swapIcon } from "../lib/motion";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

/* ───────── 按钮 ───────── */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft" | "warn";
type Size = "xs" | "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.12)]",
  secondary: "bg-surface text-ink shadow-raised",
  ghost: "text-ink-2",
  soft: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  danger: "text-danger",
};
const variantHovers: Record<Variant, string> = {
  primary: "hover:bg-accent-hover",
  secondary: "hover:bg-surface-2",
  ghost: "hover:bg-fill hover:text-ink",
  soft: "hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]",
  warn: "hover:bg-[color-mix(in_srgb,var(--warn-dot)_22%,transparent)]",
  danger: "hover:bg-danger-soft",
};
const sizes: Record<Size, string> = {
  xs: "h-6 px-2 gap-1 text-xs rounded-[7px]",
  sm: "h-7 px-2.5 gap-1.5 text-sm rounded-[8px]",
  md: "h-8 px-3 gap-1.5 text-base rounded-[10px]",
};
const iconSize: Record<Size, number> = { xs: 13, sm: 14, md: 15 };

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  busy?: boolean;
  kbd?: string;
  children?: ReactNode;
}

/**
 * 所有按钮：按下 0.97 回弹；忙碌时宽度不变、图标切换为转圈。
 * 禁用时用 aria-disabled 保留指针事件，让悬停解释（如为什么不能点）始终可见。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", icon: Icon, busy, kbd, children, className, disabled, onClick, onKeyDown, type = "button", ...rest },
  ref,
) {
  const s = iconSize[size];
  const inert = !!(disabled || busy);
  return (
    <motion.button
      ref={ref}
      type={type}
      whileTap={inert ? undefined : { scale: PRESS_SCALE }}
      transition={spring.press}
      aria-disabled={inert || undefined}
      aria-busy={busy || undefined}
      tabIndex={disabled ? -1 : rest.tabIndex}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onClick?.(e);
      }}
      onKeyDown={(e) => {
        if (inert && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onKeyDown?.(e);
      }}
      className={cx(
        "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,box-shadow,opacity] duration-[120ms]",
        variants[variant],
        !inert && variantHovers[variant],
        sizes[size],
        disabled && "opacity-45",
        className,
      )}
      {...rest}
    >
      {(Icon || busy) && (
        <span className="relative grid place-items-center" style={{ width: s, height: s }}>
          <AnimatePresence initial={false} mode="popLayout">
            {busy ? (
              <motion.span key="busy" {...swapIcon} className="absolute inset-0 grid place-items-center">
                <Spinner size={s} />
              </motion.span>
            ) : Icon ? (
              <motion.span key="icon" {...swapIcon} className="absolute inset-0 grid place-items-center">
                <Icon size={s} strokeWidth={1.9} />
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>
      )}
      {children != null && <span>{children}</span>}
      {kbd && <Kbd className={cx("ml-0.5", variant === "primary" ? "!bg-white/22 !text-white" : "opacity-75")}>{kbd}</Kbd>}
    </motion.button>
  );
});

export interface IconButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  icon: LucideIcon;
  label: string;
  kbd?: string;
  size?: Size;
  tone?: "default" | "danger" | "accent";
  active?: boolean;
  busy?: boolean;
  tip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, kbd, size = "sm", tone = "default", active, busy, tip = true, className, disabled, onClick, ...rest },
  ref,
) {
  const dim = size === "xs" ? "size-6 rounded-[7px]" : size === "sm" ? "size-7 rounded-[8px]" : "size-8 rounded-[10px]";
  const s = iconSize[size] + 1;
  const inert = !!(disabled || busy);
  const btn = (
    <motion.button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      aria-disabled={inert || undefined}
      tabIndex={disabled ? -1 : rest.tabIndex}
      whileTap={inert ? undefined : { scale: PRESS_SCALE_ICON }}
      transition={spring.press}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onClick?.(e);
      }}
      className={cx(
        "relative inline-grid shrink-0 place-items-center transition-[background-color,color,opacity] duration-[120ms]",
        dim,
        tone === "danger"
          ? cx("text-ink-3", !inert && "hover:bg-danger-soft hover:text-danger")
          : tone === "accent"
            ? cx("text-accent", !inert && "hover:bg-accent-soft")
            : cx("text-ink-2", !inert && "hover:bg-fill hover:text-ink"),
        active && "bg-fill text-ink",
        disabled && "opacity-40",
        className,
      )}
      {...rest}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {busy ? (
          <motion.span key="b" {...swapIcon} className="grid place-items-center">
            <Spinner size={s - 1} />
          </motion.span>
        ) : (
          <motion.span key="i" {...swapIcon} className="grid place-items-center">
            <Icon size={s} strokeWidth={1.8} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
  return tip ? (
    <Tooltip label={label} kbd={kbd}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
});

/* ───────── 复制：图标变勾、1.2 秒复原（全项目统一） ───────── */

export function useFlash(ms = 1200): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return [
    on,
    () => {
      setOn(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setOn(false), ms);
    },
  ];
}

export function CopyButton({
  onCopy,
  label,
  size = "xs",
  copied,
  className,
}: {
  onCopy: () => Promise<boolean> | boolean;
  label: string;
  size?: Size;
  copied?: boolean;
  className?: string;
}) {
  const [ownDone, flash] = useFlash();
  const done = copied ?? ownDone;
  const s = iconSize[size] + 1;
  return (
    <Tooltip label={done ? "已复制" : label}>
      <motion.button
        type="button"
        aria-label={label}
        whileTap={{ scale: 0.9 }}
        transition={spring.press}
        onClick={async (e) => {
          e.stopPropagation();
          if (await onCopy()) flash();
        }}
        className={cx(
          "relative inline-grid shrink-0 place-items-center transition-colors duration-[120ms]",
          size === "xs" ? "size-6 rounded-[7px]" : "size-7 rounded-[8px]",
          done ? "text-ok" : "text-ink-3 hover:bg-fill hover:text-ink",
          className,
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {done ? (
            <motion.span
              key="ok"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1, transition: spring.press }}
              exit={{ scale: 0.6, opacity: 0, transition: fade.out }}
              className="grid place-items-center"
            >
              <Check size={s} strokeWidth={2.4} />
            </motion.span>
          ) : (
            <motion.span key="cp" {...swapIcon} className="grid place-items-center">
              <Copy size={s - 1} strokeWidth={1.8} />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </Tooltip>
  );
}

/* ───────── 小件 ───────── */

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={cx("spin", className)} aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.75" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-fill px-1 font-sans text-2xs font-medium text-ink-3", className)}>
      {children}
    </kbd>
  );
}

/* ───────── 悬停提示：延迟出现、连续悬停时立即切换 ───────── */

let lastTipHide = 0;

export function Tooltip({ label, kbd, children, side = "bottom" }: { label: ReactNode; kbd?: string; children: React.ReactElement; side?: "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = () => {
    clearTimeout(timer.current);
    const warm = Date.now() - lastTipHide < 400;
    timer.current = setTimeout(() => setOpen(true), warm ? 0 : 480);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (open) lastTipHide = Date.now();
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const el = wrap.current.firstElementChild as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = side === "bottom" && r.bottom + 40 > window.innerHeight ? "top" : side === "top" && r.top < 40 ? "bottom" : side;
    const x = Math.max(12, Math.min(window.innerWidth - 12, r.left + r.width / 2));
    setPos({ x, y: s === "bottom" ? r.bottom + 6 : r.top - 6, side: s });
  }, [open, side]);

  return (
    <span ref={wrap} className="contents" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide} onFocus={(e) => e.target.matches(":focus-visible") && show()} onBlur={hide}>
      {children}
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              role="tooltip"
              initial={{ opacity: 0, y: pos.side === "bottom" ? -3 : 3 }}
              animate={{ opacity: 1, y: 0, transition: fade.in }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              className="pointer-events-none fixed z-[100] flex max-w-[min(320px,calc(100vw-16px))] items-center gap-1.5 rounded-[7px] bg-[color-mix(in_srgb,var(--text)_92%,transparent)] px-2 py-1 text-xs font-medium text-[var(--surface)] shadow-pop backdrop-blur"
              style={{ left: pos.x, top: pos.y, translateX: "-50%", translateY: pos.side === "top" ? "-100%" : 0 }}
            >
              <span className="truncate">{label}</span>
              {kbd && <span className="shrink-0 opacity-65">{kbd}</span>}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}
