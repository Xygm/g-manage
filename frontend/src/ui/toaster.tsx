import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { dismiss, holdToast, toasts, type Toast } from "../lib/toast";
import { useStore } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { cx } from "./button";

const icons = { ok: CheckCircle2, err: AlertCircle, info: Info };
const iconTone = { ok: "text-ok-dot", err: "text-danger-dot", info: "text-ink-3" };

/** 底部浮出的提示：不抢焦点；单行似胶囊、多行圆角自然，独立 LayoutGroup 不干扰列表。 */
export function Toaster({ compact }: { compact?: boolean }) {
  const list = useStore(toasts, (s) => s.list);
  return (
    <LayoutGroup id="toaster">
      <div aria-live="polite" className={cx("pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-3", compact ? "bottom-3" : "bottom-5")}>
        <AnimatePresence initial={false}>
          {list.map((t) => (
            <ToastItem key={t.id} t={t} />
          ))}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const Icon = icons[t.tone];
  return (
    <motion.div
      layout
      role={t.tone === "err" ? "alert" : "status"}
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.pop }}
      exit={{ opacity: 0, scale: 0.97, transition: fade.out }}
      transition={spring.snap}
      onPointerEnter={() => holdToast(t.id, true)}
      onPointerLeave={() => holdToast(t.id, false)}
      className="pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-2.5 rounded-[18px] bg-[color-mix(in_srgb,var(--surface)_90%,transparent)] py-1.5 pl-3 pr-1.5 text-sm text-ink shadow-pop backdrop-blur-xl backdrop-saturate-150"
    >
      <Icon size={15} strokeWidth={2} className={cx("shrink-0", iconTone[t.tone])} />
      <span className="min-w-0 flex-1 py-0.5 leading-snug">{t.text}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.run();
            dismiss(t.id);
          }}
          className="shrink-0 rounded-full bg-fill px-2.5 py-0.5 text-sm font-semibold text-accent transition-colors duration-[120ms] hover:bg-fill-strong"
        >
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="关闭提示" onClick={() => dismiss(t.id)} className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors duration-[120ms] hover:bg-fill hover:text-ink">
        <X size={13} strokeWidth={2} />
      </button>
    </motion.div>
  );
}
