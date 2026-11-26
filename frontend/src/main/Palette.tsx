import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { AlertTriangle, Download, KeyRound, Lock, Monitor, Moon, Plus, RefreshCw, Search, Settings2, SkipForward, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { app, canSwitch, CLIENTS, copyPassword, copyTotp, isUnlocked, lockVault, openTarget, refreshAll, select, switchNext, visibleAccounts } from "../lib/app";
import { fuzzyScore } from "../lib/format";
import { healthLabel, healthOf } from "../lib/health";
import { modLabel } from "../lib/bridge";
import { useStore } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { setThemePref } from "../lib/theme";
import type { Account } from "../lib/types";
import { Kbd, cx } from "../ui/button";
import { Avatar } from "../ui/display";
import { useFocusTrap } from "../ui/overlay";

interface Cmd {
  id: string;
  icon: LucideIcon;
  label: string;
  keywords?: string;
  kbd?: string;
  run: () => void;
}

type Item = { kind: "acc"; a: Account; score: number } | { kind: "cmd"; c: Cmd; score: number };

/** ⌘K：搜号直达，或直接执行命令。 */
export function Palette() {
  const open = useStore(app, (s) => s.palette);
  const accounts = useStore(app, visibleAccounts);
  const clients = useStore(app, (s) => s.clients);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => app.set({ palette: false });

  useFocusTrap(open, dialogRef);

  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
    }
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const cmds: Cmd[] = [
      { id: "add", icon: Plus, label: "添加账号", keywords: "新建 add", kbd: modLabel("N"), run: () => app.set({ sheet: { kind: "add" } }) },
      { id: "import", icon: Download, label: "从 Chrome 导入", keywords: "import 导入", run: () => app.set({ sheet: { kind: "import" } }) },
      { id: "refresh", icon: RefreshCw, label: "刷新所有额度", keywords: "quota 额度 刷新", kbd: modLabel("⇧R"), run: refreshAll },
      { id: "settings", icon: Settings2, label: "打开设置", keywords: "settings 设置 代理", kbd: modLabel(","), run: () => app.set({ sheet: { kind: "settings" } }) },
      { id: "f-dis", icon: AlertTriangle, label: "只看服务停用的号", keywords: "筛选 停用 封号 申诉 disabled", run: () => app.set({ filter: "disabled", tag: "", query: "" }) },
      { id: "f-pw", icon: KeyRound, label: "只看待改密的号", keywords: "筛选 改密 due", run: () => app.set({ filter: "password", tag: "", query: "" }) },
      { id: "f-auth", icon: KeyRound, label: "只看授权异常的号", keywords: "筛选 授权 过期", run: () => app.set({ filter: "auth", tag: "", query: "" }) },
      { id: "t-sys", icon: Monitor, label: "外观：跟随系统", keywords: "主题 theme 外观", run: () => setThemePref("system") },
      { id: "t-light", icon: Sun, label: "外观：浅色", keywords: "主题 theme 外观 light", run: () => setThemePref("light") },
      { id: "t-dark", icon: Moon, label: "外观：深色", keywords: "主题 theme 外观 dark 暗", run: () => setThemePref("dark") },
    ];
    if (isUnlocked()) cmds.push({ id: "lock", icon: Lock, label: "锁上密码查看", keywords: "lock 锁", run: lockVault });
    if (canSwitch()) {
      for (const c of clients.filter((x) => x.installed)) {
        cmds.push({ id: `next-${c.target}`, icon: SkipForward, label: `${CLIENTS[c.target].short} 切下个号`, keywords: `切号 next ${c.target}`, run: () => switchNext(c.target) });
      }
    }
    return cmds;
  }, [clients, open]);

  const items = useMemo<Item[]>(() => {
    const s = q.trim();
    const accs: Item[] = accounts
      .map((a) => ({ kind: "acc" as const, a, score: s ? Math.max(fuzzyScore(a.email, s), fuzzyScore(a.note, s) * 0.8, ...a.tags.map((t) => fuzzyScore(t, s) * 0.7)) : 0 }))
      .filter((x) => !s || x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, s ? 8 : 0);
    const cmds: Item[] = commands
      .map((c) => ({ kind: "cmd" as const, c, score: s ? Math.max(fuzzyScore(c.label, s), fuzzyScore(c.keywords || "", s) * 0.9) : 1 }))
      .filter((x) => x.score > 0)
      .slice(0, s ? 5 : 20);
    return [...accs, ...cmds];
  }, [q, accounts, commands]);

  useEffect(() => setI(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);

  const exec = (it: Item | undefined, action: "enter" | "open" | "copy2fa" | "copypw") => {
    if (!it) return;
    close();
    if (it.kind === "cmd") return it.c.run();
    if (action === "open") openTarget(it.a, "browser");
    else if (action === "copy2fa") copyTotp(it.a);
    else if (action === "copypw") copyPassword(it.a);
    else select(it.a.id);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    const el = e.currentTarget;
    const noSelection = (el.selectionStart ?? 0) === (el.selectionEnd ?? 0);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setI((x) => Math.min(Math.max(0, items.length - 1), x + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setI((x) => Math.max(0, x - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(items[i], mod ? "open" : "enter");
    } else if (mod && e.key.toLowerCase() === "c" && items[i]?.kind === "acc" && noSelection) {
      const a = items[i].a;
      if (e.shiftKey && a.has_password) {
        e.preventDefault();
        exec(items[i], "copypw");
      } else if (!e.shiftKey && a.has_totp) {
        e.preventDefault();
        exec(items[i], "copy2fa");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const firstCmd = items.findIndex((x) => x.kind === "cmd");

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-center px-4 pt-[14vh]">
          <motion.div className="absolute inset-0 bg-[var(--scrim)]" initial={{ opacity: 0 }} animate={{ opacity: 0.6, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }} onClick={close} />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: spring.pop }}
            exit={{ opacity: 0, scale: 0.98, transition: fade.out }}
            className="relative flex max-h-[min(520px,70vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-[16px] bg-surface shadow-pop"
          >
            <div className="hairline-b flex h-12 items-center gap-2.5 px-4">
              <Search size={16} strokeWidth={2} className="text-ink-3" />
              <input
                data-autofocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="搜邮箱、备注、标签，或输入命令"
                spellCheck={false}
                className="h-full flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-3"
              />
              <Kbd>Esc</Kbd>
            </div>
            <LayoutGroup id="palette-list">
              <div ref={listRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
                {items.length === 0 && <p className="px-3 py-8 text-center text-sm text-ink-3">没有匹配的号或命令</p>}
                {items.map((it, idx) => (
                  <div key={it.kind === "acc" ? `a${it.a.id}` : it.c.id}>
                    {(idx === 0 && it.kind === "acc") || idx === firstCmd ? <p className="px-2.5 pb-1 pt-2 text-2xs font-semibold tracking-[0.04em] text-ink-3">{it.kind === "acc" ? "账号" : "命令"}</p> : null}
                    <button
                      type="button"
                      data-idx={idx}
                      tabIndex={-1}
                      onMouseMove={() => setI(idx)}
                      onClick={(e) => exec(it, e.metaKey || e.ctrlKey ? "open" : "enter")}
                      className={cx("relative flex h-10 w-full items-center gap-3 rounded-[10px] px-2.5 text-left", idx === i ? "text-ink" : "text-ink-2")}
                    >
                      {idx === i && <motion.span layoutId="palette-active" transition={spring.snap} className="absolute inset-0 rounded-[10px] bg-fill" />}
                      {it.kind === "acc" ? (
                        <>
                          <Avatar src={it.a.has_avatar ? `/api/accounts/${it.a.id}/avatar` : undefined} email={it.a.email} size={22} className="relative" />
                          <span className="relative min-w-0 flex-1 truncate text-base">{it.a.email}</span>
                          <span className={cx("relative shrink-0 text-xs", healthOf(it.a) === "due" || healthOf(it.a) === "pending" ? "text-warn" : healthOf(it.a) === "revoked" || healthOf(it.a) === "disabled" ? "text-danger" : "text-ink-3")}>{healthLabel(it.a).text}</span>
                          {idx === i && (
                            <span className="relative hidden shrink-0 items-center gap-1.5 text-2xs text-ink-3 sm:flex">
                              <Kbd>↵</Kbd>查看
                              <Kbd>{modLabel("↵")}</Kbd>浏览器
                              {it.a.has_totp && (
                                <>
                                  <Kbd>{modLabel("C")}</Kbd>2FA
                                </>
                              )}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <it.c.icon size={16} strokeWidth={1.8} className="relative text-ink-3" />
                          <span className="relative flex-1 truncate text-base">{it.c.label}</span>
                          {it.c.kbd && <Kbd className="relative">{it.c.kbd}</Kbd>}
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </LayoutGroup>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
