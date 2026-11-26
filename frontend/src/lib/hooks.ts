import { useEffect, useState } from "react";

/** 每隔一段时间重渲染一次（倒计时文字用），默认对齐到整秒。 */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      t = setTimeout(tick, ms - (Date.now() % ms) + 5);
    };
    t = setTimeout(tick, ms - (Date.now() % ms) + 5);
    return () => clearTimeout(t);
  }, [ms]);
  return now;
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

/** 当前焦点是否在可输入的地方（快捷键要让路）。 */
export function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export function hasTextSelection(): boolean {
  const s = window.getSelection();
  return !!s && !s.isCollapsed && s.toString().length > 0;
}
