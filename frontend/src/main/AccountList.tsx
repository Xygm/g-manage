import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { AlertTriangle, ArrowDown, ArrowUp, Download, Globe, Plus, SearchX, Sparkles } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { app, clientsOf, CLIENTS, copyTotp, filteredAccounts, openTarget, select, toggleSortBy, visibleAccounts } from "../lib/app";
import { resolveColumns, type ColSpec, type ResolvedLayout } from "../lib/columns";
import { billingAlertOf, healthLabel, healthOf, type Health, type Sort } from "../lib/health";
import {
  apiCreditAmountLabel, currentMonthStr, effectiveTier, fmtCompactNum, humanQuotaError,
  isPaidTier, pct, poolRemaining,
} from "../lib/format";
import { modLabel } from "../lib/bridge";
import { useStore, shallowEqual } from "../lib/store";
import { fade, spring } from "../lib/motion";
import type { Account, ListColId } from "../lib/types";
import { Button, IconButton, Tooltip, cx, useFlash } from "../ui/button";
import { Avatar, Pill, QuotaBar, TagChip, TierBadge, TotpDigits, TotpRing, tagHue, type PillTone } from "../ui/display";

const HEADER_H = 28;
const ROW_H = 54;
const OVERSCAN = 8;

export function AccountList() {
  const loaded = useStore(app, (s) => s.loaded);
  const loadError = useStore(app, (s) => s.loadError);
  const allVisible = useStore(app, visibleAccounts);
  const list = useStore(app, filteredAccounts);
  const total = allVisible.length;
  const viewKey = useStore(app, (s) => `${s.filter}|${s.scope}|${s.tag}|${s.sort}|${s.sortDesc ? "d" : "a"}|${s.query ? "q" : ""}`);
  const filter = useStore(app, (s) => s.filter);
  const sort = useStore(app, (s) => s.sort);
  const sortDesc = useStore(app, (s) => s.sortDesc);
  const listView = useStore(app, (s) => s.listView);
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: 0, height: 900, width: 860 });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      const top = el.scrollTop;
      const height = el.clientHeight || 900;
      const width = el.clientWidth || 860;
      setRange((prev) => (prev.top === top && prev.height === height && prev.width === width ? prev : { top, height, width }));
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

  const layout = useMemo(
    () => resolveColumns(allVisible, range.width, listView, sort),
    [allVisible, range.width, listView, sort],
  );

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
  const contentTop = Math.max(0, range.top - HEADER_H);
  const start = virtual ? Math.max(0, Math.floor(contentTop / ROW_H) - OVERSCAN) : 0;
  const end = virtual ? Math.min(list.length, Math.ceil((contentTop + range.height) / ROW_H) + OVERSCAN) : list.length;
  const slice = virtual ? list.slice(start, end) : list;
  const padTop = start * ROW_H;
  const padBottom = (list.length - end) * ROW_H;
  const curMonth = currentMonthStr();

  return (
    <div ref={scroller} role="listbox" aria-label="账号" className="thin-scroll relative h-full overflow-y-auto overscroll-contain">
      <ListHeader cols={layout.cols} count={list.length} sort={sort} sortDesc={sortDesc} />
      <LayoutGroup id={`list-${viewKey}`}>
        <div className="relative px-1 pb-1" style={virtual ? { paddingTop: padTop + 2, paddingBottom: padBottom + 4 } : { paddingTop: 2 }}>
          {virtual ? (
            slice.map((a, idx) => (
              <Row
                key={a.id}
                a={a}
                nextId={list[start + idx + 1]?.id}
                layout={layout}
                curMonth={curMonth}
                isLast={start + idx === list.length - 1}
                viewKey={viewKey}
                animated={false}
              />
            ))
          ) : (
            <AnimatePresence initial={false}>
              {slice.map((a, idx) => (
                <Row
                  key={a.id}
                  a={a}
                  nextId={slice[idx + 1]?.id}
                  layout={layout}
                  curMonth={curMonth}
                  isLast={idx === slice.length - 1}
                  viewKey={viewKey}
                  animated
                />
              ))}
            </AnimatePresence>
          )}
        </div>
      </LayoutGroup>
      <ScrollSelectedIntoView scroller={scroller} list={list} />
    </div>
  );
}

