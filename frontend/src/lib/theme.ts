import { useEffect, useState } from "react";
import { post } from "./bridge";

export type ThemePref = "system" | "light" | "dark";

const KEY = "gam-theme";

export function getThemePref(): ThemePref {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function syncNativeShell(pref: ThemePref) {
  post(`theme:${pref}`);
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  post(`dwm:${dark ? "dark" : "light"}`);
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  syncNativeShell(pref);
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* 忽略 */
  }
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.append(style);
  apply(pref);
  requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
  window.dispatchEvent(new Event("gam-theme"));
}

/** 主窗口和小窗共享外观：另一个窗口改了或系统深浅色切换时，两边与原生外壳标题栏同步更新。 */
export function useThemePref(): ThemePref {
  const [pref, setPref] = useState(getThemePref);
  useEffect(() => {
    apply(getThemePref());
    const sync = () => {
      const p = getThemePref();
      apply(p);
      setPref(p);
    };
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => syncNativeShell(getThemePref());
    window.addEventListener("storage", sync);
    window.addEventListener("gam-theme", sync);
    mq.addEventListener("change", onMq);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("gam-theme", sync);
      mq.removeEventListener("change", onMq);
    };
  }, []);
  return pref;
}
