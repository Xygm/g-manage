import { AnimatePresence, motion } from "motion/react";
import { Command, Download, LockOpen, Plus, RefreshCw, Settings2 } from "lucide-react";
import { forwardRef } from "react";
import { app, lockVault, refreshAll } from "../lib/app";
import { isNativeMac, modLabel } from "../lib/bridge";
import { useNow } from "../lib/hooks";
import { useStore } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { Button, IconButton, Tooltip, cx } from "../ui/button";

export const Header = forwardRef<HTMLElement>(function Header(_, ref) {
  const refreshing = useStore(app, (s) => s.refreshingAll);
  const hasAuthed = useStore(app, (s) => s.accounts.some((a) => a.has_token));
  return (
    <header ref={ref} className={cx("flex h-[52px] shrink-0 items-center gap-2 pr-3", isNativeMac ? "pl-[84px]" : "pl-4")}>
      <VaultPill />
      <div className="flex-1" />
      <Tooltip label="搜索账号或执行命令" kbd={modLabel("K")}>
        <button
          type="button"
          onClick={() => app.set({ palette: true })}
          className="hidden h-7 items-center gap-2 rounded-[8px] bg-fill pl-2.5 pr-1.5 text-sm text-ink-3 transition-colors duration-[120ms] hover:bg-fill-strong hover:text-ink-2 md:inline-flex"
        >
          <Command size={13} strokeWidth={2} />
          <span>命令</span>
          <kbd className="rounded-[5px] bg-surface px-1.5 font-sans text-2xs font-medium text-ink-3 shadow-[0_0_0_0.5px_var(--line-strong)]">{modLabel("K")}</kbd>
        </button>
      </Tooltip>
      {hasAuthed && (
        <Tooltip label="刷新所有已授权号的额度" kbd={modLabel("⇧R")}>
          <Button icon={RefreshCw} busy={refreshing} onClick={refreshAll} className={cx("rounded-[8px]", refreshing && "beam")}>
            <span className="hidden sm:inline">{refreshing ? "正在刷新" : "刷新额度"}</span>
          </Button>
        </Tooltip>
      )}
      <Tooltip label="从日常 Chrome 导入已登录的资料">
        <Button icon={Download} onClick={() => app.set({ sheet: { kind: "import" } })} className="hidden rounded-[8px] sm:inline-flex">
          <span className="hidden lg:inline">从 Chrome 导入</span>
          <span className="lg:hidden">导入</span>
        </Button>
      </Tooltip>
      <IconButton icon={Settings2} label="设置" kbd={modLabel(",")} onClick={() => app.set({ sheet: { kind: "settings" } })} />
      <Tooltip label="添加账号" kbd={modLabel("N")}>
        <Button variant="primary" icon={Plus} onClick={() => app.set({ sheet: { kind: "add" } })}>
          <span className="hidden sm:inline">添加账号</span>
        </Button>
      </Tooltip>
    </header>
  );
});

/** 解锁期间才出现：显示剩余时间，点一下立即锁上。 */
function VaultPill() {
  const until = useStore(app, (s) => s.vaultUntil);
  const now = useNow(1000);
  const left = Math.max(0, Math.ceil(until - now / 1000));
  const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <AnimatePresence initial={false}>
      {left > 0 && (
        <motion.span
          key="vault"
          initial={{ opacity: 0, width: 0 }}
          animate={{ opacity: 1, width: "auto", transition: { width: spring.snap, opacity: fade.in } }}
          exit={{ opacity: 0, width: 0, transition: { width: spring.snap, opacity: fade.out } }}
          className="overflow-hidden"
        >
          <Tooltip label="密码查看已解锁，点一下立即锁上">
            <button
              type="button"
              onClick={lockVault}
              className="ml-0.5 inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full bg-ok-soft pl-1.5 pr-2 text-xs font-medium text-ok transition-colors duration-[120ms] hover:brightness-95"
            >
              <LockOpen size={12} strokeWidth={2.2} />
              <span className="tnum">已解锁 {text}</span>
            </button>
          </Tooltip>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
