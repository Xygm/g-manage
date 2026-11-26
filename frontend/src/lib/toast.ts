import { createStore } from "./store";

export type Tone = "ok" | "err" | "info";

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
  action?: { label: string; run: () => void };
  duration: number;
}

export const toasts = createStore<{ list: Toast[] }>({ list: [] });

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function push(tone: Tone, text: string, opts: { action?: Toast["action"]; duration?: number } = {}): number {
  const duration = opts.duration ?? (tone === "err" ? 6000 : opts.action ? 8000 : 2600);
  const list = toasts.get().list;
  // 同样的话不重复堆叠：刷新已有那条的计时。
  const same = list.find((t) => t.text === text && t.tone === tone && !t.action && !opts.action);
  if (same) {
    schedule(same.id, duration);
    return same.id;
  }
  const id = ++seq;
  // 成功提示只留最新一条；总数最多 3 条。带「撤销」的提示不会被后来的顶掉。
  let next = tone === "ok" && !opts.action ? list.filter((t) => t.tone !== "ok" || t.action) : [...list];
  next.push({ id, tone, text, action: opts.action, duration });
  while (next.length > 3) {
    const victim = next.find((t) => !t.action && t.id !== id) ?? next[0];
    clearTimeout(timers.get(victim.id));
    next = next.filter((t) => t !== victim);
  }
  toasts.set({ list: next });
  schedule(id, duration);
  return id;
}

function schedule(id: number, ms: number) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismiss(id), ms));
}

export function dismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

/** 鼠标停在提示上时暂停计时，离开后重新计时。 */
export function holdToast(id: number, hold: boolean) {
  const t = toasts.get().list.find((x) => x.id === id);
  if (!t) return;
  if (hold) clearTimeout(timers.get(id));
  else schedule(id, Math.max(2000, t.duration / 2));
}

export const toast = {
  ok: (text: string, opts?: { action?: Toast["action"]; duration?: number }) => push("ok", text, opts),
  err: (text: string, opts?: { action?: Toast["action"]; duration?: number }) => push("err", text, opts),
  info: (text: string, opts?: { action?: Toast["action"]; duration?: number }) => push("info", text, opts),
};

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
