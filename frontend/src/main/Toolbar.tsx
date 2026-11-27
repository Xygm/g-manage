import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowDownUp, Check, Crown, Search, SlidersHorizontal, Sparkles, Tag, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { app, resetListViewAuto, select, setListView, toggleListCol, visibleAccounts } from "../lib/app";
import { countColumnData, desiredColumns, LIST_COLUMNS } from "../lib/columns";
import { accountNeedsAuth, accountNeedsPassword, hasUrgentBilling, healthOf, isPaidAccount, type Filter, type Sort } from "../lib/health";
import { useStore, shallowEqual } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { IconButton, Kbd, Tooltip, cx } from "../ui/button";
import { TagChip, tagHue } from "../ui/display";
import { Segmented, Switch, type SegItem } from "../ui/form";
import { Menu, Popover } from "../ui/overlay";

export function Toolbar() {
  const counts = useStore(
    app,
    (s) => {
      const c = { all: 0, disabled: 0, password: 0, auth: 0, risk: 0, changed: 0, billing: 0, paid: 0 };
      for (const a of visibleAccounts(s)) {
        const h = healthOf(a);
        c.all++;
        if (a.service_disabled) c.disabled++;
        if (accountNeedsPassword(a)) c.password++;
        if (accountNeedsAuth(a)) c.auth++;
        if (h === "risk") c.risk++;
        if (h === "changed") c.changed++;
        if (hasUrgentBilling(a)) c.billing++;
        if (isPaidAccount(a)) c.paid++;
      }
      return c;
    },
    shallowEqual,
  );
  const filter = useStore(app, (s) => s.filter);
  const scope = useStore(app, (s) => s.scope);
  const segWrap = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = segWrap.current;
    if (!el) return;
    const check = () => setCanScrollRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, []);

  const items: SegItem<Filter>[] = [
    { value: "all", label: "全部", count: counts.all },
    ...(counts.disabled > 0 || filter === "disabled"
      ? [{ value: "disabled" as const, label: "已停用", count: counts.disabled, tone: "danger" as const, title: "Antigravity 对话服务被限制、需申诉或待审核的号" }]
      : []),
    { value: "password", label: "待改密", count: counts.password, tone: "warn", title: "风控期已过该改密的号，以及改密还没收尾的号" },
    { value: "auth", label: "授权异常", count: counts.auth, tone: "danger", title: "没授权或授权过期的号：看不了额度、切不了号" },
    { value: "risk", label: "风控中", count: counts.risk, title: "还在风控期内的号" },
    { value: "changed", label: "已改密", count: counts.changed },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1.5 pt-0.5">
      <div
        ref={segWrap}
        className="no-scrollbar -mx-1 max-w-full overflow-x-auto px-1"
        style={canScrollRight ? { WebkitMaskImage: "linear-gradient(90deg, #000 calc(100% - 28px), transparent)", maskImage: "linear-gradient(90deg, #000 calc(100% - 28px), transparent)" } : undefined}
      >
        <Segmented id="filter" items={items} value={filter} onChange={(f) => app.set({ filter: f })} />
      </div>
      <div className="flex min-w-[220px] flex-1 items-center justify-end gap-1.5 sm:flex-initial">
        <AnimatePresence initial={false}>
          {(counts.billing > 0 || scope === "billing") && (
            <motion.button
              key="billing-scope"
              type="button"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1, transition: spring.snap }}
              exit={{ opacity: 0, scale: 0.9, transition: fade.out }}
              title="5 天内即将自动扣费或已过扣费日待核实的号"
              onClick={() => app.set({ scope: scope === "billing" ? "all" : "billing" })}
              className={cx(
                "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors duration-[120ms]",
                scope === "billing" ? "bg-danger-dot text-white shadow-thumb" : "bg-danger-soft text-danger hover:brightness-95",
              )}
            >
              <AlertTriangle size={12} strokeWidth={2.2} />
              <span className="tnum">{counts.billing} 待退订</span>
            </motion.button>
          )}
        </AnimatePresence>
        {(counts.paid > 0 || scope === "paid") && (
          <Tooltip label={scope === "paid" ? `正在只看 Pro / Ultra（共 ${counts.paid} 个），再点恢复全部` : `只看 Pro / Ultra 会员号（${counts.paid} 个）`}>
            <IconButton
              icon={Crown}
              label="只看 Pro / Ultra 会员号"
              active={scope === "paid"}
              onClick={() => app.set({ scope: scope === "paid" ? "all" : "paid" })}
              className={cx(scope === "paid" && "!text-violet")}
            />
          </Tooltip>
        )}
        <TagFilter />
        <ColumnsMenu />
        <SortMenu />
        <SearchBox />
      </div>
    </div>
  );
}

