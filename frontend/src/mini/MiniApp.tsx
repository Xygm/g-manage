import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowLeft, Globe, KeyRound, Lock, Maximize2, MoreHorizontal, Pin, Power, RefreshCw, Search, Shuffle, SkipForward, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  app, canSwitch, CLIENTS, copyPlain, copyTotp, isNextCandidate, isUnlocked, loadAll, loadClients,
  openTarget, reloadAccounts, switchClient, switchNext, unlock, visibleAccounts,
} from "../lib/app";
import { fmtCountdown, fromNow, fuzzyScore, humanQuotaError, pct, poolRemaining, shortGroupName, tierLabel, windowLabel } from "../lib/format";
import { comparer, healthLabel, healthOf } from "../lib/health";
import { copyText, post, shell } from "../lib/bridge";
import { useNow } from "../lib/hooks";
import { useStore, shallowEqual } from "../lib/store";
import { fade, shake, spring, swap } from "../lib/motion";
import { useThemePref } from "../lib/theme";
import { errText, toast } from "../lib/toast";
import type { Account, ClientStatus, ClientTarget, UIPrefs } from "../lib/types";
import { Button, CopyButton, IconButton, Kbd, Tooltip, cx, useFlash } from "../ui/button";
import { Avatar, Pill, QuotaBar, TotpDigits, TotpRing } from "../ui/display";
import { Collapse, Segmented } from "../ui/form";
import { AutoHeight } from "../ui/layout";
import { Menu, Popover } from "../ui/overlay";
import { Toaster } from "../ui/toaster";

const QUOTA_STALE = 5 * 60; // 小窗开着时，当前号的额度最多 5 分钟查一次

