import { AnimatePresence, motion, useDragControls, useMotionValue, useTransform, animate as animateValue, type PanInfo } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { fade, popIn, spring } from "../lib/motion";
import { Button, IconButton, Kbd, cx } from "./button";

/* ───────── 锚点弹层：从触发点长出，关闭时保留坐标完整播放退场 ───────── */

type Placement = "bottom-start" | "bottom-end" | "bottom" | "top-start" | "top-end";

export function Popover({
  open, onClose, anchor, placement = "bottom-end", children, className, offset = 6, matchWidth, initialFocus = true,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  placement?: Placement;
  children: ReactNode;
  className?: string;
  offset?: number;
  matchWidth?: boolean;
  initialFocus?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string; width?: number } | null>(null);
  const focusedOnce = useRef(false);

  useLayoutEffect(() => {
    if (!open) {
      focusedOnce.current = false;
      // 保留最后一次坐标，让 AnimatePresence 在原位播放退场，避免瞬移闪烁。
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const w = matchWidth ? a.width : p.offsetWidth;
      const h = p.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let up = placement.startsWith("top");
      if (!up && a.bottom + offset + h > vh - 8 && a.top - offset - h > 8) up = true;
      if (up && a.top - offset - h < 8 && a.bottom + offset + h < vh - 8) up = false;
      let left = placement.endsWith("start") ? a.left : placement.endsWith("end") ? a.right - w : a.left + a.width / 2 - w / 2;
      left = Math.max(8, Math.min(vw - w - 8, left));
      const top = up ? a.top - offset - h : a.bottom + offset;
      const ox = Math.max(0, Math.min(w, a.left + a.width / 2 - left));
      setPos({ left, top: Math.max(8, top), origin: `${ox}px ${up ? "100%" : "0%"}`, width: matchWidth ? a.width : undefined });
    };
    place();
    const ro = new ResizeObserver(place);
    if (panel.current) ro.observe(panel.current);
    return () => ro.disconnect();
  }, [open, anchor, placement, offset, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    const scroll = (e: Event) => {
      if (panel.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("gam-mini-hide", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("gam-mini-hide", onClose);
    };
  }, [open, onClose, anchor]);

  useEffect(() => {
    if (open && pos && initialFocus && !focusedOnce.current) {
      focusedOnce.current = true;
      const el = panel.current?.querySelector<HTMLElement>("[data-autofocus], [data-menuitem]:not([disabled]), input, button:not([disabled]):not([aria-disabled=true])");
      el?.focus({ preventScroll: true });
    }
  }, [open, pos, initialFocus]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          {...popIn}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, transformOrigin: pos?.origin, width: pos?.width, visibility: pos ? "visible" : "hidden" }}
          className={cx("fixed z-50 rounded-[12px] bg-surface p-1 shadow-pop", className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ───────── 菜单：方向键移动、回车选择；菜单项只变底色不缩放 ───────── */

export interface MenuItem {
  icon?: LucideIcon;
  label: string;
  hint?: string;
  kbd?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

export function Menu({ items, onClose, className }: { items: (MenuItem | "sep")[]; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-menuitem]:not([disabled])") ?? [])];
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let n = i;
    if (e.key === "ArrowDown") n = (i + 1) % list.length;
    else if (e.key === "ArrowUp") n = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = list.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    } else return;
    e.preventDefault();
    list[n]?.focus();
  };
  const checkable = items.some((it) => it !== "sep" && it.checked !== undefined);
  return (
    <div ref={ref} role="menu" onKeyDown={onKey} className={cx("flex min-w-[200px] flex-col", className)}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={`s${i}`} className="mx-2 my-1 h-px bg-line" />
        ) : (
          <button
            key={it.label}
            type="button"
            role={checkable ? "menuitemradio" : "menuitem"}
            aria-checked={checkable ? !!it.checked : undefined}
            data-menuitem
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={cx(
              "flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-base outline-none transition-colors duration-[80ms]",
              it.danger ? "text-danger hover:bg-danger-soft focus-visible:bg-danger-soft" : "text-ink hover:bg-fill focus-visible:bg-fill",
              it.disabled && "opacity-40",
            )}
          >
            {checkable && <span className="grid w-[15px] place-items-center text-accent">{it.checked && <Check size={14} strokeWidth={2.4} />}</span>}
            {it.icon && <it.icon size={15} strokeWidth={1.8} className={it.danger ? "" : "text-ink-2"} />}
            <span className="flex-1 truncate">{it.label}</span>
            {it.hint && <span className="text-xs text-ink-3">{it.hint}</span>}
            {it.kbd && <Kbd>{it.kbd}</Kbd>}
          </button>
        ),
      )}
    </div>
  );
}

