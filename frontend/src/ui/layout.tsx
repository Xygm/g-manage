import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { spring } from "../lib/motion";
import { cx } from "./button";

/** 高度跟着内容走：首帧同步量取避免跳高，内容变化时外框用 snap 平滑撑开 / 收起。 */
export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    setH(el.offsetHeight);
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div initial={false} animate={{ height: h }} transition={spring.snap} className={cx("relative overflow-hidden", className)}>
      <div ref={inner} className="relative">
        {children}
      </div>
    </motion.div>
  );
}

/** 内嵌卡片：距外层表面 6px，圆角 8（14 = 8 + 6，同心）。 */
export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: "warn" | "danger" | "accent" }) {
  return (
    <section
      className={cx(
        "rounded-[8px] p-3 transition-colors duration-300",
        tone === "warn" ? "bg-warn-soft" : tone === "danger" ? "bg-danger-soft" : tone === "accent" ? "bg-accent-soft" : "bg-surface-2 shadow-[inset_0_0_0_0.5px_var(--line)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-6 items-center gap-2">
      <h3 className="flex-1 text-xs font-semibold tracking-[0.02em] text-ink-3">{children}</h3>
      {right}
    </div>
  );
}
