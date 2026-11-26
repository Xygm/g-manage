import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { AlertTriangle, Download, Globe, Plus, SearchX, Sparkles } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { app, clientsOf, CLIENTS, copyTotp, filteredAccounts, openTarget, select } from "../lib/app";
import { healthLabel, healthOf, type Health } from "../lib/health";
import { humanQuotaError, pct, poolRemaining } from "../lib/format";
import { modLabel } from "../lib/bridge";
import { useStore, shallowEqual } from "../lib/store";
import { fade, spring } from "../lib/motion";
import type { Account } from "../lib/types";
import { Button, IconButton, Tooltip, cx, useFlash } from "../ui/button";
import { Avatar, Pill, QuotaBar, TagChip, TotpDigits, TotpRing, tagHue, type PillTone } from "../ui/display";

const ROW_H = 54;
const OVERSCAN = 8;

export function AccountList() {
  const loaded = useStore(app, (s) => s.loaded);
  const loadError = useStore(app, (s) => s.loadError);
  const list = useStore(app, filteredAccounts);
  const total = useStore(app, (s) => s.accounts.length - s.hidden.length);
  const viewKey = useStore(app, (s) => `${s.filter}|${s.tag}|${s.sort}|${s.query ? "q" : ""}`);
  const filter = useStore(app, (s) => s.filter);
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: 0, height: 900 });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      setRange((prev) => (prev.top === el.scrollTop && prev.height === el.clientHeight ? prev : { top: el.scrollTop, height: el.clientHeight || 900 }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    sync();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [loaded, total]);

  // 切换筛选条件时回到列表顶部，保留已挂载行节点复用，避免大批量销毁重建。
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [viewKey]);

  if (!loaded) return <Skeleton />;
  if (loadError) return <Empty icon={AlertTriangle} title="读不到账号数据" desc={loadError} />;
  if (!total) {
    return (
      <Empty icon={Sparkles} title="还没有账号" desc="从日常 Chrome 里导入已登录的号，或者手动加一个">
        <Button icon={Download} onClick={() => app.set({ sheet: { kind: "import" } })}>
          从 Chrome 导入
        </Button>
        <Button variant="primary" icon={Plus} onClick={() => app.set({ sheet: { kind: "add" } })}>
          添加账号
        </Button>
      </Empty>
    );
  }

  if (list.length === 0) {
    return (
      <div ref={scroller} role="listbox" aria-label="账号" className="h-full overflow-hidden">
        <EmptyFiltered filter={filter} />
      </div>
    );
  }

  const virtual = list.length > 36;
  const start = virtual ? Math.max(0, Math.floor(range.top / ROW_H) - OVERSCAN) : 0;
  const end = virtual ? Math.min(list.length, Math.ceil((range.top + range.height) / ROW_H) + OVERSCAN) : list.length;
  const slice = virtual ? list.slice(start, end) : list;
  const padTop = start * ROW_H;
  const padBottom = (list.length - end) * ROW_H;

  return (
    <div ref={scroller} role="listbox" aria-label="账号" className="thin-scroll @container relative h-full overflow-y-auto overscroll-contain">
      <LayoutGroup id={`list-${viewKey}`}>
        <div className="relative p-1" style={virtual ? { paddingTop: padTop + 4, paddingBottom: padBottom + 4 } : undefined}>
          {virtual ? (
            slice.map((a) => <Row key={a.id} a={a} viewKey={viewKey} animated={false} />)
          ) : (
            <AnimatePresence initial={false}>
              {slice.map((a) => (
                <Row key={a.id} a={a} viewKey={viewKey} animated />
              ))}
            </AnimatePresence>
          )}
        </div>
      </LayoutGroup>
      <ScrollSelectedIntoView scroller={scroller} list={list} />
    </div>
  );
}

/** 按行号精确滚动，虚拟滚动下即使目标行尚未挂载也能一步到位。 */
function ScrollSelectedIntoView({ scroller, list }: { scroller: React.RefObject<HTMLDivElement | null>; list: Account[] }) {
  const id = useStore(app, (s) => s.selectedId);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !id) return;
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const rowTop = idx * ROW_H + 4;
    const rowBottom = rowTop + ROW_H + 4;
    if (rowTop < el.scrollTop) el.scrollTop = Math.max(0, rowTop - 4);
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
  }, [id, list, scroller]);
  return null;
}

const toneOf: Record<Health, PillTone> = { disabled: "danger", pending: "warn", due: "warn", revoked: "danger", unauth: "neutral", risk: "neutral", changed: "ok" };