/* ───────── 28px 吸顶微表头：自明列义 + 点击列头直接排序 ───────── */

function ListHeader({
  cols,
  count,
  sort,
  sortDesc,
}: {
  cols: ColSpec[];
  count: number;
  sort: Sort;
  sortDesc: boolean;
}) {
  const emailActive = sort === "email";
  return (
    <div
      role="presentation"
      className="sticky top-0 z-20 flex h-[28px] select-none items-center gap-2 bg-[color-mix(in_srgb,var(--surface)_84%,transparent)] px-3.5 text-[11px] font-medium tracking-[0.02em] text-ink-3 shadow-[inset_0_-0.5px_0_var(--line-strong)] backdrop-blur-md backdrop-saturate-150"
    >
      <div className="flex min-w-0 flex-1 items-center">
        <button
          type="button"
          onClick={() => toggleSortBy("email")}
          className={cx(
            "-ml-1 inline-flex h-5 items-center gap-1 rounded-[5px] px-1 transition-colors duration-[100ms] hover:bg-fill/80 hover:text-ink-2",
            emailActive && "font-semibold text-accent hover:text-accent",
          )}
        >
          <span>账号</span>
          <span className="font-normal tnum text-ink-3/75">{count}</span>
          {emailActive && (sortDesc ? <ArrowUp size={10} strokeWidth={2.4} /> : <ArrowDown size={10} strokeWidth={2.4} />)}
        </button>
      </div>
      {cols.map((c) => {
        const active = !!c.sortKey && sort === c.sortKey && c.sortKey !== "smart";
        const right = c.align === "right";
        if (!c.sortKey) {
          return (
            <div key={c.id} style={{ width: c.width }} className={cx("shrink-0", right && "text-right")}>
              {c.shortLabel}
            </div>
          );
        }
        return (
          <div key={c.id} style={{ width: c.width }} className={cx("flex shrink-0 items-center", right ? "justify-end" : "justify-start")}>
            <button
              type="button"
              title={`点击按「${c.label}」排序`}
              onClick={() => toggleSortBy(c.sortKey!)}
              className={cx(
                "inline-flex h-5 items-center gap-0.5 rounded-[5px] px-1 transition-colors duration-[100ms] hover:bg-fill/80 hover:text-ink-2",
                right ? "-mr-1" : "-ml-1",
                active && "font-semibold text-accent hover:text-accent",
              )}
            >
              {right && active && (sortDesc ? <ArrowDown size={10} strokeWidth={2.4} /> : <ArrowUp size={10} strokeWidth={2.4} />)}
              <span>{c.shortLabel}</span>
              {!right && active && (sortDesc ? <ArrowDown size={10} strokeWidth={2.4} /> : <ArrowUp size={10} strokeWidth={2.4} />)}
            </button>
          </div>
        );
      })}
      <div className="w-[28px] shrink-0" aria-hidden />
    </div>
  );
}

/** 按行号精确滚动，并扣除 28px 吸顶表头高度，避免键盘 ↑ 切号时选中行钻到表头下面。 */
function ScrollSelectedIntoView({ scroller, list }: { scroller: React.RefObject<HTMLDivElement | null>; list: Account[] }) {
  const id = useStore(app, (s) => s.selectedId);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !id) return;
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const rowTop = HEADER_H + idx * ROW_H + 2;
    const rowBottom = rowTop + ROW_H + 4;
    if (rowTop < el.scrollTop + HEADER_H + 2) el.scrollTop = Math.max(0, rowTop - HEADER_H - 2);
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
  }, [id, list, scroller]);
  return null;
}

const toneOf: Record<Health, PillTone> = { disabled: "danger", pending: "warn", due: "warn", revoked: "danger", unauth: "neutral", risk: "neutral", changed: "ok" };

