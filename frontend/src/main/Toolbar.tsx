import { AnimatePresence, motion } from "motion/react";
import { ArrowDownUp, Search, Tag, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { app, select, visibleAccounts } from "../lib/app";
import { accountNeedsAuth, accountNeedsPassword, healthOf, type Filter, type Sort } from "../lib/health";
import { useStore, shallowEqual } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { IconButton, Kbd, cx } from "../ui/button";
import { TagChip, tagHue } from "../ui/display";
import { Segmented, type SegItem } from "../ui/form";
import { Menu, Popover } from "../ui/overlay";

export function Toolbar() {
  const counts = useStore(
    app,
    (s) => {
      const c = { all: 0, disabled: 0, password: 0, auth: 0, risk: 0, changed: 0 };
      for (const a of visibleAccounts(s)) {
        const h = healthOf(a);
        c.all++;
        if (a.service_disabled) c.disabled++;
        if (accountNeedsPassword(a)) c.password++;
        if (accountNeedsAuth(a)) c.auth++;
        if (h === "risk") c.risk++;
        if (h === "changed") c.changed++;
      }
      return c;
    },
    shallowEqual,
  );
  const filter = useStore(app, (s) => s.filter);
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
        <TagFilter />
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

const sorts: { value: Sort; label: string }[] = [
  { value: "smart", label: "在用、能用的在前" },
  { value: "days", label: "按登录天数" },
  { value: "quota", label: "按剩余额度" },
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
          items={sorts.map((x) => ({ label: x.label, checked: x.value === sort, onSelect: () => app.set({ sort: x.value }) }))}
        />
      </Popover>
    </>
  );
}