const Row = memo(function Row({ a, viewKey, animated }: { a: Account; viewKey: string; animated: boolean }) {
  const selected = useStore(app, (s) => s.selectedId === a.id);
  const clients = useStore(app, (s) => clientsOf(s, a.id), (x, y) => x.length === y.length && x.every((c, i) => c.target === y[i].target));
  const awaiting = useStore(app, (s) => s.awaitingAuth.includes(a.id));
  const flashAt = useStore(app, (s) => (s.flash?.id === a.id ? s.flash.at : 0));
  const colors = useStore(app, (s) => s.settings?.tag_colors);
  const tag = useStore(app, (s) => s.tag);
  const h = healthOf(a);
  const label = healthLabel(a);
  const qerr = a.has_token && a.quota_error ? humanQuotaError(a.quota_error) : null;
  const g = poolRemaining(a.quota, "gemini");
  const c = poolRemaining(a.quota, "claude");

  const inner = (
    <div
      data-row={a.id}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onMouseDown={() => select(a.id)}
      onFocus={() => select(a.id)}
      onDoubleClick={() => openTarget(a, "browser")}
      className="group relative flex h-[54px] items-center gap-3 rounded-[10px] px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {/* 选中高亮：同一视图内在行间滑动，不跨筛选飞入 */}
      {selected && <motion.span layoutId={`row-selection-${viewKey}`} transition={spring.snap} className="absolute inset-0 rounded-[10px] bg-accent-soft" />}
      {!selected && <span className="absolute inset-0 rounded-[10px] transition-colors duration-[120ms] group-hover:bg-fill/60" />}
      {flashAt > 0 && <motion.span key={flashAt} initial={{ opacity: 0.9 }} animate={{ opacity: 0, transition: { duration: 0.6, ease: "easeOut" } }} className="pointer-events-none absolute inset-0 rounded-[10px] bg-ok-soft" />}

      <Avatar src={a.has_avatar ? `/api/accounts/${a.id}/avatar` : undefined} email={a.email} size={30} className="relative" />

      <div className="relative min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-base font-medium text-ink">{a.email}</span>
          {clients.map((cl) => (
            <Tooltip key={cl.target} label={`${CLIENTS[cl.target].name} 正在用这个号`}>
              <span className="shrink-0 rounded-[5px] bg-accent px-1 text-2xs font-semibold leading-4 text-accent-fg">{CLIENTS[cl.target].short}</span>
            </Tooltip>
          ))}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
          {/* 窄行：状态写在第二行 */}
          <span className="@3xl:hidden">
            <StatusText a={a} h={h} awaiting={awaiting} />
          </span>
          {a.note && <span className="truncate @3xl:max-w-none">{a.note}</span>}
          {a.tags.length > 0 && (
            <span className="hidden min-w-0 items-center gap-1 @xl:flex @3xl:hidden">
              {a.tags.slice(0, 2).map((t) => (
                <TagChip key={t} tag={t} hue={tagHue(t, colors)} active={tag === t} className="h-4 text-2xs" />
              ))}
            </span>
          )}
        </div>
      </div>

      {/* 宽行：标签、状态、额度、2FA 各自固定列宽，整列严格垂直对齐 */}
      <div className="relative hidden w-[148px] shrink-0 items-center gap-1 overflow-hidden @3xl:flex">
        {a.tags.slice(0, 2).map((t) => (
          <TagChip
            key={t}
            tag={t}
            hue={tagHue(t, colors)}
            active={tag === t}
            onClick={(e) => {
              e.stopPropagation();
              app.set({ tag: tag === t ? "" : t });
            }}
          />
        ))}
        {a.tags.length > 2 && <span className="text-xs text-ink-3">+{a.tags.length - 2}</span>}
      </div>
      <div className="relative hidden w-[148px] shrink-0 @3xl:block">
        {awaiting ? (
          <Pill tone="accent" dot className="[&>span:first-child]:breathe">
            等待授权…
          </Pill>
        ) : (
          <Pill tone={toneOf[h]} dot={h !== "risk" && h !== "changed"} progress={h === "risk" && a.risk_days ? a.login_days / a.risk_days : undefined} title={label.hint}>
            {label.text}
          </Pill>
        )}
      </div>
      <div className="relative hidden w-[72px] shrink-0 @2xl:block">
        {a.service_disabled && a.appeal_at > 0 ? (
          <span className="text-xs text-ink-3">—</span>
        ) : a.has_token && a.quota ? (
          <Tooltip label={`Gemini ${g === null ? "—" : pct(g) + "%"} · Claude / GPT ${c === null ? "—" : pct(c) + "%"}（取 5 小时和每周里较低的）`}>
            <span className={cx("flex flex-col gap-[3px]", qerr && "opacity-50")}>
              <QuotaBar fraction={g} thin label="Gemini 剩余" />
              <QuotaBar fraction={c} thin label="Claude 剩余" className="[--bar-ok:var(--violet)]" />
            </span>
          </Tooltip>
        ) : qerr && !qerr.revoked ? (
          <Tooltip label={qerr.text}>
            <span className="inline-flex items-center gap-1 text-xs text-danger">
              <AlertTriangle size={12} strokeWidth={2} /> 没查到
            </span>
          </Tooltip>
        ) : (
          <span className="text-xs text-ink-3">—</span>
        )}
      </div>

      <div className="relative flex shrink-0 items-center justify-end gap-0.5">
        <div className="flex shrink-0 justify-end @lg:w-[96px]">{a.has_totp && <TotpButton a={a} />}</div>
        <IconButton
          icon={Globe}
          label="打开这个号的浏览器"
          kbd={modLabel("O")}
          onClick={(e) => {
            e.stopPropagation();
            openTarget(a, "browser");
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );

  if (!animated) return inner;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: ROW_H, transition: { height: spring.snap, opacity: fade.in } }}
      exit={{ opacity: 0, height: 0, transition: { height: spring.snap, opacity: fade.out } }}
      className="relative overflow-hidden"
    >
      {inner}
    </motion.div>
  );
});

