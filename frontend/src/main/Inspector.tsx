import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import {
  AlertTriangle, Check, ChevronDown, Copy, Crown, ExternalLink, Eye, EyeOff, Globe, KeyRound, Lock, Mail,
  MoreHorizontal, Pencil, Plus, RefreshCw, Shield, ShieldCheck, Shuffle, Trash2, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  appealAccount, app, authorize, cancelAwaitAuth, cancelPasswordChange, canSwitch, checkAccountService, CLIENTS, clientsOf, confirmPasswordChange,
  copyPassword, copyPlain, copyTotp, deleteWithUndo, detachOneChrome, inputOf, markChanged, openTarget, openUrl, patchPerks, refreshOne,
  refreshPerksOne, regeneratePassword, reveal, saveAccount, setTagColor, setTags, startPasswordChange, switchClient, unlock,
} from "../lib/app";
import {
  apiCreditAmountLabel, calendarDaysUntil, currentMonthStr, effectiveTier, fmtCountdown, fmtTime, fromNow,
  humanQuotaError, isPaidTier, isUltraTier, pct, shortGroupName, tierLabel, windowLabel,
} from "../lib/format";
import { accountNeedsAuth, billingAlertOf, healthOf } from "../lib/health";
import { modLabel } from "../lib/bridge";
import { useNow } from "../lib/hooks";
import { useStore, shallowEqual } from "../lib/store";
import { fade, shake, spring, swap } from "../lib/motion";
import { errText } from "../lib/toast";
import type { Account, ClientStatus } from "../lib/types";
import { Button, CopyButton, IconButton, Tooltip, cx, useFlash } from "../ui/button";
import { Avatar, MiniRing, Pill, QuotaBar, TAG_HUES, TagChip, TotpDigits, TotpRing, tagHue } from "../ui/display";
import { Collapse } from "../ui/form";
import { AutoHeight, Card, CardTitle } from "../ui/layout";
import { ConfirmPop, Menu, Popover } from "../ui/overlay";

export function Inspector({ id, inDrawer }: { id: number; inDrawer?: boolean }) {
  const a = useStore(app, (s) => (s.hidden.includes(id) ? undefined : s.accounts.find((x) => x.id === id)));
  if (!a) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-ink-3">
        <ShieldCheck size={26} strokeWidth={1.5} />
        <p className="text-sm">选一个号，这里显示它的详情</p>
      </div>
    );
  }
  const urgentBill = Boolean(billingAlertOf(a)?.urgent);
  return (
    <div className="flex h-full flex-col">
      <InspectorHeader a={a} inDrawer={inDrawer} />
      {/* 换号时不滑动整栏，框架不动，内容 110ms 轻淡入 */}
      <motion.div key={a.id} initial={{ opacity: 0.4 }} animate={{ opacity: 1, transition: { duration: 0.11 } }} className="thin-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5 pt-0">
        <AuthCard a={a} />
        <ServiceCard a={a} />
        {urgentBill && <PerksCard a={a} />}
        <StatusCard a={a} />
        <CredentialsCard a={a} />
        <QuotaCard a={a} />
        {!urgentBill && <PerksCard a={a} />}
        <DetailsCard a={a} />
      </motion.div>
    </div>
  );
}

/* ───────── 头部：身份 + 主操作 ───────── */

function InspectorHeader({ a, inDrawer }: { a: Account; inDrawer?: boolean }) {
  const clients = useStore(app, (s) => clientsOf(s, a.id), (x, y) => x.length === y.length && x.every((c, i) => c.target === y[i].target));
  const flashAt = useStore(app, (s) => (s.flash?.id === a.id ? s.flash.at : 0));
  return (
    <div className="relative px-4 pb-3 pt-4">
      {flashAt > 0 && <motion.span key={flashAt} initial={{ opacity: 1 }} animate={{ opacity: 0, transition: { duration: 0.6 } }} className="pointer-events-none absolute inset-1.5 rounded-[10px] bg-ok-soft" />}
      <div className="relative flex items-start gap-3">
        <Avatar src={a.has_avatar ? `/api/accounts/${a.id}/avatar` : undefined} email={a.email} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <h2 className="selectable truncate text-md font-semibold text-ink">{a.email}</h2>
            <CopyButton label="复制邮箱" onCopy={() => copyPlain(a.email, "邮箱已复制")} />
          </div>
          <NoteEditor a={a} />
        </div>
        {inDrawer && <IconButton icon={X} label="关闭" kbd="Esc" onClick={() => app.set({ selectedId: 0, unlockFor: null })} className="-mr-1 -mt-1" />}
      </div>
      {clients.length > 0 && (
        <div className="relative mt-2 flex flex-wrap gap-1">
          {clients.map((c) => (
            <span key={c.target} className="inline-flex h-5 items-center gap-1 rounded-full bg-accent-soft px-2 text-xs font-medium text-accent">
              <span className="size-1.5 rounded-full bg-accent" />
              {CLIENTS[c.target].name} 正在用
            </span>
          ))}
        </div>
      )}
      <TagEditor a={a} />
      <ActionsRow a={a} />
    </div>
  );
}

function NoteEditor({ a }: { a: Account }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(a.note);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setVal(a.note), [a.note, a.id]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = async () => {
    setEditing(false);
    const note = val.trim();
    if (note === a.note) return;
    try {
      await saveAccount({ ...inputOf(a), note }, a.id);
    } catch (e) {
      setVal(a.note);
      import("../lib/toast").then(({ toast }) => toast.err(errText(e)));
    }
  };
  if (editing) {
    return (
      <input
        ref={ref}
        value={val}
        maxLength={200}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            setVal(a.note);
            setEditing(false);
          }
        }}
        placeholder="用途、来源、状态…"
        className="-ml-1 mt-0.5 h-6 w-full rounded-[6px] bg-fill px-1 text-sm text-ink outline-none focus:shadow-[0_0_0_1px_var(--accent)]"
      />
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className={cx("-ml-1 mt-0.5 block max-w-full truncate rounded-[6px] px-1 text-left text-sm transition-colors duration-[120ms] hover:bg-fill", a.note ? "text-ink-2" : "text-ink-3")}>
      {a.note || "加个备注"}
    </button>
  );
}