const Row = memo(function Row({
  a,
  nextId,
  layout,
  curMonth,
  isLast,
  viewKey,
  animated,
}: {
  a: Account;
  nextId?: number;
  layout: ResolvedLayout;
  curMonth: string;
  isLast: boolean;
  viewKey: string;
  animated: boolean;
}) {
  const selected = useStore(app, (s) => s.selectedId === a.id);
  const beforeSelected = useStore(app, (s) => nextId !== undefined && s.selectedId === nextId);
  const clients = useStore(app, (s) => clientsOf(s, a.id), (x, y) => x.length === y.length && x.every((c, i) => c.target === y[i].target));
  const awaiting = useStore(app, (s) => s.awaitingAuth.includes(a.id));
  const syncingPerks = useStore(app, (s) => s.syncingPerksIds.includes(a.id) || (s.syncingAllPerks && !a.chrome_profile && isPaidTier(effectiveTier(a))));
  const flashAt = useStore(app, (s) => (s.flash?.id === a.id ? s.flash.at : 0));
  const colors = useStore(app, (s) => s.settings?.tag_colors);
  const tag = useStore(app, (s) => s.tag);
  const h = healthOf(a);
  const label = healthLabel(a);
  const bill = billingAlertOf(a);
  const showBill = !!bill && h !== "disabled" && h !== "pending" && (bill.urgent || h === "risk" || h === "changed");
  const tier = a.service_disabled && a.appeal_at > 0 ? "" : effectiveTier(a);
  const paid = isPaidTier(tier);
  const qerr = a.has_token && a.quota_error ? humanQuotaError(a.quota_error) : null;
  const g = poolRemaining(a.quota, "gemini");
  const c = poolRemaining(a.quota, "claude");

  const hasSubLine = layout.hasInlineStatus || Boolean(a.note) || (layout.hasInlineTags && a.tags.length > 0);

  const inner = (
    <div
      data-row={a.id}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onMouseDown={() => select(a.id)}
      onFocus={() => select(a.id)}
      onDoubleClick={() => openTarget(a, "browser")}
      className={cx(
        "group relative flex h-[54px] items-center gap-2 rounded-[10px] px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        !selected && !beforeSelected && !isLast && "after:pointer-events-none after:absolute after:bottom-0 after:left-[48px] after:right-2.5 after:h-[0.5px] after:bg-line hover:after:opacity-0",
      )}
    >
      {/* 选中高亮：立体浮雕微内框 + 左侧 2.5px 指示锚条 */}
      {selected && (
        <motion.span
          layoutId={`row-selection-${viewKey}`}
          transition={spring.snap}
          className="pointer-events-none absolute inset-0 rounded-[10px] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--accent)_26%,transparent),inset_0_1px_0_rgb(255_255_255/0.08)]"
        >
          <span className="absolute left-1 top-1/2 h-[20px] w-[2.5px] -translate-y-1/2 rounded-full bg-accent" />
        </motion.span>
      )}
      {!selected && <span className="pointer-events-none absolute inset-0 rounded-[10px] transition-colors duration-[100ms] group-hover:bg-fill/55" />}
      {flashAt > 0 && (
        <motion.span
          key={flashAt}
          initial={{ opacity: 0.9 }}
          animate={{ opacity: 0, transition: { duration: 0.6, ease: "easeOut" } }}
          className="pointer-events-none absolute inset-0 rounded-[10px] bg-ok-soft"
        />
      )}

      <Avatar src={a.has_avatar ? `/api/accounts/${a.id}/avatar` : undefined} email={a.email} size={28} className="relative ml-0.5" />

      <div className="relative flex min-w-0 flex-1 flex-col justify-center pl-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className={cx("truncate text-[13.5px] tracking-[-0.008em] text-ink", selected ? "font-semibold" : "font-medium")}>{a.email}</span>
          <TierBadge tier={tier} />
          {clients.map((cl) => (
            <Tooltip key={cl.target} label={`${CLIENTS[cl.target].name} 正在用这个号`}>
              <span className="shrink-0 rounded-[5px] bg-accent px-1 text-2xs font-semibold leading-4 text-accent-fg shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)]">
                {CLIENTS[cl.target].short}
              </span>
            </Tooltip>
          ))}
        </div>
        {hasSubLine && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
            {layout.hasInlineStatus && <StatusText a={a} h={h} awaiting={awaiting} bill={showBill ? bill : null} />}
            {a.note && <span className="truncate">{a.note}</span>}
            {layout.hasInlineTags && a.tags.length > 0 && (
              <span className="flex min-w-0 shrink-0 items-center gap-1">
                {a.tags.slice(0, 2).map((t) => (
                  <TagChip
                    key={t}
                    tag={t}
                    hue={tagHue(t, colors)}
                    active={tag === t}
                    className="h-[17px] max-w-[5.5rem] text-2xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      app.set({ tag: tag === t ? "" : t });
                    }}
                  />
                ))}
                {a.tags.length > 2 && <span className="text-2xs text-ink-3">+{a.tags.length - 2}</span>}
              </span>
            )}
          </div>
        )}
      </div>

      {layout.cols.map((col) => (
        <RowCell
          key={col.id}
          colId={col.id}
          width={col.width}
          a={a}
          h={h}
          label={label}
          bill={bill}
          showBill={showBill}
          awaiting={awaiting}
          syncingPerks={syncingPerks}
          paid={paid}
          tier={tier}
          curMonth={curMonth}
          qerr={qerr}
          g={g}
          c={c}
          colors={colors}
          activeTag={tag}
        />
      ))}

      <div className="relative flex w-[28px] shrink-0 justify-end">
        <IconButton
          icon={Globe}
          label="打开这个号的独立浏览器"
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