/* ───────── 原地确认：在触发按钮旁弹出，不打断整屏 ───────── */

export function ConfirmPop({
  open, onClose, anchor, title, message, confirmLabel, danger, onConfirm, placement = "bottom-end",
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  placement?: Placement;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} className="w-[300px] p-3.5">
      <div role="alertdialog" aria-label={title}>
        <p className="text-md font-semibold text-ink">{title}</p>
        {message && <p className="mt-1 text-sm text-ink-2">{message}</p>}
        <div className="mt-3.5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} data-autofocus={danger ? true : undefined}>
            取消
          </Button>
          <Button
            size="sm"
            variant={danger ? "secondary" : "primary"}
            className={danger ? "!text-danger" : ""}
            busy={busy}
            data-autofocus={danger ? undefined : true}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/* ───────── 对话框与焦点陷阱 ───────── */

export function useFocusTrap(open: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), textarea, button:not([disabled]):not([aria-disabled=true])");
      el?.focus({ preventScroll: true });
    }, 30);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>("input, textarea, button:not([disabled]):not([aria-disabled=true]), select, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", key);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, ref]);
}

export function Sheet({
  open, onClose, title, subtitle, children, footer, width = 520, dismissable = true, dirty = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissable?: boolean;
  dirty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useFocusTrap(open, ref);

  useEffect(() => {
    if (!open) setConfirmDiscard(false);
  }, [open]);

  const requestClose = () => {
    if (!dismissable) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable && !e.defaultPrevented && !confirmDiscard) {
        e.preventDefault();
        if (dirty) setConfirmDiscard(true);
        else onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose, dismissable, dirty, confirmDiscard]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40 grid place-items-center p-4 sm:p-8">
          <motion.div
            className="absolute inset-0 bg-[var(--scrim)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: fade.in }}
            exit={{ opacity: 0, transition: fade.out }}
            onClick={requestClose}
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: spring.glide }}
            exit={{ opacity: 0, scale: 0.98, y: 4, transition: fade.out }}
            className="relative flex max-h-full w-full flex-col overflow-hidden rounded-[20px] bg-surface shadow-pop"
            style={{ maxWidth: width }}
          >
            <header className="flex items-start gap-3 px-5 pb-3 pt-4">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-semibold text-ink">{title}</h2>
                {subtitle && <p className="mt-0.5 truncate text-sm text-ink-3">{subtitle}</p>}
              </div>
              <IconButton ref={closeBtnRef} icon={X} label="关闭" kbd="Esc" onClick={requestClose} className="-mr-1.5 -mt-0.5" />
            </header>
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
            {footer && <footer className="hairline-t flex items-center gap-2 bg-surface-2 px-5 py-3">{footer}</footer>}
            <ConfirmPop
              open={confirmDiscard}
              onClose={() => setConfirmDiscard(false)}
              anchor={closeBtnRef}
              title="放弃还没保存的内容？"
              message="刚才填写的修改还没有保存。"
              confirmLabel="放弃修改"
              danger
              onConfirm={onClose}
            />
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ───────── 抽屉（窄窗口下的详情）：跟手拖动，不抢占文本选择 ───────── */

export function Drawer({ open, onClose, children, width = 420 }: { open: boolean; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const x = useMotionValue(0);
  const scrim = useTransform(x, [0, width], [1, 0]);
  useEffect(() => {
    if (!open) return;
    x.set(0);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose, x]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > width * 0.3 || info.velocity.x > 600) onClose();
    else animateValue(x, 0, spring.snap);
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-30">
          <motion.div
            className="absolute inset-0 bg-[var(--scrim)]"
            style={{ opacity: scrim }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: fade.in }}
            exit={{ opacity: 0, transition: fade.out }}
            onClick={onClose}
          />
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal="true"
            className="absolute inset-y-2 right-2 flex flex-col overflow-hidden rounded-[18px] bg-surface shadow-pop"
            style={{ x, width: `min(${width}px, calc(100vw - 16px))` }}
            initial={{ x: width + 24 }}
            animate={{ x: 0, transition: spring.glide }}
            exit={{ x: width + 24, transition: { ...spring.glide, stiffness: 420 } }}
            drag="x"
            dragControls={dragControls}
            dragListener={false}
            dragDirectionLock
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.04, right: 1 }}
            dragMomentum={false}
            onPointerDown={(e) => {
              const t = e.target as Element | null;
              if (t?.closest("input, textarea, select, button, a, code, .selectable")) return;
              dragControls.start(e);
            }}
            onDragEnd={onDragEnd}
          >
            {children}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