function TagEditor({ a }: { a: Account }) {
  const colors = useStore(app, (s) => s.settings?.tag_colors);
  const allTags = useStore(app, (s) => [...new Set(s.accounts.flatMap((x) => x.tags))].sort().join("\n"));
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestions = allTags ? allTags.split("\n").filter((t) => !a.tags.includes(t) && (!val || t.toLowerCase().includes(val.toLowerCase()))).slice(0, 6) : [];

  const add = (t: string, keepOpen: boolean) => {
    const tag = t.trim();
    if (tag && !a.tags.some((x) => x.toLowerCase() === tag.toLowerCase())) setTags(a, [...a.tags, tag]);
    setVal("");
    if (!keepOpen) setAdding(false);
    else requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <LayoutGroup id={`tags-${a.id}`}>
      <div className="relative mt-2.5 flex flex-wrap items-center gap-1">
        <AnimatePresence initial={false} mode="popLayout">
          {a.tags.map((t) => (
            <motion.span key={t} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1, transition: spring.pop }} exit={{ opacity: 0, scale: 0.8, transition: fade.out }} transition={spring.snap} className="group/tag inline-flex">
              <TagChip tag={t} hue={tagHue(t, colors)} className="pr-1">
                <span className="sr-only">标签</span>
              </TagChip>
              <span className="-ml-[18px] flex items-center opacity-0 transition-opacity duration-[120ms] group-hover/tag:opacity-100 focus-within:opacity-100">
                <button type="button" aria-label={`移除标签 ${t}`} onClick={() => setTags(a, a.tags.filter((x) => x !== t))} className="grid size-4 place-items-center rounded-full bg-surface text-ink-3 shadow-thumb hover:text-danger">
                  <X size={9} strokeWidth={2.6} />
                </button>
              </span>
            </motion.span>
          ))}
          {adding ? (
            <motion.span key="__input" layout initial={{ opacity: 0, width: 40 }} animate={{ opacity: 1, width: 126, transition: spring.snap }} exit={{ opacity: 0, transition: fade.out }} className="relative">
              <input
                ref={inputRef}
                autoFocus
                value={val}
                maxLength={30}
                onChange={(e) => setVal(e.target.value)}
                onBlur={() => add(inputRef.current?.value ?? "", false)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add(val, true);
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setVal("");
                    setAdding(false);
                  }
                }}
                placeholder="标签，回车添加"
                className="h-5 w-full rounded-full bg-fill px-2 text-xs text-ink outline-none focus:shadow-[0_0_0_1px_var(--accent)]"
              />
              {suggestions.length > 0 && (
                <div
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute left-0 top-6 z-10 flex w-max max-w-[240px] flex-wrap gap-1 rounded-[10px] bg-surface p-1.5 shadow-pop"
                >
                  {suggestions.map((t) => (
                    <TagChip key={t} tag={t} hue={tagHue(t, colors)} onClick={() => add(t, true)} />
                  ))}
                </div>
              )}
            </motion.span>
          ) : (
            <motion.button
              key="__add"
              layout
              type="button"
              transition={spring.snap}
              onClick={() => setAdding(true)}
              className="inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-xs text-ink-3 shadow-[inset_0_0_0_1px_var(--line-strong)] transition-colors duration-[120ms] hover:bg-fill hover:text-ink-2"
            >
              <Plus size={11} strokeWidth={2.2} /> 标签
            </motion.button>
          )}
        </AnimatePresence>
        {a.tags.length > 0 && <TagColorButton tags={a.tags} />}
      </div>
    </LayoutGroup>
  );
}

