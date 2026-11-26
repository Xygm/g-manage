import type { Account, QuotaInfo } from "./types";

/* ───────── 时间 ───────── */

export function toDate(s: string | number): Date | null {
  const d = typeof s === "number" ? new Date(s * 1000) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtTime(s: string | number): string {
  const d = toDate(s);
  return d ? d.toLocaleString("zh-CN", { hour12: false }) : "";
}

export function fromNow(s: string | number, now = Date.now()): string {
  const d = toDate(s);
  if (!d) return "";
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "刚刚";
  const [n, unit] = abs < 3600 ? [Math.round(abs / 60), "分钟"] : abs < 86400 ? [Math.round(abs / 3600), "小时"] : [Math.round(abs / 86400), "天"];
  return diff < 0 ? `${n} ${unit}前` : `${n} ${unit}后`;
}

/** 额度重置倒计时：超过一天「6天14时」，否则「2时05分」。 */
export function fmtCountdown(s: string, now = Date.now()): string {
  const d = toDate(s);
  if (!d) return "";
  const left = Math.floor((d.getTime() - now) / 60000);
  if (left <= 0) return "即将重置";
  const days = Math.floor(left / 1440);
  const hours = Math.floor((left % 1440) / 60);
  const mins = left % 60;
  if (days) return `${days}天${hours}时`;
  if (hours) return `${hours}时${String(mins).padStart(2, "0")}分`;
  return `${mins}分`;
}

export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ───────── 额度 ───────── */

export type Pool = "gemini" | "claude";

export function poolOf(groupName: string): Pool {
  return /claude|gpt/i.test(groupName) ? "claude" : "gemini";
}

export function shortGroupName(name: string): string {
  const n = (name || "").trim();
  if (/^gemini\s+models$/i.test(n)) return "Gemini";
  if (/^claude\s+and\s+gpt\s+models$/i.test(n)) return "Claude / GPT";
  return n.replace(/\s+models$/i, "") || "默认";
}

export const windowLabel = (w: string) => (w === "5h" ? "5 小时" : w === "weekly" ? "每周" : w);

/** 某个额度池在各窗口中最低的剩余比例（0–1），没有数据返回 null。 */
export function poolRemaining(q: QuotaInfo | null, pool: Pool): number | null {
  if (!q) return null;
  let min: number | null = null;
  for (const g of q.groups || []) {
    if (poolOf(g.display_name) !== pool) continue;
    for (const b of g.buckets || []) min = min === null ? b.remaining_fraction : Math.min(min, b.remaining_fraction);
  }
  return min;
}

export function pct(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

export type Level = "zero" | "low" | "ok";
export function level(p: number): Level {
  return p <= 0 ? "zero" : p < 20 ? "low" : "ok";
}

export function tierLabel(tier: string): string {
  const t = (tier || "").toUpperCase();
  return t === "FREE" ? "Free" : t === "PRO" ? "Pro" : t === "ULTRA" ? "Ultra" : t === "ENTERPRISE" ? "Enterprise" : tier;
}

/** 把后端存下的原始报错翻译成人话，并提取需要去 Google 验证的链接。 */
export function humanQuotaError(raw: string): { text: string; verifyUrl: string; revoked: boolean } {
  if (!raw) return { text: "", verifyUrl: "", revoked: false };
  let s = String(raw).trim();
  if (s.includes("授权已失效")) return { text: "授权已过期，重新授权一次就好", verifyUrl: "", revoked: true };
  if (s.includes("SUBSCRIPTION_REQUIRED") || s.includes("#3501")) {
    return { text: "这个号没有可用的免费额度资格，常见原因是代理节点或账号所在地区不受支持", verifyUrl: "", revoked: false };
  }
  const brace = s.indexOf("{");
  if (brace >= 0 && s.includes('"error"')) {
    try {
      const parsed = JSON.parse(s.slice(brace));
      const err = parsed?.error;
      if (err?.message) s = `Google 返回：${err.message}`;
    } catch {
      /* 保留原文 */
    }
  }
  const m = s.match(/https:\/\/(?:[a-z0-9-]+\.)*google\.com\/[^\s)"]*/i);
  const verifyUrl = m && s.includes("VALIDATION_REQUIRED") ? m[0] : "";
  if (verifyUrl) return { text: "Google 要求先验证一下这个号", verifyUrl, revoked: false };
  if (/proxyconnect|dial tcp|timeout|deadline|connection refused|no such host/i.test(s)) {
    return { text: "连不上 Google，检查一下代理设置", verifyUrl: "", revoked: false };
  }
  return { text: s.length > 140 ? `${s.slice(0, 140)}…` : s, verifyUrl: "", revoked: false };
}

/* ───────── 搜索 ───────── */

export function matchesQuery(a: Account, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return a.email.includes(s) || a.note.toLowerCase().includes(s) || a.tags.some((t) => t.toLowerCase().includes(s));
}

/** 简单模糊打分：前缀 > 包含 > 子序列。 */
export function fuzzyScore(text: string, q: string): number {
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (!s) return 1;
  if (t.startsWith(s)) return 100 - t.length * 0.01;
  const i = t.indexOf(s);
  if (i >= 0) return 60 - i * 0.1;
  let ti = 0;
  for (const ch of s) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return 0;
    ti++;
  }
  return 20;
}
