import type { Account } from "./types";
import { calendarDaysUntil, currentMonthStr, effectiveTier, humanQuotaError, isPaidTier } from "./format";

/**
 * 系统替用户判断的「健康状态」，优先级从高到低：
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

const order: Record<Health, number> = { disabled: 0, pending: 1, due: 2, revoked: 3, risk: 4, unauth: 5, changed: 6 };

/**
 * 与 healthOf 完全正交的会员账期防反撸提醒（绝不篡改 Health 枚举，避免影响重新授权按钮与切号门禁）。
 */
export interface BillingAlert {
  kind: "overdue" | "imminent" | "expiring" | "downgraded";
  tone: "danger" | "warn";
  text: string;
  hint: string;
  urgent: boolean;
  daysLeft: number | null;
}

export function billingAlertOf(a: Account, now = Date.now()): BillingAlert | null {
  const p = a.perks;
  if (!p) return null;
  const days = calendarDaysUntil(p.renewal_date, now);
  if (p.billing_state === "auto_renew") {
    if (a.quota?.tier === "FREE" && !p.tier_override && (days === null || days < 0)) {
      return {
        kind: "downgraded",
        tone: "warn",
        text: "已降 Free · 查续费",
        hint: "OAuth 档位已变为 Free，请核实自动续费是否已取消",
        urgent: true,
        daysLeft: days,
      };
    }
    if (days !== null) {
      if (days < 0) {
        return {
          kind: "overdue",
          tone: "danger",
          text: "已过扣费日",
          hint: `原定 ${p.renewal_date} 自动扣费，请确认是否已退订或更新下一账期`,
          urgent: true,
          daysLeft: days,
        };
      }
      if (days === 0) {
        return {
          kind: "imminent",
          tone: "danger",
          text: "今天自动扣费",
          hint: `今天（${p.renewal_date}）自动续费，不用了请立即去关自动续费`,
          urgent: true,
          daysLeft: 0,
        };
      }
      if (days <= 5) {
        return {
          kind: "imminent",
          tone: days <= 2 ? "danger" : "warn",
          text: `${days} 天后扣费`,
          hint: `${p.renewal_date} 自动续费，不用了请提前关掉自动续费`,
          urgent: true,
          daysLeft: days,
        };
      }
    }
  } else if (p.billing_state === "cancelled" && days !== null && days >= 0 && days <= 5) {
    const extras: string[] = [];
    if (p.flow_credits && p.flow_credits > 0) extras.push(`Flow 剩 ${p.flow_credits.toLocaleString("en-US")}`);
    if (p.colab_cu && p.colab_cu > 0) extras.push(`Colab 剩 ${p.colab_cu} CU`);
    const extraHint = extras.length ? `（${extras.join(" · ")}，到期前优先用完）` : "";
    return {
      kind: "expiring",
      tone: "warn",
      text: days === 0 ? "今天到期" : `${days} 天后到期`,
      hint: `${p.renewal_date} 会员到期，已关自动续费${extraHint}`,
      urgent: false,
      daysLeft: days,
    };
  }
  return null;
}

export const hasUrgentBilling = (a: Account, now = Date.now()) => Boolean(billingAlertOf(a, now)?.urgent);
export const isPaidAccount = (a: Account) => isPaidTier(effectiveTier(a));

export type Scope = "all" | "paid" | "billing";
export type Sort = "smart" | "email" | "days" | "quota" | "renewal" | "flow" | "colab" | "api";

function minQuota(a: Account): number {
  let m = 2;
  for (const g of a.quota?.groups || []) for (const b of g.buckets || []) m = Math.min(m, b.remaining_fraction);
  return m;
}

function renewalRank(a: Account): number {
  const d = calendarDaysUntil(a.perks?.renewal_date);
  return d === null ? 999_999 : d;
}

function apiCreditScore(a: Account): number {
  const p = a.perks;
  if (p?.api_credit_balance !== undefined) return 1000 + p.api_credit_balance;
  if (p?.api_credit_claimed_month === currentMonthStr()) return 500;
  if (isPaidTier(effectiveTier(a))) return 100; // 待领排在无资格免费号前面
  return -1;
}

export function comparer(sort: Sort, desc = true): (x: Account, y: Account) => number {
  const base = ((): ((x: Account, y: Account) => number) => {
    switch (sort) {
      case "email":
        return (x, y) => x.email.localeCompare(y.email);
      case "days":
        return (x, y) => y.login_days - x.login_days;
      case "quota":
        return (x, y) => {
          const mx = minQuota(x);
          const my = minQuota(y);
          if (mx > 1 && my > 1) return 0;
          if (mx > 1) return 1;
          if (my > 1) return -1;
          return my - mx;
        };
      case "renewal":
        return (x, y) => renewalRank(x) - renewalRank(y);
      case "flow":
        return (x, y) => (y.perks?.flow_credits ?? -1) - (x.perks?.flow_credits ?? -1);
      case "colab":
        return (x, y) => (y.perks?.colab_cu ?? -1) - (x.perks?.colab_cu ?? -1);
      case "api":
        return (x, y) => apiCreditScore(y) - apiCreditScore(x);
      default:
        return compareAccounts;
    }
  })();
  if (desc || sort === "smart") {
    return (x, y) => base(x, y) || x.id - y.id;
  }
  return (x, y) => -base(x, y) || x.id - y.id;
}

function smartRank(a: Account, h: Health): number {
  if (h === "disabled" || h === "pending") return order[h];
  if (hasUrgentBilling(a)) return 1.5; // 紧随新密码待确认之后，优先防扣费反撸
  return order[h];
}

export function compareAccounts(x: Account, y: Account): number {
  const hx = healthOf(x);
  const hy = healthOf(y);
  const rx = smartRank(x, hx);
  const ry = smartRank(y, hy);
  if (rx !== ry) return rx - ry;
  if (rx === 1.5) return renewalRank(x) - renewalRank(y) || x.id - y.id;
  return (hx === "risk" ? x.risk_left - y.risk_left : 0) || x.id - y.id;
}

export function matchesScope(a: Account, scope: Scope): boolean {
  if (scope === "paid") return isPaidAccount(a);
  if (scope === "billing") return hasUrgentBilling(a);
  return true;
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