/** 标签换色：一个小入口，展开后对每个标签选色。 */
function TagColorButton({ tags }: { tags: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const colors = useStore(app, (s) => s.settings?.tag_colors);
  return (
    <>
      <Tooltip label="给标签换颜色">
        <button ref={ref} type="button" aria-label="给标签换颜色" onClick={() => setOpen((v) => !v)} className="grid size-5 place-items-center rounded-full text-ink-3 transition-colors duration-[120ms] hover:bg-fill hover:text-ink-2">
          <span className="size-2.5 rounded-full bg-[conic-gradient(#3b82f6,#8b5cf6,#f43f5e,#f59e0b,#10b981,#3b82f6)]" />
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-start" className="w-[260px] p-2">
        <div className="flex flex-col gap-2">
          {tags.map((t) => (
            <div key={t} className="flex items-center gap-2">
              <TagChip tag={t} hue={tagHue(t, colors)} className="min-w-0 flex-1" />
              <HuePicker tag={t} inline />
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

function HuePicker({ tag, inline, onDone }: { tag: string; inline?: boolean; onDone?: () => void }) {
  const colors = useStore(app, (s) => s.settings?.tag_colors);
  const current = tagHue(tag, colors);
  return (
    <div className={cx("flex items-center gap-1", !inline && "p-1")}>
      {TAG_HUES.map((h) => (
        <motion.button
          key={h.id}
          type="button"
          data-hue={h.id}
          title={h.label}
          aria-label={h.label}
          whileTap={{ scale: 0.85 }}
          transition={spring.press}
          onClick={() => {
            setTagColor(tag, h.id);
            onDone?.();
          }}
          className="tag grid size-[18px] place-items-center rounded-full !bg-[var(--h-dot)]"
        >
          {current === h.id && <Check size={10} strokeWidth={3} className="text-white" />}
        </motion.button>
      ))}
    </div>
  );
}

function ActionsRow({ a }: { a: Account }) {
  const needAuth = accountNeedsAuth(a);
  const awaiting = useStore(app, (s) => s.awaitingAuth.includes(a.id));
  const switchable = useStore(app, () => canSwitch());
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
      {needAuth && !awaiting && (
        <Button variant="primary" icon={Shield} onClick={() => authorize(a)}>
          {a.has_token ? "重新授权" : "去授权"}
        </Button>
      )}
      <Button icon={Globe} onClick={() => openTarget(a, "browser")}>
        浏览器
      </Button>
      <Button icon={Mail} onClick={() => openTarget(a, "mail")}>
        Gmail
      </Button>
      {switchable && a.has_token && !needAuth && <SwitchButton a={a} />}
      <div className="flex-1" />
      <IconButton ref={moreRef} icon={MoreHorizontal} label="更多操作" active={more} onClick={() => setMore((v) => !v)} />
      <Popover open={more} onClose={() => setMore(false)} anchor={moreRef}>
        <Menu
          onClose={() => setMore(false)}
          items={[
            { icon: Pencil, label: "编辑资料", kbd: modLabel("E"), onSelect: () => app.set({ sheet: { kind: "edit", id: a.id } }) },
            ...(a.has_token ? [{ icon: RefreshCw, label: "刷新额度", kbd: modLabel("R"), onSelect: () => refreshOne(a.id) }] : []),
            ...(!a.chrome_profile ? [{ icon: Crown, label: "同步会员权益", onSelect: () => refreshPerksOne(a) }] : []),
            ...(a.has_token && !needAuth ? [{ icon: ShieldCheck, label: a.service_disabled ? "重新检测服务" : "检测服务可用性", onSelect: () => checkAccountService(a) }] : []),
            ...(a.has_token && !needAuth ? [{ icon: Shield, label: "重新授权", onSelect: () => authorize(a) }] : []),
            { icon: KeyRound, label: "打开 Google 改密页", onSelect: () => openTarget(a, "password") },
            "sep" as const,
            // 删除已有 8 秒持久撤销条，与 ⌘⌫ 行为一致，不再重复弹窗打断。
            { icon: Trash2, label: "移出这个号", kbd: modLabel("⌫"), danger: true, onSelect: () => deleteWithUndo(a) },
          ]}
        />
      </Popover>
    </div>
  );
}

function SwitchButton({ a }: { a: Account }) {
  const clients = useStore(app, (s) => s.clients.filter((c) => c.installed), (x, y) => JSON.stringify(x) === JSON.stringify(y));
  const switching = useStore(app, (s) => s.switching);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<ClientStatus | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  if (!clients.length) return null;

  const go = (c: ClientStatus) => {
    if (c.account_id === a.id) return;
    if (c.target !== "agy" && c.running) setConfirm(c);
    else switchClient(a, c.target);
  };
  const busyLabel = switching ? `正在切换 ${CLIENTS[switching].short}…` : null;

  if (clients.length === 1) {
    const c = clients[0];
    const current = c.account_id === a.id;
    return (
      <>
        <Tooltip label={current ? `${CLIENTS[c.target].name} 当前正在用这个号` : `把 ${CLIENTS[c.target].name} 切到这个号`}>
          <Button ref={ref} icon={current ? Check : Shuffle} busy={!!switching} disabled={current} onClick={() => go(c)}>
            {busyLabel ?? (current ? `${CLIENTS[c.target].short} 正在用` : `切到 ${CLIENTS[c.target].short}`)}
          </Button>
        </Tooltip>
        <SwitchConfirm c={confirm} a={a} anchor={ref} onClose={() => setConfirm(null)} />
      </>
    );
  }
  return (
    <>
      <Button ref={ref} icon={Shuffle} busy={!!switching} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {busyLabel ?? "切号"}
        {!switching && (
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring.snap} className="-mr-0.5 inline-grid">
            <ChevronDown size={13} strokeWidth={2} />
          </motion.span>
        )}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-start">
        <Menu
          onClose={() => setOpen(false)}
          items={clients.map((c) => ({
            label: `切到 ${CLIENTS[c.target].name}`,
            hint: c.account_id === a.id ? "正在用" : c.target !== "agy" && c.running ? "会重启" : undefined,
            disabled: c.account_id === a.id,
            onSelect: () => go(c),
          }))}
        />
      </Popover>
      <SwitchConfirm c={confirm} a={a} anchor={ref} onClose={() => setConfirm(null)} />
    </>
  );
}

function SwitchConfirm({ c, a, anchor, onClose }: { c: ClientStatus | null; a: Account; anchor: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  return (
    <ConfirmPop
      open={!!c}
      onClose={onClose}
      anchor={anchor}
      placement="bottom-start"
      title={c ? `${CLIENTS[c.target].short} 正在运行` : ""}
      message={c ? "切换会先关掉它再重新打开，没保存的内容会丢。" : ""}
      confirmLabel="关掉并切换"
      onConfirm={() => {
        if (c) switchClient(a, c.target);
      }}
    />
  );
}

/* ───────── 授权：等待中原地显示进度 ───────── */

function AuthCard({ a }: { a: Account }) {
  const awaiting = useStore(app, (s) => s.awaitingAuth.includes(a.id));
  return (
    <Collapse open={awaiting}>
      <Card tone="accent">
        <div className="flex items-center gap-2">
          <span className="breathe size-2 rounded-full bg-accent" />
          <p className="flex-1 text-sm font-medium text-ink">等你在浏览器里完成授权…</p>
        </div>
        <p className="mt-1 text-xs text-ink-2">选 {a.email} 这个号并允许；完成后这里会自动更新。</p>
        <div className="mt-2.5 flex gap-1.5">
          <Button size="xs" variant="secondary" icon={ExternalLink} onClick={() => authorize(a)}>
            重新打开授权页
          </Button>
          <Button size="xs" variant="ghost" onClick={() => cancelAwaitAuth(a.id)}>
            不等了
          </Button>
        </div>
      </Card>
    </Collapse>
  );
}

/* ───────── Antigravity 封号停用与官方申诉 ───────── */

function ServiceCard({ a }: { a: Account }) {
  const checking = useStore(app, (s) => s.checkingIds.includes(a.id));
  const now = useNow(30_000);
  const appealed = a.appeal_at > 0;
  return (
    <Collapse open={a.service_disabled}>
      <Card tone="danger">
        <div className="flex items-center gap-2">
          <AlertTriangle size={15} strokeWidth={2.1} className="shrink-0 text-danger" />
          <p className="flex-1 text-sm font-semibold text-danger">{appealed ? "Antigravity 申诉审核中" : "Antigravity 已停用"}</p>
          {appealed && (
            <Tooltip label={fmtTime(a.appeal_at)}>
              <span className="text-2xs text-ink-3">{fromNow(a.appeal_at, now)}已提交</span>
            </Tooltip>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-2">该账号的对话服务已被 Google 限制，需要提交官方申诉。</p>
        {a.service_error_id && (
          <div className="mt-2 flex h-7 items-center gap-1.5 rounded-[6px] bg-surface px-2 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
            <span className="shrink-0 text-2xs text-ink-3">Error ID</span>
            <code className="selectable min-w-0 flex-1 truncate font-mono text-xs text-ink">{a.service_error_id}</code>
            <CopyButton label="复制 Error ID" onCopy={() => copyPlain(a.service_error_id, "Error ID 已复制")} />
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Tooltip label="在这个账号的独立浏览器中打开 Google 官方申诉表单">
            <Button size="sm" variant="secondary" icon={ShieldCheck} onClick={() => appealAccount(a)} className="!text-danger">
              {appealed ? "再次打开申诉" : "去申诉"}
            </Button>
          </Tooltip>
          {a.has_token && (
            <Tooltip label="直接用该账号发送一条最小真实对话，检测服务是否已恢复（无需切号）">
              <Button size="sm" variant="ghost" icon={RefreshCw} busy={checking} onClick={() => checkAccountService(a)}>
                重新检测
              </Button>
            </Tooltip>
          )}
        </div>
      </Card>
    </Collapse>
  );
}

/* ───────── 改密状态：卡片随状态变形，改密流程直接在卡内展开 ───────── */

function StatusCard({ a }: { a: Account }) {
  const flow = useStore(app, (s) => (s.pwchange?.id === a.id ? s.pwchange : null));
  const h = healthOf(a);
  const pending = a.has_pending_password;
  const tone = flow || pending || a.status === "due" ? "warn" : undefined;
  const key = flow ? "flow" : pending ? "pending" : a.status;
  return (
    <Card tone={tone} className="p-0">
      <AutoHeight>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={key} {...swap} className="p-3">
            {flow ? (
              <PasswordFlow a={a} flow={flow} />
            ) : pending ? (
              <PendingBody a={a} />
            ) : a.status === "due" ? (
              <DueBody a={a} />
            ) : a.status === "risk" ? (
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center text-ink-2">
                  <MiniRing value={a.risk_days ? a.login_days / a.risk_days : 1} size={34} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">风控中 · 还剩 {a.risk_left} 天</p>
                  <p className="text-xs text-ink-3">
                    已登录 {a.login_days} / {a.risk_days} 天，期满后提醒你改密
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <span className="grid size-7 place-items-center rounded-full bg-ok-soft text-ok">
                  <Check size={14} strokeWidth={2.6} />
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">已改密</p>
                  <p className="text-xs text-ink-3">{a.pwd_changed_date ? `${a.pwd_changed_date} 改的` : "本次登录后改过"}</p>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </AutoHeight>
      <span className="sr-only">{h}</span>
    </Card>
  );
}

function StatusHead({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <p className="text-sm font-semibold text-ink">{title}</p>
    </div>
  );
}

/** 待确认新密码：就地可直接点「我改好了」或「放弃」，点「查看新密码」只展开不强弹浏览器。 */
function PendingBody({ a }: { a: Account }) {
  const [busy, setBusy] = useState(false);
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  const giveUpRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <StatusHead icon={<KeyRound size={15} strokeWidth={2} className="text-warn" />} title="待确认新密码" />
      <p className="mt-1 text-sm text-ink-2">上次生成了新密码，还没确认是否改成功。</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          icon={Check}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await confirmPasswordChange(a.id);
            } catch (e) {
              import("../lib/toast").then(({ toast }) => toast.err(errText(e)));
            } finally {
              setBusy(false);
            }
          }}
        >
          我改好了
        </Button>
        <Button variant="warn" size="sm" icon={KeyRound} onClick={() => startPasswordChange(a, false)}>
          查看新密码
        </Button>
        <Button ref={giveUpRef} variant="danger" size="xs" onClick={() => setConfirmGiveUp(true)}>
          没改成，放弃
        </Button>
      </div>
      <ConfirmPop
        open={confirmGiveUp}
        onClose={() => setConfirmGiveUp(false)}
        anchor={giveUpRef}
        placement="bottom-start"
        title="确定 Google 上没改成？"
        message="放弃后这个新密码会被删掉。要是其实已经改成功了，就再也找不回来。"
        confirmLabel="确实没改成"
        danger
        onConfirm={() => cancelPasswordChange(a.id)}
      />
    </>
  );
}

function DueBody({ a }: { a: Account }) {
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <StatusHead icon={<AlertTriangle size={15} strokeWidth={2} className="text-warn" />} title={`该改密了 · 已满 ${a.risk_days} 天`} />
      <p className="mt-1 text-sm text-ink-2">风控期过了。点「去改密」会生成新密码，并在这个号的浏览器里打开改密页。</p>
      <div className="mt-3 flex gap-1.5">
        <Button variant="warn" icon={KeyRound} onClick={() => startPasswordChange(a, true)}>
          去改密
        </Button>
        <Button ref={ref} variant="ghost" onClick={() => setConfirm(true)}>
          已经改过了
        </Button>
      </div>
      <ConfirmPop open={confirm} onClose={() => setConfirm(false)} anchor={ref} placement="bottom-start" title="记为今天已改密？" message="只改记录，不动密码。记错了可以撤销。" confirmLabel="记为已改密" onConfirm={() => markChanged(a)} />
    </>
  );
}

function PasswordFlow({ a, flow }: { a: Account; flow: { id: number; current: string; next: string } }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const giveUpRef = useRef<HTMLButtonElement>(null);
  const regenRef = useRef<HTMLButtonElement>(null);
  const step = "flex gap-2.5";
  const num = "mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-warn-dot text-2xs font-bold text-white";
  return (
    <div>
      <StatusHead icon={<KeyRound size={15} strokeWidth={2} className="text-warn" />} title="改密助手" />
      <ol className="mt-3 flex flex-col gap-3">
        <li className={step}>
          <span className={num}>1</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">在这个号的浏览器里打开 Google 改密页</p>
            <button type="button" onClick={() => openTarget(a, "password")} className="mt-0.5 text-xs font-medium text-accent hover:underline">
              打开 Google 改密页 →
            </button>
          </div>
        </li>
        <li className={step}>
          <span className={num}>2</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">Google 要验证身份时用</p>
            <div className="mt-1.5 flex flex-col gap-1">
              <SecretLine label="当前密码" value={flow.current} empty="没存，得你自己输" copyMsg="当前密码已复制" />
              {a.has_totp ? <TotpLine a={a} /> : <SecretLine label="2FA" value="" empty="没存密钥，用手机验证器" copyMsg="" />}
            </div>
          </div>
        </li>
        <li className={step}>
          <span className={num}>3</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">把新密码填进「新密码」「确认密码」两栏，提交</p>
            <div className="mt-1.5 flex items-center gap-1 rounded-[6px] bg-surface px-2 py-1 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
              <code className="selectable min-w-0 flex-1 truncate font-mono text-sm font-semibold text-ink">{flow.next}</code>
              <CopyButton label="复制新密码" onCopy={() => copyPlain(flow.next, "新密码已复制")} />
              <Tooltip label="换一个新密码">
                <IconButton ref={regenRef} icon={RefreshCw} label="换一个新密码" size="xs" tip={false} onClick={() => setConfirmRegen(true)} />
              </Tooltip>
            </div>
            <p className="mt-1 text-xs text-ink-3">新密码已先存为「待确认」，关掉也不会丢。</p>
          </div>
        </li>
      </ol>
      <Collapse open={!!err}>
        <p role="alert" className="mt-3 rounded-[6px] bg-danger-soft px-2 py-1.5 text-xs text-danger">
          {err}
        </p>
      </Collapse>
      <div className="mt-3.5 flex items-center gap-1.5">
        <Button ref={giveUpRef} size="xs" variant="danger" onClick={() => setConfirmGiveUp(true)}>
          没改成，放弃
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => app.set({ pwchange: null })}>
          收起
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={Check}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              await confirmPasswordChange(a.id);
            } catch (e) {
              setErr(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          我改好了
        </Button>
      </div>
      <ConfirmPop
        open={confirmGiveUp}
        onClose={() => setConfirmGiveUp(false)}
        anchor={giveUpRef}
        placement="top-start"
        title="确定 Google 上没改成？"
        message="放弃后这个新密码会被删掉。要是其实已经改成功了，就再也找不回来。"
        confirmLabel="确实没改成"
        danger
        onConfirm={async () => {
          try {
            await cancelPasswordChange(a.id);
          } catch (e) {
            setErr(errText(e));
          }
        }}
      />
      <ConfirmPop
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        anchor={regenRef}
        title="换一个新密码？"
        message="如果已经在 Google 提交了现在这个，千万别换，否则新密码就丢了。"
        confirmLabel="换一个"
        danger
        onConfirm={() => regeneratePassword(a.id)}
      />
    </div>
  );
}

function SecretLine({ label, value, empty, copyMsg }: { label: string; value: string; empty: string; copyMsg: string }) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-[6px] bg-surface px-2 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
      <span className="w-14 shrink-0 text-xs text-ink-3">{label}</span>
      {value ? (
        <>
          <code className="selectable min-w-0 flex-1 truncate font-mono text-sm text-ink">{value}</code>
          <CopyButton label={`复制${label}`} onCopy={() => copyPlain(value, copyMsg)} />
        </>
      ) : (
        <span className="flex-1 truncate text-xs text-ink-3">{empty}</span>
      )}
    </div>
  );
}

function TotpLine({ a }: { a: Account }) {
  const code = useStore(app, (s) => s.totp.codes[String(a.id)]);
  const t = useStore(app, (s) => ({ end: s.totp.periodEnd, period: s.totp.period }), shallowEqual);
  return (
    <div className="flex h-7 items-center gap-2 rounded-[6px] bg-surface px-2 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
      <span className="w-14 shrink-0 text-xs text-ink-3">2FA</span>
      <TotpDigits code={code} className="flex-1 text-sm font-semibold text-ink" />
      <TotpRing periodEnd={t.end} period={t.period} />
      <CopyButton label="复制验证码" onCopy={() => copyTotp(a)} />
    </div>
  );
}

/* ───────── 凭据：解锁就在卡片里输入 ───────── */

function CredentialsCard({ a }: { a: Account }) {
  const shown = useStore(app, (s) => s.revealed[a.id]);
  const wantUnlock = useStore(app, (s) => s.unlockFor?.id === a.id);
  const canUnlock = useStore(app, (s) => s.app?.capabilities.os_unlock ?? true);
  if (!a.has_password && !a.has_totp) {
    return (
      <Card>
        <CardTitle>密码与 2FA</CardTitle>
        <p className="text-sm text-ink-3">还没存密码和 2FA 密钥。存了以后登录时可以一键复制。</p>
        <Button size="xs" className="mt-2.5" icon={Plus} onClick={() => app.set({ sheet: { kind: "edit", id: a.id } })}>
          补上
        </Button>
      </Card>
    );
  }
  return (
    <Card>
      <CardTitle>密码与 2FA</CardTitle>
      <Collapse open={wantUnlock && canUnlock}>
        <UnlockInline />
      </Collapse>
      <div className="flex flex-col gap-1">
        {a.has_password && (
          <div className="flex h-8 items-center gap-2">
            <span className="w-10 shrink-0 text-xs text-ink-3">密码</span>
            <span className="relative grid min-w-0 flex-1 overflow-hidden">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.code key={shown ? "s" : "m"} {...swap} className={cx("col-start-1 row-start-1 truncate font-mono text-sm", shown ? "selectable text-ink" : "tracking-[0.2em] text-ink-3")}>
                  {shown ? shown.password : "••••••••••"}
                </motion.code>
              </AnimatePresence>
            </span>
            {canUnlock && <IconButton icon={shown ? EyeOff : Eye} label={shown ? "藏起密码" : "显示密码"} size="xs" onClick={() => reveal(a)} />}
            {canUnlock && <CopyButton label="复制密码" onCopy={() => copyPassword(a)} />}
          </div>
        )}
        <Collapse open={!!shown?.previous}>
          <div className="flex h-7 items-center gap-2">
            <span className="w-10 shrink-0 text-xs text-ink-3">上一个</span>
            <code className="selectable min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{shown?.previous}</code>
            <CopyButton label="复制上一个密码" onCopy={() => copyPlain(shown?.previous || "", "上一个密码已复制")} />
          </div>
        </Collapse>
        {a.has_totp && <TotpBig a={a} />}
      </div>
    </Card>
  );
}

function TotpBig({ a }: { a: Account }) {
  const code = useStore(app, (s) => s.totp.codes[String(a.id)]);
  const err = useStore(app, (s) => s.totp.errors[String(a.id)]);
  const t = useStore(app, (s) => ({ end: s.totp.periodEnd, period: s.totp.period }), shallowEqual);
  const now = useNow(1000);
  const left = Math.max(0, Math.ceil(t.end - now / 1000));
  const [done, flash] = useFlash();
  if (err) {
    return (
      <div className="flex h-9 items-center gap-2">
        <span className="w-10 shrink-0 text-xs text-ink-3">2FA</span>
        <span className="text-sm text-danger">密钥有问题，生成不了验证码</span>
      </div>
    );
  }
  const doCopy = async () => {
    const ok = await copyTotp(a);
    if (ok) flash();
    return ok;
  };
  return (
    <div className="flex h-10 items-center gap-2">
      <span className="w-10 shrink-0 text-xs text-ink-3">2FA</span>
      <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        transition={spring.press}
        onClick={doCopy}
        className={cx("-ml-1.5 flex flex-1 items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left transition-colors duration-[120ms]", done ? "bg-ok-soft" : "hover:bg-fill")}
      >
        <TotpDigits code={code} className={cx("text-xl font-semibold tracking-[0.04em]", done ? "text-ok" : "text-ink")} />
        <span className="flex-1" />
        <TotpRing periodEnd={t.end} period={t.period} size={16} />
        <span className={cx("w-6 text-right text-xs tnum", left <= 5 ? "text-warn" : "text-ink-3")}>{left}s</span>
      </motion.button>
      <CopyButton label="复制验证码" copied={done} onCopy={doCopy} />
    </div>
  );
}

function UnlockInline() {
  const user = useStore(app, (s) => s.osUser);
  const platform = useStore(app, (s) => s.app?.platform);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLInputElement>(null);
  const os = platform === "darwin" ? "Mac" : "Windows";
  useEffect(() => {
    const t = setTimeout(() => {
      wrapRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      ref.current?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, []);
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(pw);
      setPw("");
    } catch (e) {
      setErr(errText(e));
      setShakeKey((k) => k + 1);
      requestAnimationFrame(() => ref.current?.select());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={wrapRef} className="mb-2.5 rounded-[6px] bg-surface p-2.5 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
      <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
        <Lock size={13} strokeWidth={2.2} className="text-ink-3" />
        先验证一下电脑密码
      </div>
      <p className="mt-0.5 text-xs text-ink-3">
        输入 {os} 用户 {user ? <b className="font-medium text-ink-2">{user}</b> : null} 的登录密码{os === "Windows" ? "（不是 PIN）" : ""}，5 分钟内不用再输。
      </p>
      <motion.form
        key={shakeKey}
        animate={shakeKey ? shake : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mt-2 flex gap-1.5"
      >
        <input
          ref={ref}
          type="password"
          value={pw}
          autoComplete="current-password"
          aria-invalid={!!err}
          aria-label={`${os} 登录密码`}
          onChange={(e) => {
            setPw(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              app.set({ unlockFor: null });
            }
          }}
          placeholder={`${os} 登录密码`}
          className="h-7 min-w-0 flex-1 rounded-[7px] bg-fill px-2.5 text-sm text-ink outline-none transition-shadow duration-[120ms] placeholder:text-ink-3 focus:bg-surface focus:shadow-[0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] aria-[invalid=true]:shadow-[0_0_0_1px_var(--danger),0_0_0_3px_var(--danger-soft)]"
        />
        <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!pw}>
          解锁
        </Button>
        <IconButton icon={X} label="取消" size="sm" onClick={() => app.set({ unlockFor: null })} />
      </motion.form>
      <Collapse open={!!err}>
        <p role="alert" className="pt-1.5 text-xs text-danger">
          {err}
        </p>
      </Collapse>
    </div>
  );
}

/* ───────── 额度 ───────── */

function QuotaCard({ a }: { a: Account }) {
  const refreshing = useStore(app, (s) => s.refreshingIds.includes(a.id) || (s.refreshingAll && a.has_token));
  const checking = useStore(app, (s) => s.checkingIds.includes(a.id));
  const awaiting = useStore(app, (s) => s.awaitingAuth.includes(a.id));
  const now = useNow(30_000);
  const q = a.quota;
  const rawErr = a.has_token && a.quota_error ? humanQuotaError(a.quota_error) : null;
  const err = rawErr && !(a.service_disabled && /服务已被停用|violation of terms of service/i.test(rawErr.text)) ? rawErr : null;

  // 能替人做的直接做：选中的号额度超过 10 分钟没更新，且非演示模式时，后台静默刷新一次。
  useEffect(() => {
    const isDemo = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
    if (!isDemo && !a.service_disabled && a.has_token && !a.quota_error && Date.now() / 1000 - a.quota_at > 600) {
      refreshOne(a.id, true);
    }
  }, [a.id, a.service_disabled, a.has_token, a.quota_at, a.quota_error]);

  if (a.service_disabled && a.appeal_at > 0) return null;

  if (!a.has_token) {
    if (awaiting) return null;
    return (
      <Card>
        <CardTitle>Antigravity 额度</CardTitle>
        <p className="text-sm text-ink-3">授权这个号以后，这里会显示它的额度。</p>
      </Card>
    );
  }

  const timeStatus = refreshing
    ? "正在更新"
    : err
      ? `${fromNow(a.quota_at, now)}重试失败`
      : `${fromNow(a.quota_at, now)}更新`;

  return (
    <Card>
      <CardTitle
        right={
          <>
            {effectiveTier(a) && (
              <Pill tone={isUltraTier(effectiveTier(a)) ? "violet" : effectiveTier(a) === "PRO" ? "accent" : "neutral"} className="h-5">
                {tierLabel(effectiveTier(a))}
              </Pill>
            )}
            {a.quota_at > 0 && (
              <Tooltip label={fmtTime(a.quota_at)}>
                <span className={cx("text-xs transition-opacity", refreshing && "breathe", err ? "text-danger" : "text-ink-3")}>{timeStatus}</span>
              </Tooltip>
            )}
            {!a.service_disabled && (
              <IconButton
                icon={ShieldCheck}
                label="发送一条最小真实对话，检测 Antigravity 是否可用（无需切号）"
                size="xs"
                busy={checking}
                onClick={() => checkAccountService(a)}
              />
            )}
            <IconButton icon={RefreshCw} label="刷新这个号的额度" kbd={modLabel("R")} size="xs" busy={refreshing} onClick={() => refreshOne(a.id)} />
          </>
        }
      >
        Antigravity 额度
      </CardTitle>
      <Collapse open={!!err}>
        {err && (
          <div className="mb-2.5 flex items-start gap-2 rounded-[6px] bg-danger-soft px-2.5 py-2 text-xs text-danger">
            <AlertTriangle size={13} strokeWidth={2.2} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <p>{err.text}</p>
              {err.verifyUrl && (
                <button type="button" onClick={() => openUrl(a, err.verifyUrl)} className="mt-1 font-semibold underline-offset-2 hover:underline">
                  在这个号的浏览器里去验证 →
                </button>
              )}
              {err.revoked && (
                <button type="button" onClick={() => authorize(a)} className="mt-1 font-semibold underline-offset-2 hover:underline">
                  重新授权 →
                </button>
              )}
            </div>
          </div>
        )}
      </Collapse>
      {q && q.groups?.length ? (
        <div className={cx("flex flex-col gap-3 transition-opacity duration-200", err && "opacity-60")}>
          {err && <p className="-mb-1.5 text-2xs text-ink-3">以下为上次成功记录的额度</p>}
          {q.groups.map((g) => (
            <div key={g.display_name}>
              <p className="mb-1.5 text-sm font-medium text-ink">{shortGroupName(g.display_name)}</p>
              <div className="flex flex-col gap-1.5">
                {g.buckets.map((b) => {
                  const p = pct(b.remaining_fraction);
                  return (
                    <div key={b.window} className="grid grid-cols-[52px_1fr_38px] items-center gap-2">
                      <span className="text-xs text-ink-3">{windowLabel(b.window)}</span>
                      <Tooltip label={b.reset_time ? `${fmtCountdown(b.reset_time, now)}后重置（${fmtTime(b.reset_time)}）` : `剩 ${p}%`}>
                        <span className="block">
                          <QuotaBar fraction={b.remaining_fraction} label={`${shortGroupName(g.display_name)} ${windowLabel(b.window)} 剩余`} className={/claude|gpt/i.test(g.display_name) ? "[--bar-ok:var(--violet)]" : ""} />
                        </span>
                      </Tooltip>
                      <span className={cx("text-right text-xs font-medium tnum", p <= 0 ? "text-danger" : p < 20 ? "text-warn" : "text-ink-2")}>{p}%</span>
                    </div>
                  );
                })}
              </div>
              {g.buckets.some((b) => b.reset_time) && (
                <p className="mt-1 text-2xs text-ink-3">
                  {g.buckets
                    .filter((b) => b.reset_time)
                    .map((b) => `${windowLabel(b.window)} ${fmtCountdown(b.reset_time, now)}后重置`)
                    .join(" · ")}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : !err ? (
        <p className="text-sm text-ink-3">{refreshing ? "正在查询…" : "还没查过额度"}</p>
      ) : null}
    </Card>
  );
}

/* ───────── 会员与附赠权益（防反撸 + 算力积分 + 按月赠金 + 家庭组） ───────── */

const TIER_CHOICES: { value: string; label: string; hint?: string }[] = [
  { value: "", label: "跟随授权自动识别" },
  { value: "PRO", label: "Google AI Pro", hint: "$19.99/月" },
  { value: "ULTRA", label: "Google AI Ultra", hint: "自动细分" },
  { value: "ULTRA_5X", label: "Google AI Ultra 5x", hint: "$99.99/月" },
  { value: "ULTRA_20X", label: "Google AI Ultra 20x", hint: "$199.99/月" },
  { value: "FREE", label: "Free 免费档" },
];

function PerksCard({ a }: { a: Account }) {
  const now = useNow(60_000);
  const syncing = useStore(app, (s) => s.syncingPerksIds.includes(a.id) || (s.syncingAllPerks && !a.chrome_profile));
  const [expanded, setExpanded] = useState(false);
  const [tierOpen, setTierOpen] = useState(false);
  const tierBtnRef = useRef<HTMLButtonElement>(null);

  const tier = effectiveTier(a);
  const p = a.perks;
  const hasPerks = isPaidTier(tier) || !!p || syncing;
  const bill = billingAlertOf(a, now);
  const daysLeft = calendarDaysUntil(p?.renewal_date, now);
  const curMonth = currentMonthStr(now);
  const claimedMonth = p?.api_credit_claimed_month || "";
  const claimedNow = claimedMonth === curMonth;

  if (!hasPerks && !expanded) {
    return (
      <Card className="py-2.5">
        <div className="flex items-center gap-1.5">
          <Crown size={13} strokeWidth={1.9} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-3">会员与附赠权益</span>
          {!a.chrome_profile && (
            <Button size="xs" variant="ghost" icon={RefreshCw} busy={syncing} onClick={() => refreshPerksOne(a)}>
              自动读取
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => patchPerks(a, { tier_override: "PRO" }, { okMsg: "已标为 Pro 会员", undoPatch: { tier_override: "" }, flash: true })}
          >
            标 Pro
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setExpanded(true)}>
            展开
          </Button>
        </div>
      </Card>
    );
  }

  const prevState = p?.billing_state || "";
  const syncLabel = syncing ? "正在读取网页权益…" : a.perks_at > 0 ? `${fromNow(a.perks_at, now)}同步` : "";
  const apiAmt = p?.api_credit_total ? `$${p.api_credit_total}/月` : apiCreditAmountLabel(tier);

  return (
    <Card tone={bill?.urgent ? bill.tone : undefined}>
      <CardTitle
        right={
          <>
            {syncLabel && (
              <Tooltip label={a.perks_at > 0 ? `最近自动同步：${fmtTime(a.perks_at)}` : "正在通过独立浏览器会话读取权益"}>
                <span className={cx("text-2xs text-ink-3", syncing && "breathe text-accent")}>{syncLabel}</span>
              </Tooltip>
            )}
            <button
              ref={tierBtnRef}
              type="button"
              onClick={() => setTierOpen((v) => !v)}
              className={cx(
                "inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors duration-[120ms] hover:brightness-95",
                isUltraTier(tier) ? "bg-violet-soft text-violet" : tier === "PRO" ? "bg-accent-soft text-accent" : "bg-fill text-ink-2",
              )}
            >
              <span>{tier ? tierLabel(tier) : "设档位"}</span>
              <ChevronDown size={11} strokeWidth={2.2} />
            </button>
            <Popover open={tierOpen} onClose={() => setTierOpen(false)} anchor={tierBtnRef}>
              <Menu
                onClose={() => setTierOpen(false)}
                items={TIER_CHOICES.map((c) => ({
                  label: c.label,
                  hint: c.hint,
                  checked: (p?.tier_override || "") === c.value,
                  onSelect: () =>
                    patchPerks(a, { tier_override: c.value }, {
                      okMsg: c.value ? `已设为 ${tierLabel(c.value)}` : "已恢复跟随授权识别",
                      undoPatch: { tier_override: p?.tier_override || "" },
                    }),
                }))}
              />
            </Popover>
            {!a.chrome_profile && (
              <IconButton
                icon={RefreshCw}
                size="xs"
                busy={syncing}
                label="后台同步 Flow 积分、Colab CU 与订阅账期（要先关掉这个号的浏览器）"
                onClick={() => refreshPerksOne(a)}
              />
            )}
          </>
        }
      >
        会员与附赠权益
      </CardTitle>

      <Collapse open={p?.web_status === "needs_login" || p?.web_status === "account_mismatch"}>
        {(p?.web_status === "needs_login" || p?.web_status === "account_mismatch") && (
          <div className="mb-2 flex items-start gap-2 rounded-[7px] bg-warn-soft px-2.5 py-2 text-xs text-warn">
            <AlertTriangle size={13} strokeWidth={2.2} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <p>{p.web_error || "这个号的独立浏览器尚未登录 Google"}</p>
              <button type="button" onClick={() => openTarget(a, "browser")} className="mt-0.5 font-semibold underline-offset-2 hover:underline">
                打开这个号的浏览器去登录 →
              </button>
            </div>
          </div>
        )}
      </Collapse>

      {/* 1. 账期与自动续费防反撸 */}
      <div className="rounded-[8px] bg-surface-2 p-2.5 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
        <div className="flex flex-wrap items-center gap-1.5">
          {bill ? (
            <Pill tone={bill.tone} dot title={bill.hint}>
              {bill.text}
            </Pill>
          ) : p?.billing_state === "auto_renew" ? (
            <Pill tone="warn" dot>
              自动续费中
            </Pill>
          ) : p?.billing_state === "cancelled" ? (
            <Pill tone="ok" dot>
              已关续费
            </Pill>
          ) : p?.billing_state === "expired" ? (
            <Pill tone="neutral">已到期</Pill>
          ) : (
            <Pill tone="neutral">续费状态未记</Pill>
          )}
          <span className="flex-1" />
          {p?.billing_state === "auto_renew" ? (
            <Button
              size="xs"
              variant="secondary"
              icon={Check}
              onClick={() =>
                patchPerks(a, { billing_state: "cancelled" }, { okMsg: "已记为已关自动续费", undoPatch: { billing_state: prevState }, flash: true })
              }
            >
              标为已关续费
            </Button>
          ) : p?.billing_state === "cancelled" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => patchPerks(a, { billing_state: "auto_renew" }, { okMsg: "已改为自动续费中", undoPatch: { billing_state: prevState } })}
            >
              改为自动续费
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => patchPerks(a, { billing_state: "auto_renew" }, { okMsg: "已记为自动续费中", undoPatch: { billing_state: prevState } })}
              >
                自动续费
              </Button>
              <Button
                size="xs"
                variant="secondary"
                icon={Check}
                onClick={() =>
                  patchPerks(a, { billing_state: "cancelled" }, { okMsg: "已记为已关续费", undoPatch: { billing_state: prevState }, flash: true })
                }
              >
                已关续费
              </Button>
            </>
          )}
          <IconButton icon={ExternalLink} size="xs" label="在浏览器打开 Google 订阅管理" onClick={() => openTarget(a, "subscriptions")} />
        </div>

        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="shrink-0 text-ink-3">{p?.billing_state === "auto_renew" ? "扣费日" : "到期日"}</span>
          <PerksDateInput
            value={p?.renewal_date || ""}
            onCommit={(next) =>
              patchPerks(a, { renewal_date: next }, {
                okMsg: next ? `账期日已记为 ${next}` : "已清空账期日",
                undoPatch: { renewal_date: p?.renewal_date || "" },
              })
            }
          />
          <span className="flex-1" />
          {daysLeft !== null && (
            <span className={cx("shrink-0 tnum", bill?.urgent ? "font-medium text-danger" : daysLeft <= 5 && daysLeft >= 0 ? "text-warn" : "text-ink-3")}>
              {daysLeft === 0 ? "今天" : daysLeft > 0 ? `${daysLeft} 天后` : `已过 ${-daysLeft} 天`}
            </span>
          )}
        </div>
      </div>

      {/* 2. 双格算力与积分磁贴（严格适配 344px 卡片净宽，不换行） */}
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <div className="flex min-w-0 flex-col rounded-[8px] bg-surface-2 px-2.5 py-2 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-xs font-medium text-ink-2">Flow 积分</span>
            <IconButton icon={ExternalLink} size="xs" label="在这个号的浏览器打开 Flow" onClick={() => openTarget(a, "flow")} className="-mr-1 -my-0.5" />
          </div>
          <InlineMetricEditor
            value={p?.flow_credits}
            integer
            ariaLabel="Flow 剩余积分"
            onCommit={(v) => patchPerks(a, v === null ? { clear_flow_credits: true } : { flow_credits: v })}
          />
          <p className="mt-0.5 truncate text-2xs text-ink-3">
            {p?.flow_next_grant_at ? `${p.flow_next_grant_at} 到账` : "月度刷新 · 不滚存"}
          </p>
        </div>

        <div className="flex min-w-0 flex-col rounded-[8px] bg-surface-2 px-2.5 py-2 shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-xs font-medium text-ink-2">Colab</span>
            <IconButton icon={ExternalLink} size="xs" label="在这个号的浏览器打开 Colab" onClick={() => openTarget(a, "colab")} className="-mr-1 -my-0.5" />
          </div>
          <InlineMetricEditor
            value={p?.colab_cu}
            unit="CU"
            ariaLabel="Colab 剩余计算单元"
            onCommit={(v) => patchPerks(a, v === null ? { clear_colab_cu: true } : { colab_cu: v })}
          />
          <p className="mt-0.5 truncate text-2xs text-ink-3">
            {p?.colab_note_date
              ? `${p.colab_note_date} 过期`
              : p?.colab_gpus?.length
                ? `可用 ${p.colab_gpus.slice(0, 3).join(" · ")}`
                : p?.colab_observed_at
                  ? `自 ${p.colab_observed_at.slice(5)} 记录`
                  : "单笔 90 天内有效"}
          </p>
        </div>
      </div>

      {/* 3. 低频权益：API 月度赠金 + 家庭组席位 + Google One */}
      <div className="mt-1.5 flex flex-col gap-0.5">
        <div className="flex h-8 items-center gap-1.5 rounded-[7px] px-1.5 transition-colors duration-[120ms] hover:bg-fill/45">
          <span className="shrink-0 text-xs font-medium text-ink-2">API 赠金</span>
          <span className="truncate text-2xs text-ink-3">{apiAmt}</span>
          <span className="flex-1" />
          {claimedNow ? (
            <Tooltip label={p?.api_credit_balance !== undefined ? `本月已激活 · 剩余可用 $${p.api_credit_balance.toFixed(2)}` : `已记录 ${curMonth} 激活`}>
              <span className="shrink-0 text-xs font-medium tnum text-ok">
                {p?.api_credit_balance !== undefined ? `剩 $${p.api_credit_balance.toFixed(2).replace(/\.00$/, "")}` : "本月已领"}
              </span>
            </Tooltip>
          ) : claimedMonth ? (
            <Tooltip label={`上次记录领取：${claimedMonth}，本月可领新一期`}>
              <span className="shrink-0 text-xs text-warn">本月待领</span>
            </Tooltip>
          ) : (
            <span className="shrink-0 text-xs text-ink-3">本月待领</span>
          )}
          <Button
            size="xs"
            variant={claimedNow ? "ghost" : "soft"}
            onClick={() =>
              patchPerks(
                a,
                { api_credit_claimed_month: claimedNow ? "" : curMonth },
                {
                  okMsg: claimedNow ? "已撤回本月赠金记录" : `已记为 ${curMonth} 赠金已激活`,
                  undoPatch: { api_credit_claimed_month: claimedMonth },
                  flash: !claimedNow,
                },
              )
            }
          >
            {claimedNow ? "撤回" : "记已领"}
          </Button>
          <IconButton icon={ExternalLink} size="xs" label="在这个号的浏览器打开开发者赠金页" onClick={() => openTarget(a, "benefits")} />
        </div>

        <div className="flex h-8 items-center gap-1.5 rounded-[7px] px-1.5 transition-colors duration-[120ms] hover:bg-fill/45">
          <span className="shrink-0 text-xs font-medium text-ink-2">家庭组</span>
          <span className="flex-1" />
          <FamilySeatMenu a={a} />
          <IconButton icon={ExternalLink} size="xs" label="在这个号的浏览器打开 Google 家庭组" onClick={() => openTarget(a, "family")} />
          <IconButton icon={Globe} size="xs" label="在这个号的浏览器打开 Google One 设置" onClick={() => openTarget(a, "one")} />
        </div>
      </div>
    </Card>
  );
}

function PerksDateInput({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);

  const commit = (raw: string) => {
    setEditing(false);
    const trimmed = raw.trim();
    if (trimmed === value) return;
    if (trimmed && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      setVal(value);
      return;
    }
    onCommit(trimmed);
  };

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "Escape") {
            e.stopPropagation();
            setVal(value);
            setEditing(false);
          }
        }}
        className="h-6 rounded-[6px] bg-surface px-1.5 font-mono text-xs text-ink outline-none shadow-[0_0_0_1px_var(--accent)]"
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cx(
          "h-6 rounded-[6px] px-1.5 font-mono text-xs transition-colors duration-[120ms] hover:bg-fill",
          value ? "text-ink" : "font-sans text-ink-3",
        )}
      >
        {value || "设置日期"}
      </button>
      {value && (
        <button
          type="button"
          aria-label="清空账期日"
          onClick={() => onCommit("")}
          className="grid size-4 place-items-center rounded-full text-ink-3 hover:bg-fill hover:text-ink-2"
        >
          <X size={10} strokeWidth={2.4} />
        </button>
      )}
    </span>
  );
}

function InlineMetricEditor({
  value,
  unit,
  integer,
  ariaLabel,
  onCommit,
}: {
  value: number | undefined;
  unit?: string;
  integer?: boolean;
  ariaLabel: string;
  onCommit: (next: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  const start = () => {
    setVal(value === undefined ? "" : String(value));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = val.trim().replace(/,/g, "");
    if (!trimmed) {
      if (value !== undefined) onCommit(null);
      return;
    }
    const n = integer ? parseInt(trimmed, 10) : parseFloat(trimmed);
    if (!Number.isFinite(n) || n < 0) return;
    if (n !== value) onCommit(n);
  };

  if (editing) {
    return (
      <input
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        autoFocus
        aria-label={ariaLabel}
        value={val}
        placeholder="留空清除"
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="mt-1 h-7 w-full rounded-[6px] bg-surface px-1.5 font-mono text-sm font-semibold text-ink outline-none shadow-[0_0_0_1px_var(--accent)]"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      title="点一下记录或修改余量"
      className="-mx-1 mt-0.5 flex h-7 items-baseline gap-1 rounded-[6px] px-1 text-left transition-colors duration-[120ms] hover:bg-fill"
    >
      {value !== undefined ? (
        <>
          <span className="truncate text-lg font-semibold leading-7 tnum text-ink">
            {integer || Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 1 })}
          </span>
          {unit && <span className="shrink-0 text-xs text-ink-3">{unit}</span>}
        </>
      ) : (
        <span className="text-xs text-ink-3">点此记录</span>
      )}
    </button>
  );
}

function FamilySeatMenu({ a }: { a: Account }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const p = a.perks;
  const role = p?.family_role || "";
  const used = (p?.family_members || 0) + (p?.family_pending || 0);
  const freeSeats = Math.max(0, 6 - Math.max(1, used));

  const label =
    role === "manager"
      ? `家长 · 空 ${freeSeats}/5`
      : role === "member"
        ? "家庭成员"
        : role === "none"
          ? "未建组"
          : "未记席位";

  const choices: { label: string; hint?: string; role: "none" | "manager" | "member" | ""; members: number }[] = [
    { label: "未建家庭组", hint: "可拉 5 人", role: "none", members: 0 },
    { label: "家长 · 空 5/5", hint: "仅自己 1 人", role: "manager", members: 1 },
    { label: "家长 · 空 4/5", hint: "已占 2 人", role: "manager", members: 2 },
    { label: "家长 · 空 3/5", hint: "已占 3 人", role: "manager", members: 3 },
    { label: "家长 · 空 2/5", hint: "已占 4 人", role: "manager", members: 4 },
    { label: "家长 · 空 1/5", hint: "已占 5 人", role: "manager", members: 5 },
    { label: "家长 · 已满 (0/5)", hint: "满员 6 人", role: "manager", members: 6 },
    { label: "家庭组成员", hint: "共享主号权益", role: "member", members: 0 },
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-xs text-ink-2 transition-colors duration-[120ms] hover:bg-fill hover:text-ink"
      >
        <span className="tnum">{label}</span>
        <ChevronDown size={11} strokeWidth={2} className="text-ink-3" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref}>
        <Menu
          onClose={() => setOpen(false)}
          items={choices.map((c) => ({
            label: c.label,
            hint: c.hint,
            checked: role === c.role && (c.role !== "manager" || (p?.family_members || 1) === c.members),
            onSelect: () => patchPerks(a, { family_role: c.role, family_members: c.members, family_pending: 0 }),
          }))}
        />
      </Popover>
    </>
  );
}

/* ───────── 资料 ───────── */

function DetailsCard({ a }: { a: Account }) {
  const defaultProxy = useStore(app, (s) => s.settings?.default_proxy || "");
  const [confirmDetach, setConfirmDetach] = useState(false);
  const detachRef = useRef<HTMLButtonElement>(null);
  const rows: [string, React.ReactNode][] = [
    ["首次登录", `${a.login_date}（${a.login_days} 天前）`],
    ["风控期", `${a.risk_days} 天`],
    ["改密日期", a.pwd_changed_date || "本次登录后还没改"],
    ["代理", a.proxy || (defaultProxy ? `默认 · ${defaultProxy}` : "直连")],
    [
      "浏览器",
      a.chrome_profile ? (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className="truncate">日常 Chrome · {a.chrome_profile}</span>
          <button
            ref={detachRef}
            type="button"
            onClick={() => setConfirmDetach(true)}
            className="shrink-0 text-xs font-medium text-accent hover:underline"
          >
            改为自带
          </button>
        </span>
      ) : (
        "自带独立浏览器"
      ),
    ],
  ];
  return (
    <Card>
      <CardTitle
        right={
          <Button size="xs" variant="ghost" icon={Pencil} onClick={() => app.set({ sheet: { kind: "edit", id: a.id } })}>
            编辑
          </Button>
        }
      >
        资料
      </CardTitle>
      <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="selectable min-w-0 truncate text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      <Tooltip label={a.profile_path}>
        <button type="button" onClick={() => copyPlain(a.profile_path, "资料目录路径已复制")} className="mt-2 flex max-w-full items-center gap-1 truncate text-2xs text-ink-3 hover:text-ink-2">
          <Copy size={10} strokeWidth={2} className="shrink-0" />
          <span className="truncate font-mono">{a.profile_path}</span>
        </button>
      </Tooltip>
      <ConfirmPop
        open={confirmDetach}
        onClose={() => setConfirmDetach(false)}
        anchor={detachRef}
        title="把这个号换成自带独立浏览器？"
        message="只改当前这一个号，不影响其它账号。下次打开需要登录一次（头像会保留）。"
        confirmLabel="换成自带"
        onConfirm={() => detachOneChrome(a)}
      />
    </Card>
  );
}