/* ───────── 固定列宽单元格：像素级同轴对齐 + 三级静默空值 ───────── */

function QuietDash({ paid, hint }: { paid?: boolean; hint?: string }) {
  const dash = <span className={cx("block select-none text-right text-xs", paid ? "text-ink-3/65" : "text-ink-3/30")}>—</span>;
  return hint ? <Tooltip label={hint}>{dash}</Tooltip> : dash;
}

function PerksShimmer() {
  return <span className="ml-auto block h-2.5 w-8 rounded-full skeleton" />;
}

function RowCell({
  colId,
  width,
  a,
  h,
  label,
  bill,
  showBill,
  awaiting,
  syncingPerks,
  paid,
  tier,
  curMonth,
  qerr,
  g,
  c,
  colors,
  activeTag,
}: {
  colId: ListColId;
  width: number;
  a: Account;
  h: Health;
  label: { text: string; hint: string };
  bill: ReturnType<typeof billingAlertOf>;
  showBill: boolean;
  awaiting: boolean;
  syncingPerks: boolean;
  paid: boolean;
  tier: string;
  curMonth: string;
  qerr: ReturnType<typeof humanQuotaError> | null;
  g: number | null;
  c: number | null;
  colors: Record<string, string> | undefined;
  activeTag: string;
}) {
  const p = a.perks;
  const style = { width };

  switch (colId) {
    case "tags":
      return (
        <div style={style} className="relative flex shrink-0 items-center gap-1 overflow-hidden">
          {a.tags.slice(0, 2).map((t) => (
            <TagChip
              key={t}
              tag={t}
              hue={tagHue(t, colors)}
              active={activeTag === t}
              className="max-w-[4.7rem]"
              onClick={(e) => {
                e.stopPropagation();
                app.set({ tag: activeTag === t ? "" : t });
              }}
            />
          ))}
          {a.tags.length > 2 && <span className="shrink-0 text-2xs text-ink-3">+{a.tags.length - 2}</span>}
        </div>
      );

    case "status":
      return (
        <div style={style} className="relative shrink-0">
          {awaiting ? (
            <Pill tone="accent" dot className="[&>span:first-child]:breathe">
              等待授权…
            </Pill>
          ) : showBill && bill ? (
            <Pill tone={bill.tone} dot title={bill.hint}>
              {bill.text}
            </Pill>
          ) : h === "changed" ? (
            /* 健康常态不再用无边框漂浮胶囊，圆点与上方各行胶囊严格穿成一条垂直线 */
            <span title={label.hint} className="inline-flex h-[22px] max-w-full items-center gap-1.5 pl-2 text-xs text-ink-3">
              <span className="size-1.5 shrink-0 rounded-full bg-ok-dot/75" />
              <span className="truncate">已改密</span>
            </span>
          ) : (
            <Pill tone={toneOf[h]} dot={h !== "risk"} progress={h === "risk" && a.risk_days ? a.login_days / a.risk_days : undefined} title={label.hint}>
              {label.text}
            </Pill>
          )}
        </div>
      );

    case "flow": {
      if (syncingPerks && p?.flow_credits === undefined) {
        return (
          <div style={style} className="relative shrink-0">
            <PerksShimmer />
          </div>
        );
      }
      if (p?.flow_credits !== undefined) {
        const tip = `Flow 剩余 ${p.flow_credits.toLocaleString("en-US")} 积分${p.flow_next_grant_at ? ` · 下次到账 ${p.flow_next_grant_at}` : ""}`;
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={tip}>
              <span className={cx("block text-right text-sm font-medium tnum", p.flow_credits > 0 ? "text-ink" : "text-ink-3")}>
                {fmtCompactNum(p.flow_credits)}
              </span>
            </Tooltip>
          </div>
        );
      }
      return (
        <div style={style} className="relative shrink-0">
          <QuietDash paid={paid} hint={paid ? "会员号尚未同步 Flow 积分，可在右侧卡片点 ↻ 读取" : undefined} />
        </div>
      );
    }

    case "colab": {
      if (syncingPerks && p?.colab_cu === undefined) {
        return (
          <div style={style} className="relative shrink-0">
            <PerksShimmer />
          </div>
        );
      }
      if (p?.colab_cu !== undefined) {
        const gpuTip = p.colab_gpus?.length ? ` · 可用 ${p.colab_gpus.slice(0, 4).join(" / ")}` : "";
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={`Colab 剩余 ${p.colab_cu} 计算单元${gpuTip}`}>
              <span className={cx("flex items-baseline justify-end gap-0.5 text-sm font-medium tnum", p.colab_cu > 0 ? "text-ink" : "text-ink-3")}>
                <span>{fmtCompactNum(p.colab_cu)}</span>
                <span className="text-2xs font-normal text-ink-3">CU</span>
              </span>
            </Tooltip>
          </div>
        );
      }
      return (
        <div style={style} className="relative shrink-0">
          <QuietDash paid={paid} hint={paid ? "会员号尚未同步 Colab 算力" : undefined} />
        </div>
      );
    }

    case "api": {
      if (syncingPerks && p?.api_credit_balance === undefined && !p?.api_credit_claimed_month) {
        return (
          <div style={style} className="relative shrink-0">
            <PerksShimmer />
          </div>
        );
      }
      const claimedNow = p?.api_credit_claimed_month === curMonth;
      if (claimedNow && p?.api_credit_balance !== undefined) {
        const amt = p.api_credit_balance >= 100 ? `$${Math.round(p.api_credit_balance)}` : `$${p.api_credit_balance.toFixed(1).replace(/\.0$/, "")}`;
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={`本月 API 赠金已激活 · 剩余 $${p.api_credit_balance.toFixed(2)}${p.api_credit_total ? ` / $${p.api_credit_total}` : ""}`}>
              <span className={cx("block text-right text-sm font-medium tnum", p.api_credit_balance > 0 ? "text-ok" : "text-ink-3")}>{amt}</span>
            </Tooltip>
          </div>
        );
      }
      if (claimedNow) {
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={`已记录 ${curMonth} 开发者赠金已领取`}>
              <span className="block text-right text-xs font-medium text-ok">已领</span>
            </Tooltip>
          </div>
        );
      }
      if (paid) {
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={`本月 ${p?.api_credit_total ? `$${p.api_credit_total}/月` : apiCreditAmountLabel(tier)} 赠金待激活或确认`}>
              <span className="block text-right text-xs font-medium text-warn">待领</span>
            </Tooltip>
          </div>
        );
      }
      return (
        <div style={style} className="relative shrink-0">
          <QuietDash />
        </div>
      );
    }

    case "renewal": {
      if (syncingPerks && !p?.renewal_date) {
        return (
          <div style={style} className="relative shrink-0">
            <PerksShimmer />
          </div>
        );
      }
      if (p?.renewal_date) {
        const auto = p.billing_state === "auto_renew";
        const suffix = auto ? "续" : p.billing_state === "cancelled" ? "止" : "";
        const toneCls =
          bill?.urgent && bill.tone === "danger"
            ? "font-semibold text-danger"
            : bill
              ? "font-medium text-warn"
              : "text-ink-2";
        const tip = `${p.renewal_date} ${auto ? "自动扣费" : "到期"}${bill ? `（${bill.text}）` : ""}`;
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={tip}>
              <span className={cx("flex items-baseline justify-end gap-0.5 font-mono text-xs tnum", toneCls)}>
                <span>{p.renewal_date.slice(5)}</span>
                {suffix && <span className={cx("font-sans text-2xs", bill?.urgent ? "opacity-90" : "text-ink-3")}>{suffix}</span>}
              </span>
            </Tooltip>
          </div>
        );
      }
      if (p?.billing_state === "expired") {
        return (
          <div style={style} className="relative shrink-0 text-right text-xs text-ink-3">
            已到期
          </div>
        );
      }
      return (
        <div style={style} className="relative shrink-0">
          <QuietDash paid={paid} hint={paid ? "尚未记录订阅到期或扣费日" : undefined} />
        </div>
      );
    }

    case "quota": {
      if (a.service_disabled && a.appeal_at > 0) {
        return (
          <div style={style} className="relative shrink-0">
            <QuietDash />
          </div>
        );
      }
      if (a.has_token && a.quota) {
        const gp = g === null ? null : pct(g);
        const cp = c === null ? null : pct(c);
        const minP = gp !== null && cp !== null ? Math.min(gp, cp) : gp ?? cp;
        return (
          <div style={style} className="relative shrink-0">
            <Tooltip label={`Gemini ${gp === null ? "—" : gp + "%"} · Claude / GPT ${cp === null ? "—" : cp + "%"}（右侧显示较低池百分比）`}>
              <span className={cx("flex items-center justify-end gap-1", qerr && "opacity-50")}>
                <span className="flex w-[32px] shrink-0 flex-col gap-[3px]">
                  <QuotaBar fraction={g} thin label="Gemini 剩余" />
                  <QuotaBar fraction={c} thin label="Claude 剩余" className="[--bar-ok:var(--violet)]" />
                </span>
                <span
                  className={cx(
                    "w-[28px] shrink-0 text-right text-xs font-medium tnum",
                    minP === null ? "text-ink-3" : minP <= 0 ? "text-danger" : minP < 20 ? "text-warn" : "text-ink-2",
                  )}
                >
                  {minP === null ? "—" : `${minP}%`}
                </span>
              </span>
            </Tooltip>
          </div>
        );
      }
      if (qerr && !qerr.revoked) {
        return (
          <div style={style} className="relative flex shrink-0 justify-end">
            <Tooltip label={qerr.text}>
              <span className="inline-flex items-center gap-1 text-xs text-danger">
                <AlertTriangle size={11} strokeWidth={2.1} /> 异常
              </span>
            </Tooltip>
          </div>
        );
      }
      return (
        <div style={style} className="relative shrink-0">
          <QuietDash />
        </div>
      );
    }

    case "totp":
      return (
        <div style={style} className="relative flex shrink-0 justify-end">
          {a.has_totp && <TotpButton a={a} />}
        </div>
      );
  }
}

function StatusText({ a, h, awaiting, bill }: { a: Account; h: Health; awaiting: boolean; bill: ReturnType<typeof billingAlertOf> }) {
  if (awaiting) return <span className="text-accent">等待授权…</span>;
  if (bill) return <span className={cx("whitespace-nowrap", bill.tone === "danger" ? "text-danger" : "text-warn")}>{bill.text}</span>;
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
          "flex h-7 items-center gap-1 rounded-[8px] px-1 text-sm font-medium transition-colors duration-[120ms]",
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
  const scope = useStore(app, (s) => s.scope);
  const hasQuery = useStore(app, (s) => !!s.query || !!s.tag || s.scope !== "all");
  const reset = () => app.set({ filter: "all", scope: "all", tag: "", query: "" });
  if (scope === "billing" && !app.get().query && !app.get().tag) {
    return (
      <Empty icon={Sparkles} title="没有急着退订的号" desc="5 天内自动扣费的号会出现在这里">
        <Button onClick={reset}>查看全部账号</Button>
      </Empty>
    );
  }
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
