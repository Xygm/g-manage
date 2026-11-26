import type { Account } from "./types";
import { humanQuotaError } from "./format";

/**
 * 系统替用户判断的「健康状态」，优先级从高到低：
 *  pending 新密码待确认（不处理可能丢密码）
 *  due     风控期已过，该改密
 *  revoked 授权过期，查不了额度
 *  unauth  从没授权
 *  risk    风控期内
 *  changed 本次登录后已改过密码
 */
export type Health = "pending" | "due" | "revoked" | "unauth" | "risk" | "changed";

export function healthOf(a: Account): Health {
  if (a.has_pending_password) return "pending";
  if (a.status === "due") return "due";
  if (a.has_token && a.quota_error && humanQuotaError(a.quota_error).revoked) return "revoked";
  if (!a.has_token) return "unauth";
  if (a.status === "risk") return "risk";
  return "changed";
}

export const needsPassword = (h: Health) => h === "pending" || h === "due";
export const needsAuth = (h: Health) => h === "revoked" || h === "unauth";

const order: Record<Health, number> = { pending: 0, due: 1, revoked: 2, risk: 3, unauth: 4, changed: 5 };

export type Sort = "smart" | "email" | "days" | "quota";

function minQuota(a: Account): number {
  let m = 2;
  for (const g of a.quota?.groups || []) for (const b of g.buckets || []) m = Math.min(m, b.remaining_fraction);
  return m;
}

export function comparer(sort: Sort): (x: Account, y: Account) => number {
  switch (sort) {
    case "email":
      return (x, y) => x.email.localeCompare(y.email);
    case "days":
      return (x, y) => y.login_days - x.login_days || x.id - y.id;
    case "quota":
      return (x, y) => minQuota(y) - minQuota(x) || x.id - y.id;
    default:
      return compareAccounts;
  }
}

export function compareAccounts(x: Account, y: Account): number {
  const hx = healthOf(x);
  const hy = healthOf(y);
  return order[hx] - order[hy] || (hx === "risk" ? x.risk_left - y.risk_left : 0) || x.id - y.id;
}

/** 筛选按「要做什么」分：改密一类、授权一类。 */
export type Filter = "all" | "password" | "auth" | "risk" | "changed";

export function matchesFilter(a: Account, f: Filter): boolean {
  const h = healthOf(a);
  switch (f) {
    case "all":
      return true;
    case "password":
      return needsPassword(h);
    case "auth":
      return needsAuth(h);
    case "risk":
      return h === "risk";
    case "changed":
      return h === "changed";
  }
}

/** 胶囊文案：一眼看懂原因。 */
export function healthLabel(a: Account): { text: string; hint: string } {
  switch (healthOf(a)) {
    case "pending":
      return { text: "待确认新密码", hint: "改密还没收尾，点「我改好了」才会替换旧密码" };
    case "due":
      return { text: `该改密 · 已满 ${a.risk_days} 天`, hint: "风控期已过，可以改密码了" };
    case "revoked":
      return { text: "授权过期", hint: "重新授权后才能看额度、切号" };
    case "unauth":
      return { text: "未授权", hint: "授权后可以看额度、切号" };
    case "risk":
      return { text: `风控中 · 剩 ${a.risk_left} 天`, hint: `已登录 ${a.login_days} 天，风控期 ${a.risk_days} 天` };
    case "changed":
      return { text: "已改密", hint: a.pwd_changed_date ? `${a.pwd_changed_date} 改的` : "" };
  }
}
