import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { fade, spring } from "../lib/motion";
import { RollingNumber } from "./display";
import { cx } from "./button";

/* ───────── 输入框 ───────── */

export const inputCls =
  "h-8 rounded-[10px] bg-fill px-3 text-base text-ink placeholder:text-ink-3 outline-none transition-[box-shadow,background-color] duration-[120ms] focus:bg-surface focus:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-soft)] aria-[invalid=true]:shadow-[0_0_0_1px_var(--danger),0_0_0_4px_var(--danger-soft)]";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; wide?: boolean }>(function TextInput(
  { className, mono, wide = true, ...rest },
  ref,
) {
  return <input ref={ref} spellCheck={false} autoComplete="off" className={cx(inputCls, wide && "w-full", mono && "font-mono text-sm", className)} {...rest} />;
});

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.p key="e" role="alert" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }} className="text-xs text-danger">
            {error}
          </motion.p>
        ) : hint ? (
          <motion.p key="h" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }} className="text-xs text-ink-3">
            {hint}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ───────── 开关：拨片按下微微拉宽 ───────── */

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200", checked ? "bg-ok-dot" : "bg-fill-strong", disabled && "opacity-40")}
    >
      <motion.span
        layout
        transition={spring.snap}
        whileTap={{ width: 22 }}
        className="block h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.2),0_0_0_0.5px_rgb(0_0_0/0.04)]"
        style={{ marginLeft: checked ? "auto" : 0 }}
      />
    </button>
  );
}

/* ───────── 分段控件：独立 LayoutGroup + 共享分割线 + 滑块（HeroUI × BoardUI） ───────── */

export interface SegItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  tone?: "warn" | "danger";
  title?: string;
}

export function Segmented<T extends string>({
  items, value, onChange, id, size = "md", className, full,
}: {
  items: SegItem<T>[];
  value: T;
  onChange: (v: T) => void;
  id: string;
  size?: "sm" | "md";
  className?: string;
  full?: boolean;
}) {
  const onKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex((x) => x.value === value);
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + items.length) % items.length;
    else return;
    e.preventDefault();
    onChange(items[n].value);
    (e.currentTarget.querySelectorAll("button")[n] as HTMLButtonElement)?.focus();
  };
  return (
    <LayoutGroup id={`seg-group-${id}`}>
      <div role="radiogroup" onKeyDown={onKey} className={cx("relative inline-flex rounded-[12px] bg-fill p-[3px]", full && "flex w-full", className)}>
        {items.map((it, i) => {
          const active = it.value === value;
          const prevActive = i > 0 && items[i - 1].value === value;
          return (
            <button
              key={it.value}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              title={it.title}
              onClick={() => onChange(it.value)}
              className={cx(
                "relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-accent",
                size === "sm" ? "h-6 px-2.5 text-xs" : "h-7 px-3 text-sm",
                full && "flex-1",
                active ? "text-ink" : "text-ink-2 hover:text-ink",
              )}
            >
              {/* 共享分割线：选中项和它左右两侧都不画 */}
              {i > 0 && <span aria-hidden className={cx("absolute left-0 top-1/2 h-3.5 w-px -translate-y-1/2 bg-line-strong transition-opacity duration-[120ms]", (active || prevActive) && "opacity-0")} />}
              {active && <motion.span layoutId={`seg-${id}`} transition={spring.snap} className="absolute inset-0 rounded-[9px] bg-[var(--seg-thumb)] shadow-thumb" />}
              <span className="relative flex items-center gap-1.5">
                {it.tone && it.count ? <span className={cx("size-1.5 rounded-full", it.tone === "warn" ? "bg-warn-dot" : "bg-danger-dot")} /> : null}
                {it.label}
                {it.count !== undefined && <RollingNumber value={it.count} className={cx("text-xs", active ? "text-ink-2" : "text-ink-3")} />}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

/* ───────── 撑开 / 收起（高度用 snap，内容淡入） ───────── */

export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: { height: spring.snap, opacity: fade.in } }}
          exit={{ height: 0, opacity: 0, transition: { height: { ...spring.snap, stiffness: 620 }, opacity: fade.out } }}
          className={cx("overflow-hidden", className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
