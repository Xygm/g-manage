import { effectiveTier, isPaidTier } from "./format";
import type { Sort } from "./health";
import type { Account, ListColId } from "./types";

export interface ListViewPrefs {
  mode: "auto" | "custom";
  cols: Record<ListColId, boolean>;
}

export interface ColSpec {
  id: ListColId;
  label: string;
  shortLabel: string;
  group: "perks" | "core";
  width: number;
  align: "left" | "right";
  sortKey?: Sort;
}

/** 列表可选列注册表（按从左到右的视觉展示顺序排列）。 */
export const LIST_COLUMNS: ColSpec[] = [
  { id: "tags", label: "账号标签", shortLabel: "标签", group: "core", width: 104, align: "left" },
  { id: "status", label: "安全与风控状态", shortLabel: "状态", group: "core", width: 126, align: "left", sortKey: "smart" },
  { id: "flow", label: "Flow 积分", shortLabel: "Flow", group: "perks", width: 52, align: "right", sortKey: "flow" },
  { id: "colab", label: "Colab 计算单元", shortLabel: "Colab", group: "perks", width: 56, align: "right", sortKey: "colab" },
  { id: "api", label: "API 月度赠金", shortLabel: "赠金", group: "perks", width: 44, align: "right", sortKey: "api" },
  { id: "renewal", label: "订阅账期 / 续费", shortLabel: "账期", group: "perks", width: 56, align: "right", sortKey: "renewal" },
  { id: "quota", label: "Antigravity 额度", shortLabel: "额度", group: "core", width: 66, align: "right", sortKey: "quota" },
  { id: "totp", label: "2FA 动态验证码", shortLabel: "2FA", group: "core", width: 82, align: "right" },
];

export const DEFAULT_CUSTOM_COLS: Record<ListColId, boolean> = {
  tags: true,
  status: true,
  flow: true,
  colab: true,
  api: true,
  renewal: true,
  quota: true,
  totp: true,
};

const STORAGE_KEY = "gam-list-view";

export function loadLocalListView(): ListViewPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ListViewPrefs>;
      const mode = parsed.mode === "custom" ? "custom" : "auto";
      return { mode, cols: { ...DEFAULT_CUSTOM_COLS, ...(parsed.cols || {}) } };
    }
  } catch {
    /* 忽略 */
  }
  return { mode: "auto", cols: { ...DEFAULT_CUSTOM_COLS } };
}

export function saveLocalListView(prefs: ListViewPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略 */
  }
}

/** 统计当前可见账号中各列有实际数据的账号数（既供「智能自动」判断，也显示在配置菜单右侧作参考）。 */
export function countColumnData(accounts: Account[]): Record<ListColId, number> {
  const c: Record<ListColId, number> = { tags: 0, status: accounts.length, flow: 0, colab: 0, api: 0, renewal: 0, quota: 0, totp: 0 };
  for (const a of accounts) {
    if (a.tags.length > 0) c.tags++;
    if (a.perks?.flow_credits !== undefined) c.flow++;
    if (a.perks?.colab_cu !== undefined) c.colab++;
    if (a.perks?.api_credit_balance !== undefined || a.perks?.api_credit_claimed_month || isPaidTier(effectiveTier(a))) c.api++;
    if (a.perks?.renewal_date || a.perks?.billing_state === "expired") c.renewal++;
    if (a.has_token && a.quota) c.quota++;
    if (a.has_totp) c.totp++;
  }
  return c;
}

/** 计算某个账号配置下「理想想要显示」的列开关。 */
export function desiredColumns(accounts: Account[], prefs: ListViewPrefs, sort: Sort): Record<ListColId, boolean> {
  const counts = countColumnData(accounts);
  const out: Record<ListColId, boolean> =
    prefs.mode === "custom"
      ? { ...DEFAULT_CUSTOM_COLS, ...prefs.cols }
      : {
          tags: counts.tags > 0,
          status: true,
          flow: counts.flow > 0,
          colab: counts.colab > 0,
          api: counts.api > 0 && (accounts.some((a) => a.perks?.api_credit_balance !== undefined || Boolean(a.perks?.api_credit_claimed_month))),
          renewal: counts.renewal > 0,
          quota: counts.quota > 0 || accounts.some((a) => a.has_token),
          totp: counts.totp > 0,
        };

  // 防呆联动：如果用户正按某项指标排序，确保该指标列可见，让排序依据一目了然。
  if (sort === "flow") out.flow = true;
  else if (sort === "colab") out.colab = true;
  else if (sort === "api") out.api = true;
  else if (sort === "renewal") out.renewal = true;
  else if (sort === "quota") out.quota = true;

  return out;
}

export interface ResolvedLayout {
  cols: ColSpec[];
  hasInlineTags: boolean;
  hasInlineStatus: boolean;
}

/**
 * 按容器实测净宽做确定性列预算分配（取代死板的 @3xl 断点）：
 * 保护左侧账号邮箱区至少 214px 宽度；空间吃紧时，优先把「标签」优雅退入第二行备注旁，绝不截断邮箱或挤乱数字。
 */
export function resolveColumns(accounts: Account[], containerWidth: number, prefs: ListViewPrefs, sort: Sort): ResolvedLayout {
  const want = desiredColumns(accounts, prefs, sort);
  const active = new Set<ListColId>(LIST_COLUMNS.filter((c) => want[c.id]).map((c) => c.id));

  // 外层内边距 (8px) + 行内边距 (20px) + 头像及间距 (38px) + 身份列后间距 (8px) + 浏览器按钮 (28px) = 102px 固定骨架
  const GAP = 8;
  const minIdentity = containerWidth < 560 ? 180 : 248;
  const fixedChrome = 102 + minIdentity;

  const totalWidth = () => {
    let sum = fixedChrome;
    for (const spec of LIST_COLUMNS) {
      if (active.has(spec.id)) sum += spec.width + GAP;
    }
    return sum;
  };

  // 低优先级先退让；正在用于排序的列排在最后退让。
  const dropOrder = (["tags", "api", "colab", "renewal", "flow", "status", "quota", "totp"] as ListColId[]).filter(
    (id) => LIST_COLUMNS.find((c) => c.id === id)?.sortKey !== sort,
  );

  for (const id of dropOrder) {
    if (totalWidth() <= containerWidth) break;
    active.delete(id);
  }

  return {
    cols: LIST_COLUMNS.filter((c) => active.has(c.id)),
    hasInlineTags: !active.has("tags"),
    hasInlineStatus: !active.has("status"),
  };
}