function StatusText({ a, h, awaiting }: { a: Account; h: Health; awaiting: boolean }) {
  if (awaiting) return <span className="text-accent">等待授权…</span>;
  const l = healthLabel(a);
  const cls = h === "pending" || h === "due" ? "text-warn" : h === "revoked" || h === "disabled" ? "text-danger" : "";
  return <span className={cx("whitespace-nowrap", cls)}>{l.text}</span>;
}

/** 列表里直接点验证码复制：登录时最常用的动作。 */
function TotpButton({ a }: { a: Account }) {
  const code = useStore(app, (s) => s.totp.codes[String(a.id)]);
  const err = useStore(app, (s) => s.totp.errors[String(a.id)]);
  const timing = useStore(app, (s) => ({ end: s.totp.periodEnd, period: s.totp.period }), shallowEqual);
  const [done, flash] = useFlash();
  if (err) {
    return (
      <Tooltip label={`2FA 密钥有问题：${err}`}>
        <span className="px-2 text-xs text-danger">2FA 无效</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={done ? "已复制" : "点一下复制验证码"} kbd={modLabel("C")}>
      <motion.button
        type="button"
        whileTap={{ scale: 0.95 }}
        transition={spring.press}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={async (e) => {
          e.stopPropagation();
          select(a.id);
          if (await copyTotp(a)) flash();
        }}
        className={cx(
          "flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-sm font-medium transition-colors duration-[120ms]",
          done ? "bg-ok-soft text-ok" : "text-ink-2 hover:bg-fill hover:text-ink",
        )}
      >
        <TotpDigits code={code} />
        <TotpRing periodEnd={timing.end} period={timing.period} />
      </motion.button>
    </Tooltip>
  );
}

/* ───────── 空状态 / 加载 ───────── */

function Empty({ icon: Icon, title, desc, children }: { icon: typeof Sparkles; title: string; desc?: string; children?: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: spring.glide }} className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="grid size-12 place-items-center rounded-[14px] bg-fill text-ink-3">
        <Icon size={22} strokeWidth={1.7} />
      </span>
      <div>
        <p className="text-md font-semibold text-ink">{title}</p>
        {desc && <p className="mt-1 max-w-[340px] text-sm text-ink-3">{desc}</p>}
      </div>
      {children && <div className="mt-1 flex gap-2">{children}</div>}
    </motion.div>
  );
}

function EmptyFiltered({ filter }: { filter: string }) {
  const hasQuery = useStore(app, (s) => !!s.query || !!s.tag);
  const reset = () => app.set({ filter: "all", tag: "", query: "" });
  if (!hasQuery && filter === "disabled") return <Empty icon={Sparkles} title="没有服务停用的号" desc="Antigravity 对话服务受限的号会出现在这里" />;
  if (!hasQuery && filter === "password") return <Empty icon={Sparkles} title="手头改密的事都清了" desc="风控期满的号会自动出现在这里" />;
  if (!hasQuery && filter === "auth") return <Empty icon={Sparkles} title="授权都正常" desc="授权过期的号会自动出现在这里" />;
  return (
    <Empty icon={SearchX} title="没找到符合条件的号" desc="换个关键词，或者清空筛选看看">
      <Button onClick={reset}>清空筛选</Button>
    </Empty>
  );
}

function Skeleton() {
  const rows = useMemo(() => Array.from({ length: 9 }, (_, i) => i), []);
  return (
    <div className="p-1" aria-busy>
      {rows.map((i) => (
        <div key={i} className="flex h-[54px] items-center gap-3 px-2.5">
          <span className="skeleton size-[30px] rounded-full" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="skeleton h-3 w-[38%] rounded" />
            <span className="skeleton h-2.5 w-[22%] rounded" />
          </span>
          <span className="skeleton h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}