function SearchBox() {
  const query = useStore(app, (s) => s.query);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className="relative flex h-7 min-w-0 flex-1 items-center sm:w-56 sm:flex-initial">
      <Search size={13} strokeWidth={2} className="pointer-events-none absolute left-2.5 text-ink-3" />
      <input
        id="list-search"
        ref={ref}
        type="text"
        value={query}
        placeholder="搜邮箱、备注、标签"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => app.set({ query: e.target.value.trim().toLowerCase() })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (query) app.set({ query: "" });
            ref.current?.blur();
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            ref.current?.blur();
            const target =
              document.querySelector<HTMLElement>("[data-row][aria-selected=true]") ??
              document.querySelector<HTMLElement>("[data-row]");
            if (target) {
              const id = Number(target.dataset.row);
              if (id) select(id);
              target.focus();
            }
          }
        }}
        className="h-7 w-full rounded-[8px] bg-surface pl-7 pr-8 text-sm text-ink shadow-raised outline-none placeholder:text-ink-3 transition-shadow duration-[120ms] focus:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-soft)]"
      />
      <span className="absolute right-1.5 grid place-items-center">
        <AnimatePresence initial={false} mode="popLayout">
          {query ? (
            <motion.button
              key="x"
              type="button"
              aria-label="清空搜索"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: spring.press }}
              exit={{ opacity: 0, scale: 0.6, transition: fade.out }}
              onClick={() => {
                app.set({ query: "" });
                ref.current?.focus();
              }}
              className="grid size-5 place-items-center rounded-full bg-fill-strong text-ink-2 hover:text-ink"
            >
              <X size={11} strokeWidth={2.4} />
            </motion.button>
          ) : (
            <motion.span key="k" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
              <Kbd>/</Kbd>
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </label>
  );
}

