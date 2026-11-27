import type { Account, ClientStatus } from "./types";
import { humanQuotaError } from "./format";

/**
 * 系统替用户判断的「健康状态」（决定胶囊文案），优先级从高到低：
 *  disabled Antigravity 对话服务被限制（需申诉或待审核）
 *  pending  新密码待确认（不处理可能丢密码）
 *  due      风控期已过，该改密
 *  revoked  授权过期，查不了额度
 *  unauth   从没授权
 *  risk     风控期内
 *  changed  本次登录后已改过密码
 */
export type Health = "disabled" | "pending" | "due" | "revoked" | "unauth" | "risk" | "changed";

export function healthOf(a: Account): Health {
  if (a.service_disabled) return "disabled";
  if (a.has_pending_password) return "pending";
  if (a.status === "due") return "due";
  if (a.has_token && a.quota_error && humanQuotaError(a.quota_error).revoked) return "revoked";
  if (!a.has_token) return "unauth";
  if (a.status === "risk") return "risk";
  return "changed";
}

export const needsPassword = (h: Health) => h === "pending" || h === "due";
export const needsAuth = (h: Health) => h === "revoked" || h === "unauth";
export const accountNeedsPassword = (a: Account) => a.has_pending_password || a.status === "due";
export const accountNeedsAuth = (a: Account) => !a.has_token || Boolean(a.quota_error && humanQuotaError(a.quota_error).revoked);

export type Sort = "smart" | "email" | "days" | "quota";

function minQuota(a: Account): number {
  let m = 2;
  for (const g of a.quota?.groups || []) for (const b of g.buckets || []) m = Math.min(m, b.remaining_fraction);
  return m;
}

/** clients 是各客户端当前登录的号，默认排序把这些号放最上面。 */
export function comparer(sort: Sort, clients: readonly ClientStatus[]): (x: Account, y: Account) => number {
  switch (sort) {
    case "email":
      return (x, y) => x.email.localeCompare(y.email);
    case "days":
      return (x, y) => y.login_days - x.login_days || x.id - y.id;
    case "quota":
      return (x, y) => minQuota(y) - minQuota(x) || x.id - y.id;
    default: {
      const inUse = new Set(clients.map((c) => c.account_id));
      return (x, y) => {
        const rx = rank(x, healthOf(x), inUse);
        return rx - rank(y, healthOf(y), inUse) || (rx === rankRisk ? x.risk_left - y.risk_left : 0) || x.id - y.id;
      };
    }
  }
}

const rankRisk = 1;

/**
 * 默认排序的分组，从上到下：切进 Antigravity 客户端在用的号 → 已授权（风控中、已改密）→ 授权过期、未授权
 * → 待改密 → 服务已停用还没申诉 → 申诉审核中。
 */
function rank(a: Account, h: Health, inUse: ReadonlySet<number>): number {
  if (inUse.has(a.id)) return 0;
  switch (h) {
    case "risk":
      return rankRisk;
    case "changed":
      return 2;
    case "revoked":
      return 3;
    case "unauth":
      return 4;
    case "pending":
      return 5;
    case "due":
      return 6;
    case "disabled":
      return a.appeal_at > 0 ? 8 : 7;
  }
}

/** 筛选按「要做什么」分：停用申诉、改密、授权异常。 */
export type Filter = "all" | "disabled" | "password" | "auth" | "risk" | "changed";

export function matchesFilter(a: Account, f: Filter): boolean {
  const h = healthOf(a);
  switch (f) {
    case "all":
      return true;
    case "disabled":
      return a.service_disabled;
    case "password":
      return accountNeedsPassword(a);
    case "auth":
      return accountNeedsAuth(a);
    case "risk":
      return h === "risk";
    case "changed":
      return h === "changed";
  }
}

/** 胶囊文案：一眼看懂原因。 */
export function healthLabel(a: Account): { text: string; hint: string } {
  switch (healthOf(a)) {
    case "disabled":
      return a.appeal_at > 0
        ? { text: "申诉审核中", hint: "已打开过官方申诉表单，可点「重新检测」确认是否恢复" }
        : { text: "服务已停用", hint: "Antigravity 对话服务被限制，需要提交官方申诉" };
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
