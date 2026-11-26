// 页面与原生外壳之间的桥：Windows 是 WebView2 的 chrome.webview，macOS 是 WKWebView 的 messageHandlers。

declare global {
  interface Window {
    chrome?: { webview?: { postMessage: (m: string) => void } };
    webkit?: { messageHandlers?: { gam?: { postMessage: (m: string) => void } } };
    gamShell?: string;
    gamMini?: { onShow: () => void; onHide: () => void };
  }
}

const root = document.documentElement;

export const shell = root.dataset.shell || "web"; // mac | win | web | web-mac
export const isMac = root.dataset.os === "mac";
export const isNativeMac = shell === "mac";
export const isNative = shell === "mac" || shell === "win";

/** 快捷键修饰符显示：mac ⌘，其它 Ctrl。 */
export const modKey = isMac ? "⌘" : "Ctrl";
export const modLabel = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`);

export function post(cmd: string): boolean {
  const mac = window.webkit?.messageHandlers?.gam;
  if (mac) {
    mac.postMessage(cmd);
    return true;
  }
  const win = window.chrome?.webview;
  if (win) {
    win.postMessage(cmd);
    return true;
  }
  return false;
}

/** 复制文本：优先用剪贴板 API，WKWebView 偶发拒绝时走原生兜底。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    if (post(`clip:${text}`)) return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("系统不允许写入剪贴板");
}

/** mac 透明标题栏：在页面顶栏空白处按下即拖动窗口，双击缩放。 */
export function bindTitlebar(el: HTMLElement | null) {
  if (!el || !isNativeMac) return;
  const interactive = (t: EventTarget | null) =>
    t instanceof Element && !!t.closest("button, a, input, textarea, select, [role=button], [data-no-drag]");
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || interactive(e.target)) return;
    if (e.detail === 2) post("window:zoom");
    else post("window:drag");
  });
}