function TagFilter() {
  const tag = useStore(app, (s) => s.tag);
  const colors = useStore(app, (s) => s.settings?.tag_colors);
  const tagCounts = useStore(
    app,
    (s) => {
      const m: Record<string, number> = {};
      for (const a of visibleAccounts(s)) for (const t of a.tags) m[t] = (m[t] || 0) + 1;
      return m;
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  const tags = useMemo(() => Object.keys(tagCounts).sort((x, y) => x.localeCompare(y, "zh-CN")), [tagCounts]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!tags.length && !tag) return null; // 没有标签时不出现
  return (
    <>
      {tag ? (
        <span className="inline-flex shrink-0 items-center">
          <TagChip tag={tag} hue={tagHue(tag, colors)} active className="h-7 pr-1 text-sm">
            <button type="button" aria-label="取消标签筛选" onClick={() => app.set({ tag: "" })} className="ml-0.5 grid size-5 place-items-center rounded-full hover:bg-[var(--h-bg)]">
              <X size={11} strokeWidth={2.4} />
            </button>
          </TagChip>
        </span>
      ) : null}
      <IconButton ref={ref} icon={Tag} label="按标签筛选" active={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} className="max-h-[360px] w-[220px] overflow-y-auto thin-scroll">
        <Menu
          onClose={() => setOpen(false)}
          items={tags.map((t) => ({
            label: t,
            hint: String(tagCounts[t]),
            checked: t === tag,
            onSelect: () => app.set({ tag: t === tag ? "" : t }),
          }))}
        />
      </Popover>
    </>
  );
}

function ColumnsMenu() {
  const listView = useStore(app, (s) => s.listView);
  const sort = useStore(app, (s) => s.sort);
  const accounts = useStore(app, visibleAccounts);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  const counts = useMemo(() => countColumnData(accounts), [accounts]);
  const resolved = useMemo(() => desiredColumns(accounts, listView, sort), [accounts, listView, sort]);
  const isCustom = listView.mode === "custom";

  const perksCols = LIST_COLUMNS.filter((c) => c.group === "perks");
  const coreCols = LIST_COLUMNS.filter((c) => c.group === "core");

  return (
    <>
      <span className="relative inline-flex">
        <IconButton
          ref={ref}
          icon={SlidersHorizontal}
          label={isCustom ? "列表显示项（已自定义）" : "配置列表显示的权益与指标列"}
          active={open}
          onClick={() => setOpen((v) => !v)}
        />
        {isCustom && <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} className="w-[260px] p-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 rounded-[8px] bg-surface-2 px-2.5 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-xs font-semibold text-ink">
                <Sparkles size={12} strokeWidth={2.1} className="text-accent" />
                <span>智能自动显示</span>
              </div>
              <p className="mt-0.5 whitespace-nowrap text-2xs text-ink-3">有数据的列自动显示，无则隐藏</p>
            </div>
            <Switch
              checked={!isCustom}
              label="智能自动显示列表列"
              onChange={(auto) => {
                if (auto) resetListViewAuto();
                else setListView({ mode: "custom", cols: resolved });
              }}
            />
          </div>

          <p className="px-2 pt-1.5 text-2xs font-semibold tracking-[0.03em] text-ink-3">会员与附赠权益列</p>
          {perksCols.map((c) => {
            const on = resolved[c.id];
            const cnt = counts[c.id];
            return (
              <button
                key={c.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggleListCol(c.id, resolved)}
                className="flex h-7 items-center gap-2 rounded-[7px] px-2 text-left text-sm text-ink transition-colors duration-[80ms] hover:bg-fill"
              >
                <span
                  className={cx(
                    "grid size-4 shrink-0 place-items-center rounded-[4.5px] transition-colors duration-[120ms]",
                    on ? "bg-accent text-accent-fg" : "bg-fill shadow-[inset_0_0_0_1px_var(--line-strong)]",
                  )}
                >
                  {on && <Check size={11} strokeWidth={2.8} />}
                </span>
                <span className="flex-1 truncate">{c.label}</span>
                <span className="text-2xs tnum text-ink-3">{cnt > 0 ? `${cnt} 号` : "暂无"}</span>
              </button>
            );
          })}

          <div className="mx-1.5 my-0.5 h-px bg-line" />
          <p className="px-2 pt-0.5 text-2xs font-semibold tracking-[0.03em] text-ink-3">基础信息列</p>
          {coreCols.map((c) => {
            const on = resolved[c.id];
            const cnt = counts[c.id];
            return (
              <button
                key={c.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggleListCol(c.id, resolved)}
                className="flex h-7 items-center gap-2 rounded-[7px] px-2 text-left text-sm text-ink transition-colors duration-[80ms] hover:bg-fill"
              >
                <span
                  className={cx(
                    "grid size-4 shrink-0 place-items-center rounded-[4.5px] transition-colors duration-[120ms]",
                    on ? "bg-accent text-accent-fg" : "bg-fill shadow-[inset_0_0_0_1px_var(--line-strong)]",
                  )}
                >
                  {on && <Check size={11} strokeWidth={2.8} />}
                </span>
                <span className="flex-1 truncate">{c.label}</span>
                {c.id !== "status" && <span className="text-2xs tnum text-ink-3">{cnt > 0 ? `${cnt} 号` : "暂无"}</span>}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

const sorts: { value: Sort; label: string }[] = [
  { value: "smart", label: "在用、能用的在前" },
  { value: "renewal", label: "按扣费/到期日" },
  { value: "flow", label: "按剩余 Flow 积分" },
  { value: "colab", label: "按剩余 Colab CU" },
  { value: "api", label: "按 API 赠金状态" },
  { value: "quota", label: "按反重力剩余额度" },
  { value: "days", label: "按登录天数" },
  { value: "email", label: "按邮箱" },
];

function SortMenu() {
  const sort = useStore(app, (s) => s.sort);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={ref} icon={ArrowDownUp} label={`排序：${sorts.find((x) => x.value === sort)?.label}`} active={open || sort !== "smart"} onClick={() => setOpen((v) => !v)} className={cx(sort !== "smart" && "text-accent")} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref}>
        <Menu
          onClose={() => setOpen(false)}
          items={sorts.map((x) => ({ label: x.label, checked: x.value === sort, onSelect: () => app.set({ sort: x.value, sortDesc: true }) }))}
        />
      </Popover>
    </>
  );
}