/** 托盘 / 菜单栏小窗：一个搜索框，客户端切号与快速搜号复制合而为一。 */
export function MiniApp() {
  useThemePref();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<ClientTarget>(() => (localStorage.getItem("gam-mini-tab") as ClientTarget) || "agy");
  const [pickingFor, setPickingFor] = useState<ClientTarget | null>(null);
  const [unlockTargetId, setUnlockTargetId] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<UIPrefs>({ lightweight: false, mini_pinned: false });
  const [refreshing, setRefreshing] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const loaded = useStore(app, (s) => s.loaded);
  const switchable = useStore(app, (s) => !!s.app?.capabilities.switch_clients);
  const input = useRef<HTMLInputElement>(null);

  const refreshActive = async (force: boolean) => {
    const isDemo = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
    if (isDemo && !force) return;
    const s = app.get();
    const ids = [...new Set(s.clients.map((c) => c.account_id).filter(Boolean))];
    const stale = ids.filter((id) => {
      const a = s.accounts.find((x) => x.id === id);
      return a && (force || Date.now() / 1000 - a.quota_at > QUOTA_STALE);
    });
    if (!stale.length) return;
    setRefreshing(true);
    try {
      app.set({ accounts: await api.refreshQuota(stale) });
    } catch (e) {
      if (force) toast.err(errText(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAll().then(() => refreshActive(false));
    api.uiPrefs().then(setPrefs).catch(() => {});
    window.gamMini = {
      onShow() {
        reloadAccounts().then(() => refreshActive(false));
        setTimeout(() => input.current?.focus(), 30);
      },
      onHide() {
        setQ("");
        setPickingFor(null);
        setUnlockTargetId(null);
        window.dispatchEvent(new Event("gam-mini-hide"));
      },
    };
    const t = setInterval(() => {
      if (!document.hidden) reloadAccounts().then(() => refreshActive(false));
    }, 60_000);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (unlockTargetId) setUnlockTargetId(null);
        else if (input.current?.value) setQ("");
        else if (pickingFor) setPickingFor(null);
        else post("mini:hide");
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      clearInterval(t);
      document.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickingFor, unlockTargetId]);

  useEffect(() => setActiveIdx(0), [q, pickingFor]);

  const savePrefs = async (next: UIPrefs) => {
    setPrefs(next);
    try {
      setPrefs(await api.saveUiPrefs(next));
    } catch (e) {
      toast.err(errText(e));
    }
  };

  const copyMiniPassword = async (a: Account): Promise<boolean> => {
    if (!isUnlocked()) {
      setUnlockTargetId(a.id);
      return false;
    }
    try {
      const r = await api.revealPassword(a.id);
      await copyText(r.password);
      toast.ok("密码已复制");
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setUnlockTargetId(a.id);
        return false;
      }
      toast.err(errText(e));
      return false;
    }
  };

  const showResults = !!q.trim() || !!pickingFor || !switchable;

  return (
    <div className={cx("flex h-full flex-col overflow-hidden bg-tray text-ink", shell === "win" ? "rounded-none" : "rounded-[12px]")}>
      <header className="flex items-center gap-1 p-2.5 pb-1.5">
        {pickingFor && !q.trim() && (
          <IconButton icon={ArrowLeft} label="返回客户端" size="sm" onClick={() => setPickingFor(null)} />
        )}
        <label className="relative flex h-8 flex-1 items-center">
          <Search size={14} strokeWidth={2} className="pointer-events-none absolute left-2.5 text-ink-3" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (!showResults) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIdx((x) => x + 1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIdx((x) => Math.max(0, x - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent("gam-mini-enter", { detail: { meta: e.metaKey || e.ctrlKey } }));
              }
            }}
            placeholder={pickingFor ? `搜要切到 ${CLIENTS[pickingFor].short} 的号…` : "搜号：复制验证码或密码、开浏览器"}
            spellCheck={false}
            className="h-8 w-full rounded-[9px] bg-surface pl-8 pr-7 text-sm text-ink shadow-raised outline-none placeholder:text-ink-3 transition-shadow duration-[120ms] focus:shadow-[0_0_0_1.5px_var(--accent),0_0_0_3.5px_var(--accent-soft)]"
          />
          <AnimatePresence>
            {q && (
              <motion.button
                type="button"
                aria-label="清空"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1, transition: spring.press }}
                exit={{ opacity: 0, scale: 0.6, transition: fade.out }}
                onClick={() => {
                  setQ("");
                  input.current?.focus();
                }}
                className="absolute right-1.5 grid size-5 place-items-center rounded-full bg-fill-strong text-ink-2"
              >
                <X size={11} strokeWidth={2.4} />
              </motion.button>
            )}
          </AnimatePresence>
        </label>
        {switchable && <IconButton icon={RefreshCw} label="刷新正在用的号的额度" busy={refreshing} onClick={() => refreshActive(true)} />}
        <IconButton icon={Pin} label={prefs.mini_pinned ? "已固定：置顶且不自动收起" : "固定：置顶且不自动收起"} active={prefs.mini_pinned} className={cx(prefs.mini_pinned && "!text-accent")} onClick={() => savePrefs({ ...prefs, mini_pinned: !prefs.mini_pinned })} />
        <MoreMenu prefs={prefs} onPrefs={savePrefs} />
      </header>

      <Collapse open={unlockTargetId !== null} className="px-2.5">
        {unlockTargetId !== null && (
          <MiniUnlockBar
            targetId={unlockTargetId}
            onClose={() => setUnlockTargetId(null)}
            onUnlocked={async (id) => {
              setUnlockTargetId(null);
              const a = app.get().accounts.find((x) => x.id === id);
              if (a) await copyMiniPassword(a);
            }}
          />
        )}
      </Collapse>

      <div className="relative min-h-0 flex-1">
        {!loaded ? null : (
          <AnimatePresence mode="popLayout" initial={false}>
            {showResults ? (
              <motion.div key={pickingFor ? `pick-${pickingFor}` : "results"} {...swap} className="absolute inset-0">
                <Results
                  q={q.trim()}
                  pickingFor={pickingFor}
                  activeIdx={activeIdx}
                  setActiveIdx={setActiveIdx}
                  onCopyPassword={copyMiniPassword}
                  onPicked={() => {
                    setPickingFor(null);
                    setQ("");
                  }}
                />
              </motion.div>
            ) : (
              <motion.div key="clients" {...swap} className="absolute inset-0">
                <ClientsView
                  tab={tab}
                  setTab={setTab}
                  onCopyPassword={copyMiniPassword}
                  onPick={(target) => {
                    setPickingFor(target);
                    setTimeout(() => input.current?.focus(), 20);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
      <Toaster compact />
    </div>
  );
}

function MiniUnlockBar({ targetId, onClose, onUnlocked }: { targetId: number; onClose: () => void; onUnlocked: (id: number) => void }) {
  const platform = useStore(app, (s) => s.app?.platform);
  const os = platform === "darwin" ? "Mac" : "Windows";
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [targetId]);
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(pw);
      setPw("");
      onUnlocked(targetId);
    } catch (e) {
      setErr(errText(e));
      setShakeKey((k) => k + 1);
      requestAnimationFrame(() => ref.current?.select());
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.form
      key={shakeKey}
      animate={shakeKey ? shake : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mb-1.5 rounded-[10px] bg-surface p-2 shadow-raised"
    >
      <div className="flex items-center gap-1.5">
        <Lock size={12} strokeWidth={2.2} className="shrink-0 text-ink-3" />
        <input
          ref={ref}
          type="password"
          value={pw}
          aria-invalid={!!err}
          onChange={(e) => {
            setPw(e.target.value);
            setErr("");
          }}
          placeholder={`验证 ${os} 登录密码以复制`}
          className="h-6 min-w-0 flex-1 rounded-[6px] bg-fill px-2 text-xs text-ink outline-none placeholder:text-ink-3 focus:bg-surface focus:shadow-[0_0_0_1px_var(--accent)]"
        />
        <Button type="submit" size="xs" variant="primary" busy={busy} disabled={!pw}>
          解锁
        </Button>
        <IconButton icon={X} label="取消" size="xs" onClick={onClose} />
      </div>
      {err && <p className="mt-1 text-2xs text-danger">{err}</p>}
    </motion.form>
  );
}

function MoreMenu({ prefs, onPrefs }: { prefs: UIPrefs; onPrefs: (p: UIPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={ref} icon={MoreHorizontal} label="更多" active={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref}>
        <Menu
          onClose={() => setOpen(false)}
          items={[
            { icon: Maximize2, label: "打开主控制台", onSelect: () => post("main:show") },
            { label: "轻量模式", hint: "关主窗口时释放内存", checked: prefs.lightweight, onSelect: () => onPrefs({ ...prefs, lightweight: !prefs.lightweight }) },
            "sep",
            { icon: Power, label: "退出程序", danger: true, onSelect: () => post("app:quit") },
          ]}
        />
      </Popover>
    </>
  );
}

/* ───────── 客户端视图 ───────── */

function ClientsView({
  tab, setTab, onPick, onCopyPassword,
}: {
  tab: ClientTarget;
  setTab: (t: ClientTarget) => void;
  onPick: (t: ClientTarget) => void;
  onCopyPassword: (a: Account) => Promise<boolean>;
}) {
  const clients = useStore(app, (s) => s.clients, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  useEffect(() => {
    if (clients.length && !clients.some((c) => c.target === tab)) setTab(clients[0].target);
  }, [clients, tab, setTab]);
  useEffect(() => {
    loadClients();
  }, []);
  const c = clients.find((x) => x.target === tab);
  return (
    <div className="flex h-full flex-col gap-1.5 px-2.5 pb-2.5">
      <Segmented
        id="mini-tab"
        full
        items={clients.map((x) => ({
          value: x.target,
          label: (
            <span className="flex items-center gap-1.5">
              {CLIENTS[x.target].short}
              <span className={cx("size-1.5 rounded-full", x.running ? "bg-ok-dot" : "bg-fill-strong")} />
            </span>
          ),
          title: !x.installed ? "没装" : x.running ? "正在运行" : "没在运行",
        }))}
        value={tab}
        onChange={(v) => {
          setTab(v);
          try {
            localStorage.setItem("gam-mini-tab", v);
          } catch {
            /* 忽略 */
          }
        }}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[10px] bg-surface shadow-raised">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={tab} {...swap} className="thin-scroll h-full overflow-y-auto">
            {c ? <ClientCard c={c} onPick={() => onPick(c.target)} onCopyPassword={onCopyPassword} /> : <p className="p-6 text-center text-sm text-ink-3">读取中…</p>}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ClientCard({ c, onPick, onCopyPassword }: { c: ClientStatus; onPick: () => void; onCopyPassword: (a: Account) => Promise<boolean> }) {
  const a = useStore(app, (s) => s.accounts.find((x) => x.id === c.account_id));
  const switching = useStore(app, (s) => s.switching === c.target);
  const hasNext = useStore(app, (s) => s.accounts.some((x) => isNextCandidate(x, s.settings, c.account_id)));
  const hasOther = useStore(app, (s) => s.accounts.some((x) => x.has_token && x.id !== c.account_id && healthOf(x) !== "revoked"));
  const canUnlock = useStore(app, (s) => s.app?.capabilities.os_unlock ?? true);
  const [confirm, setConfirm] = useState(false);
  const now = useNow(30_000);
  const meta = CLIENTS[c.target];

  if (!c.installed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium text-ink">没检测到 {meta.name}</p>
        <p className="text-xs text-ink-3">{c.target === "agy" ? "装好 Antigravity CLI 后再来" : "装在不常见的位置的话，去主控制台的设置里填程序路径"}</p>
      </div>
    );
  }
  const doNext = () => {
    if (c.target !== "agy" && c.running) setConfirm(true);
    else switchNext(c.target);
  };
  const h = a ? healthOf(a) : null;
  const qerr = a && a.quota_error ? humanQuotaError(a.quota_error) : null;
  const email = a?.email || c.email;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2.5">
        <Avatar src={a?.has_avatar ? `/api/accounts/${a.id}/avatar` : undefined} email={email || "?"} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <p className="truncate text-base font-semibold text-ink">{email || "还没登录"}</p>
            {email && <CopyButton label="复制邮箱" onCopy={() => copyPlain(email, "邮箱已复制")} />}
            {a?.has_password && canUnlock && (
              <Tooltip label="复制密码">
                <IconButton icon={KeyRound} label="复制密码" size="xs" tip={false} onClick={() => onCopyPassword(a)} />
              </Tooltip>
            )}
          </div>
          <p className={cx("truncate text-xs", h === "due" || h === "pending" ? "text-warn" : h === "revoked" ? "text-danger" : "text-ink-3")}>
            {a ? healthLabel(a).text : c.email ? "这个号不在列表里，看不到额度" : `${meta.name} 还没登录`}
          </p>
        </div>
        {a?.quota?.tier && (
          <Pill tone="violet" className="h-5">
            {tierLabel(a.quota.tier)}
          </Pill>
        )}
      </div>

      <AutoHeight>
        <AnimatePresence initial={false} mode="popLayout">
          {confirm ? (
            <motion.div key="confirm" {...swap} role="alert" className="rounded-[8px] bg-warn-soft p-2.5">
              <p className="text-sm text-ink">{meta.short} 正在运行，切换会先关掉再重开，没保存的内容会丢。</p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => setConfirm(false)} data-autofocus>
                  取消
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => {
                    setConfirm(false);
                    switchNext(c.target);
                  }}
                >
                  关掉并切换
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="actions" {...swap} className="flex gap-1.5">
              <Tooltip label={hasNext ? "按设置里的规则挑下一个能用的号" : "没有满足额度门槛且过了风控期的备用号"}>
                <Button variant="soft" icon={SkipForward} busy={switching} disabled={!hasNext} onClick={doNext} className="flex-1">
                  {switching ? "正在切换…" : "切下个"}
                </Button>
              </Tooltip>
              <Tooltip label={hasOther ? `挑一个已授权号切到 ${meta.short}` : "没有其它可用的已授权号"}>
                <Button icon={Shuffle} disabled={!hasOther} onClick={onPick} className="flex-1">
                  挑一个号
                </Button>
              </Tooltip>
            </motion.div>
          )}
        </AnimatePresence>
      </AutoHeight>

      {qerr && (
        <p className="rounded-[8px] bg-danger-soft px-2.5 py-2 text-xs text-danger">{qerr.text}</p>
      )}

      {a?.quota?.groups?.length ? (
        <div className={cx("flex flex-col gap-2.5", qerr && "opacity-55")}>
          {a.quota.groups.flatMap((g) =>
            g.buckets.map((b) => {
              const p = pct(b.remaining_fraction);
              return (
                <div key={g.display_name + b.window}>
                  <div className="mb-1 flex items-baseline gap-1.5 text-xs">
                    <span className="font-medium text-ink">{shortGroupName(g.display_name)}</span>
                    <span className="text-ink-3">{windowLabel(b.window)}</span>
                    <span className="flex-1" />
                    {b.reset_time && <span className="text-ink-3">{fmtCountdown(b.reset_time, now)}后重置</span>}
                    <span className={cx("w-9 text-right font-semibold tnum", p <= 0 ? "text-danger" : p < 20 ? "text-warn" : "text-ink-2")}>{p}%</span>
                  </div>
                  <QuotaBar fraction={b.remaining_fraction} className={/claude|gpt/i.test(g.display_name) ? "[--bar-ok:var(--violet)]" : ""} />
                </div>
              );
            }),
          )}
          {a.quota_at > 0 && <p className="text-2xs text-ink-3">{qerr ? `${fromNow(a.quota_at, now)}重试失败 · 显示上次额度` : `${fromNow(a.quota_at, now)}更新`}</p>}
        </div>
      ) : a && !qerr ? (
        <p className="text-xs text-ink-3">还没查过额度，点右上角刷新</p>
      ) : null}
    </div>
  );
}

/* ───────── 搜索 / 挑号列表：键盘直达、复制验证码与密码、开浏览器、切号 ───────── */

function Results({
  q, pickingFor, activeIdx, setActiveIdx, onCopyPassword, onPicked,
}: {
  q: string;
  pickingFor: ClientTarget | null;
  activeIdx: number;
  setActiveIdx: (n: number) => void;
  onCopyPassword: (a: Account) => Promise<boolean>;
  onPicked: () => void;
}) {
  const accounts = useStore(app, visibleAccounts);
  const clients = useStore(app, (s) => s.clients);
  const switchable = useStore(app, () => canSwitch());
  const pickClient = pickingFor ? clients.find((c) => c.target === pickingFor) : undefined;
  const [confirmAcc, setConfirmAcc] = useState<Account | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const pool = pickingFor
      ? accounts.filter((a) => a.has_token && healthOf(a) !== "revoked" && a.id !== pickClient?.account_id)
      : accounts;
    if (!q) return [...pool].sort(comparer(pickingFor ? "quota" : "smart")).slice(0, 40);
    return pool
      .map((a) => ({ a, s: Math.max(fuzzyScore(a.email, q), fuzzyScore(a.note, q) * 0.8, ...a.tags.map((t) => fuzzyScore(t, q) * 0.7)) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 40)
      .map((x) => x.a);
  }, [accounts, q, pickingFor, pickClient?.account_id]);

  const clampedIdx = list.length ? Math.min(activeIdx, list.length - 1) : 0;

  useEffect(() => {
    listRef.current?.querySelector(`[data-mini-idx="${clampedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx]);

  const triggerPick = (a: Account) => {
    if (!pickingFor) return;
    if (pickingFor !== "agy" && pickClient?.running) setConfirmAcc(a);
    else {
      onPicked();
      switchClient(a, pickingFor);
    }
  };

  useEffect(() => {
    const onEnter = (ev: Event) => {
      const meta = (ev as CustomEvent<{ meta: boolean }>).detail?.meta;
      const a = list[clampedIdx];
      if (!a) return;
      if (pickingFor) {
        triggerPick(a);
      } else if (meta || !a.has_totp) {
        openTarget(a, "browser");
      } else {
        copyTotp(a);
      }
    };
    window.addEventListener("gam-mini-enter", onEnter);
    return () => window.removeEventListener("gam-mini-enter", onEnter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, clampedIdx, pickingFor, pickClient?.running]);

  if (!list.length) return <p className="p-8 text-center text-sm text-ink-3">{pickingFor ? "没有可切换的已授权号" : "没找到这个号"}</p>;

  return (
    <div className="flex h-full flex-col px-2.5 pb-2.5">
      <Collapse open={!!confirmAcc}>
        {confirmAcc && pickingFor && (
          <div role="alert" className="mb-1.5 rounded-[10px] bg-warn-soft p-2.5">
            <p className="text-xs text-ink">
              把 {CLIENTS[pickingFor].short} 切为 <b>{confirmAcc.email}</b>？运行中会先关闭再重开。
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => setConfirmAcc(null)}>
                取消
              </Button>
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  const targetAcc = confirmAcc;
                  setConfirmAcc(null);
                  onPicked();
                  switchClient(targetAcc, pickingFor);
                }}
              >
                关掉并切换
              </Button>
            </div>
          </div>
        )}
      </Collapse>
      <LayoutGroup id="mini-results">
        <div ref={listRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto rounded-[10px] bg-surface p-1 shadow-raised">
          <p className="px-2 pb-1 pt-1.5 text-2xs font-semibold tracking-[0.02em] text-ink-3">
            {pickingFor ? `点选一个号切到 ${CLIENTS[pickingFor].short}` : !q ? "要处理的排在前面 · 输入可以搜" : `找到 ${list.length} 个号`}
          </p>
          {list.map((a, idx) => (
            <ResultRow
              key={a.id}
              a={a}
              idx={idx}
              active={idx === clampedIdx}
              onHover={() => setActiveIdx(idx)}
              pickingFor={pickingFor}
              onPick={() => triggerPick(a)}
              switchable={switchable}
              onCopyPassword={onCopyPassword}
            />
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}

function ResultRow({
  a, idx, active, onHover, pickingFor, onPick, switchable, onCopyPassword,
}: {
  a: Account;
  idx: number;
  active: boolean;
  onHover: () => void;
  pickingFor: ClientTarget | null;
  onPick: () => void;
  switchable: boolean;
  onCopyPassword: (a: Account) => Promise<boolean>;
}) {
  const code = useStore(app, (s) => s.totp.codes[String(a.id)]);
  const t = useStore(app, (s) => ({ end: s.totp.periodEnd, period: s.totp.period }), shallowEqual);
  const canUnlock = useStore(app, (s) => s.app?.capabilities.os_unlock ?? true);
  const [done, flash] = useFlash();
  const h = healthOf(a);
  const g = poolRemaining(a.quota, "gemini");
  return (
    <div
      data-mini-idx={idx}
      onMouseMove={onHover}
      onClick={pickingFor ? onPick : undefined}
      className={cx("group relative flex h-12 items-center gap-2 rounded-[8px] px-2", pickingFor && "cursor-pointer")}
    >
      {active && <motion.span layoutId="mini-row-active" transition={spring.snap} className="absolute inset-0 rounded-[8px] bg-fill/75" />}
      <Avatar src={a.has_avatar ? `/api/accounts/${a.id}/avatar` : undefined} email={a.email} size={26} className="relative" />
      <div className="relative min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{a.email}</p>
        <p className={cx("truncate text-2xs", h === "due" || h === "pending" ? "text-warn" : h === "revoked" ? "text-danger" : "text-ink-3")}>
          {healthLabel(a).text}
          {g !== null && <span className="text-ink-3"> · Gemini {pct(g)}%</span>}
        </p>
      </div>
      {pickingFor ? (
        <span className="relative shrink-0 text-xs font-medium text-accent">切换 →</span>
      ) : (
        <>
          {a.has_totp && code && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.95 }}
              transition={spring.press}
              onClick={async (e) => {
                e.stopPropagation();
                if (await copyTotp(a)) flash();
              }}
              className={cx("relative flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-1.5 text-sm font-semibold transition-colors duration-[120ms]", done ? "bg-ok-soft text-ok" : "text-ink hover:bg-fill")}
            >
              <TotpDigits code={code} />
              <TotpRing periodEnd={t.end} period={t.period} size={12} />
            </motion.button>
          )}
          {a.has_password && canUnlock && <IconButton icon={KeyRound} label="复制密码" size="xs" onClick={() => onCopyPassword(a)} className="relative" />}
          <IconButton icon={Globe} label="打开这个号的浏览器" size="xs" onClick={() => openTarget(a, "browser")} className="relative" />
          {switchable && a.has_token && h !== "revoked" ? (
            <MiniSwitch a={a} />
          ) : switchable ? (
            <span className="w-6 shrink-0" aria-hidden />
          ) : null}
        </>
      )}
    </div>
  );
}

function MiniSwitch({ a }: { a: Account }) {
  const clients = useStore(app, (s) => s.clients.filter((c) => c.installed), (x, y) => JSON.stringify(x) === JSON.stringify(y));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!clients.length) return <span className="w-6 shrink-0" aria-hidden />;
  return (
    <>
      <IconButton ref={ref} icon={Shuffle} label="切到这个号" size="xs" active={open} onClick={() => setOpen((v) => !v)} className="relative" />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref}>
        <Menu
          onClose={() => setOpen(false)}
          items={clients.map((c) => ({
            label: `切到 ${CLIENTS[c.target].name}`,
            hint: c.account_id === a.id ? "正在用" : c.target !== "agy" && c.running ? "会重启" : undefined,
            disabled: c.account_id === a.id,
            onSelect: () => switchClient(a, c.target),
          }))}
        />
      </Popover>
    </>
  );
}

export { Kbd };
