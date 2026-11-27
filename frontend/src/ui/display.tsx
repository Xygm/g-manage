import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useState } from "react";
import { fade, spring } from "../lib/motion";
import { isPaidTier, isUltraTier, level, pct, tierLabel } from "../lib/format";
import { cx } from "./button";

/* ───────── 数字滚动（计数、天数）：只滚变化的那一位，等宽不跳 ───────── */

export function RollingNumber({ value, className }: { value: number; className?: string }) {
  const chars = String(value).split("");
  return (
    <span className={cx("tnum inline-flex overflow-hidden", className)} aria-label={String(value)} style={{ height: "1lh" }}>
      {chars.map((c, i) => (
        <Digit key={chars.length - i} d={Number(c)} />
      ))}
    </span>
  );
}

function Digit({ d }: { d: number }) {
  return (
    <span className="relative inline-block w-[1ch]" aria-hidden style={{ height: "1lh" }}>
      <motion.span className="absolute inset-x-0 top-0 flex flex-col" initial={false} animate={{ y: `${-d * 10}%` }} transition={spring.roll}>
        {Array.from({ length: 10 }, (_, n) => (
          <span key={n} className="block text-center" style={{ height: "1lh" }}>
            {n}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

/* ───────── 状态胶囊：只在需要注意时上色 ───────── */

export type PillTone = "warn" | "danger" | "neutral" | "ok" | "accent" | "violet";

const pillTone: Record<PillTone, string> = {
  warn: "bg-warn-soft text-warn shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--warn)_22%,transparent)]",
  danger: "bg-danger-soft text-danger shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--danger)_22%,transparent)]",
  neutral: "bg-fill text-ink-2",
  ok: "text-ink-3",
  accent: "bg-accent-soft text-accent shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--accent)_24%,transparent)]",
  violet: "bg-violet-soft text-violet shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--violet)_24%,transparent)]",
};
const dotTone: Record<PillTone, string> = {
  warn: "bg-warn-dot",
  danger: "bg-danger-dot",
  neutral: "bg-ink-3",
  ok: "bg-ok-dot",
  accent: "bg-accent",
  violet: "bg-violet",
};

export function Pill({ tone, children, dot, progress, className, title }: { tone: PillTone; children: React.ReactNode; dot?: boolean; progress?: number; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium", pillTone[tone], className)}>
      {progress !== undefined ? <MiniRing value={progress} /> : dot ? <span className={cx("size-1.5 shrink-0 rounded-full", dotTone[tone])} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** 风控进度小环：已过的比例。 */
export function MiniRing({ value, size = 12 }: { value: number; size?: number }) {
  const r = size / 2 - 1.5;
  const len = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={len}
        initial={false}
        animate={{ strokeDashoffset: len * (1 - Math.max(0, Math.min(1, value))) }}
        transition={fade.bar}
      />
    </svg>
  );
}

/* ───────── 额度条：宽度用 scaleX，只动 transform ───────── */

const barColor = { zero: "bg-danger-dot", low: "bg-warn-dot", ok: "bg-[var(--bar-ok,var(--accent))]" } as const;

export function QuotaBar({ fraction, thin, className, label }: { fraction: number | null; thin?: boolean; className?: string; label?: string }) {
  const p = fraction === null ? 0 : pct(fraction);
  const lv = fraction === null ? "ok" : level(p);
  const scale = Math.max(p, p > 0 ? 3 : 0) / 100;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : p}
      className={cx(
        "relative block overflow-hidden rounded-full bg-fill shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.07)]",
        thin ? "h-[4.5px]" : "h-1.5",
        className,
      )}
    >
      {fraction !== null && (
        <span
          style={{ transform: `scaleX(${scale})` }}
          className={cx(
            "absolute inset-y-0 left-0 w-full origin-left rounded-full transition-transform duration-[280ms] ease-[var(--ease-out)] motion-reduce:transition-none",
            barColor[lv],
          )}
        />
      )}
    </span>
  );
}

/* ───────── 2FA：倒计时环（纯 CSS）+ 换码时上移淡入 ───────── */

export const TotpRing = memo(function TotpRing({ periodEnd, period, size = 14 }: { periodEnd: number; period: number; size?: number }) {
  const r = size / 2 - 1.5;
  const len = 2 * Math.PI * r;
  const elapsed = Math.max(0, period - (periodEnd - Date.now() / 1000));
  const [expiring, setExpiring] = useState(false);
  useEffect(() => {
    const left = periodEnd - Date.now() / 1000;
    setExpiring(left <= 5);
    if (left > 5) {
      const t = setTimeout(() => setExpiring(true), (left - 5) * 1000);
      return () => clearTimeout(t);
    }
  }, [periodEnd]);
  if (!periodEnd) return null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx("shrink-0 -rotate-90 transition-colors duration-300", expiring ? "text-warn-dot" : "text-ink-3")} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle
        key={periodEnd}
        className="ring-drain"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        style={{ ["--len" as string]: len, ["--period" as string]: period, ["--elapsed" as string]: elapsed }}
      />
    </svg>
  );
});

export function TotpDigits({ code, className }: { code: string | undefined; className?: string }) {
  const text = code ? `${code.slice(0, 3)} ${code.slice(3)}` : "··· ···";
  return (
    <span className={cx("relative inline-grid overflow-hidden font-mono tnum", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={text}
          initial={{ y: 6, opacity: 0 }}
          animate={{ y: 0, opacity: 1, transition: spring.snap }}
          exit={{ y: -6, opacity: 0, transition: fade.out }}
          className="col-start-1 row-start-1 whitespace-pre"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ───────── 头像 ───────── */

const avatarHues = ["#5b8def", "#9b6cf0", "#2fb37a", "#e8a23a", "#e2637b", "#2bb3c8", "#ef7d3c", "#6474e5"];

export function Avatar({ src, email, size = 28, className }: { src?: string; email: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const base = avatarHues[h % avatarHues.length];
  const style = { width: size, height: size, fontSize: size * 0.42 };
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className={cx("shrink-0 rounded-full object-cover shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgb(0_0_0/0.06)]", className)}
        style={style}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-full font-semibold uppercase text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_0_0_0_0.5px_rgb(0_0_0/0.12)] [text-shadow:0_0.5px_1px_rgb(0_0_0/0.16)]",
        className,
      )}
      style={{
        ...style,
        background: `linear-gradient(155deg, color-mix(in srgb, ${base} 80%, white), ${base} 56%, color-mix(in srgb, ${base} 86%, black))`,
      }}
    >
      {email.charAt(0)}
    </span>
  );
}

/** 会员档位微徽标：带表面衬底与 0.5px 内描边，在浅蓝选中行上依然边界分明不融化。 */
export function TierBadge({ tier, className }: { tier: string; className?: string }) {
  if (!isPaidTier(tier)) return null;
  const ultra = isUltraTier(tier);
  return (
    <span
      className={cx(
        "inline-flex h-[17px] shrink-0 items-center rounded-[5px] px-1 text-2xs font-semibold leading-none tracking-[0.01em]",
        ultra
          ? "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--violet)_16%,var(--surface)),color-mix(in_srgb,var(--violet)_9%,var(--surface)))] text-violet shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--violet)_32%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--accent)_11%,var(--surface))] text-accent shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--accent)_30%,transparent)]",
        className,
      )}
    >
      {tierLabel(tier)}
    </span>
  );
}

/* ───────── 标签色 ───────── */

export const TAG_HUES = [
  { id: "blue", label: "海蓝" },
  { id: "violet", label: "鸢尾紫" },
  { id: "emerald", label: "翡翠绿" },
  { id: "amber", label: "琥珀黄" },
  { id: "rose", label: "珊瑚红" },
  { id: "cyan", label: "青碧" },
  { id: "orange", label: "暖橙" },
  { id: "indigo", label: "靛青" },
] as const;

/** 语义优先 + 哈希兜底；用户指定过颜色时以用户为准。 */
export function autoTagHue(tag: string): string {
  const s = tag.trim().toLowerCase();
  if (!s) return "blue";
  if (/ultra|pro|vip|会员|订阅|付费|plus/.test(s)) return "violet";
  if (/jio|印|india|土|尼|巴/.test(s)) return "amber";
  if (/美|us|自注|自建|主力|正常|稳/.test(s)) return "emerald";
  if (/kyc|风控|异常|封|申诉|急|重/.test(s)) return "rose";
  if (/日|jp|新|sg|港|台|韩|欧|英|家庭/.test(s)) return "cyan";
  if (/买|渠道|qq|咸鱼|号商|批/.test(s)) return "orange";
  if (/free|免|白嫖|测试|备/.test(s)) return "blue";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return TAG_HUES[(h >>> 0) % TAG_HUES.length].id;
}

export function tagHue(tag: string, custom?: Record<string, string>): string {
  const key = tag.trim().toLowerCase();
  return custom?.[key] || autoTagHue(key);
}

export function TagChip({ tag, hue, active, onClick, className, children }: { tag: string; hue: string; active?: boolean; onClick?: (e: React.MouseEvent) => void; className?: string; children?: React.ReactNode }) {
  const El = onClick ? "button" : "span";
  return (
    <El
      type={onClick ? "button" : undefined}
      data-hue={hue}
      onClick={onClick}
      className={cx(
        "tag inline-flex h-5 max-w-[9rem] shrink-0 items-center gap-1 rounded-full pl-1.5 pr-2 text-xs font-medium transition-[box-shadow,background-color] duration-[120ms]",
        active && "tag-active",
        className,
      )}
    >
      <span className="tag-dot size-1.5 shrink-0 rounded-full" />
      <span className="truncate">{tag}</span>
      {children}
    </El>
  );
}
