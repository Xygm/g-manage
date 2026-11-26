import { api, ApiError } from "./api";
import { copyText } from "./bridge";
import { comparer, matchesFilter, type Filter, type Sort } from "./health";
import { matchesQuery } from "./format";
import { createStore } from "./store";
import { errText, toast } from "./toast";
import type { Account, AccountInput, AppInfo, ClientStatus, ClientTarget, Settings } from "./types";

export type UnlockThen = "reveal" | "copy" | "pwchange" | "pwresume";

export interface AppState {
  accounts: Account[];
  loaded: boolean;
  loadError: string;
  clients: ClientStatus[];
  settings: Settings | null;
  dataDir: string;
  defaultUserData: string;
  app: AppInfo | null;
  vaultUntil: number;
  osUser: string;
  revealed: Record<number, { password: string; previous: string }>;
  totp: { codes: Record<string, string>; errors: Record<string, string>; periodEnd: number; period: number };
  filter: Filter;
  sort: Sort;
  tag: string;
  query: string;
  selectedId: number;
  hidden: number[]; // 已删除、还在「可撤销」窗口里的账号
  refreshingAll: boolean;
  refreshingIds: number[];
  awaitingAuth: number[];
  switching: ClientTarget | null;
  flash: { id: number; at: number } | null; // 刚完成一件事的账号：浅绿闪一下
  unlockFor: { id: number; then: UnlockThen } | null;
  pwchange: { id: number; current: string; next: string } | null;
  sheet: null | { kind: "add" } | { kind: "edit"; id: number } | { kind: "settings" } | { kind: "import" };
  palette: boolean;
  bannerDismissed: boolean;
}

function readFlag(k: string) {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
}

export const app = createStore<AppState>({
  accounts: [],
  loaded: false,
  loadError: "",
  clients: [],
  settings: null,
  dataDir: "",
  defaultUserData: "",
  app: null,
  vaultUntil: 0,
  osUser: "",
  revealed: {},
  totp: { codes: {}, errors: {}, periodEnd: 0, period: 30 },
  filter: "all",
  sort: "smart",
  tag: "",
  query: "",
  selectedId: 0,
  hidden: [],
  refreshingAll: false,
  refreshingIds: [],
  awaitingAuth: [],
  switching: null,
  flash: null,
  unlockFor: null,
  pwchange: null,
  sheet: null,
  palette: false,
  bannerDismissed: readFlag("gam-banner-dismissed"),
});

export function dismissBanner() {
  try {
    localStorage.setItem("gam-banner-dismissed", "1");
  } catch {
    /* 忽略 */
  }
  app.set({ bannerDismissed: true });
}

function flashDone(id: number) {
  app.set({ flash: { id, at: Date.now() } });
}

const now = () => Date.now() / 1000;

/* ───────── 派生 ───────── */

let visCache: { accs: Account[]; hid: number[]; out: Account[] } | null = null;
export function visibleAccounts(s: AppState): Account[] {
  if (visCache && visCache.accs === s.accounts && visCache.hid === s.hidden) return visCache.out;
  const hidden = new Set(s.hidden);
  const out = hidden.size ? s.accounts.filter((a) => !hidden.has(a.id)) : s.accounts;
  visCache = { accs: s.accounts, hid: s.hidden, out };
  return out;
}

let filtCache: { vis: Account[]; filter: Filter; tag: string; sort: Sort; query: string; out: Account[] } | null = null;
export function filteredAccounts(s: AppState): Account[] {
  const vis = visibleAccounts(s);
  if (
    filtCache &&
    filtCache.vis === vis &&
    filtCache.filter === s.filter &&
    filtCache.tag === s.tag &&
    filtCache.sort === s.sort &&
    filtCache.query === s.query
  ) {
    return filtCache.out;
  }
  const out = vis
    .filter((a) => matchesFilter(a, s.filter) && (!s.tag || a.tags.includes(s.tag)) && matchesQuery(a, s.query))
    .sort(comparer(s.sort));
  filtCache = { vis, filter: s.filter, tag: s.tag, sort: s.sort, query: s.query, out };
  return out;
}

export function accountById(id: number): Account | undefined {
  return app.get().accounts.find((a) => a.id === id);
}

export const canSwitch = () => !!app.get().app?.capabilities.switch_clients;

/* ───────── 加载 ───────── */

export async function loadAll() {
  try {
    const [info, st, accounts, vault] = await Promise.all([api.app(), api.settings(), api.accounts(), api.vault()]);
    app.set({
      app: info,
      settings: st.settings,
      dataDir: st.data_dir,
      defaultUserData: st.default_chrome_user_data,
      accounts,
      loaded: true,
      loadError: "",
      vaultUntil: vault.unlocked_until,
      osUser: vault.user || info.os_user,
    });
    scheduleVault();
    if (info.capabilities.switch_clients) loadClients();
    loadTotp();
  } catch (e) {
    app.set({ loaded: true, loadError: errText(e) });
  }
}

export async function reloadAccounts() {
  try {
    const [accounts] = await Promise.all([api.accounts(), canSwitch() ? loadClients() : Promise.resolve()]);
    app.set({ accounts, loadError: "" });
    loadTotp();
  } catch (e) {
    toast.err(errText(e));
  }
}

export async function loadClients() {
  try {
    app.set({ clients: await api.clients() });
  } catch {
    app.set({ clients: [] });
  }
}

function replaceAccount(a: Account) {
  app.set((s) => ({ accounts: s.accounts.map((x) => (x.id === a.id ? a : x)) }));
}

/* ───────── 2FA ───────── */

let totpTimer: ReturnType<typeof setTimeout> | undefined;
export async function loadTotp() {
  clearTimeout(totpTimer);
  if (!app.get().accounts.some((a) => a.has_totp)) return;
  try {
    const r = await api.totp();
    app.set({ totp: { codes: r.codes, errors: r.errors, periodEnd: r.period_end, period: r.period } });
    totpTimer = setTimeout(loadTotp, Math.max(500, (r.period_end - now()) * 1000 + 250));
  } catch {
    totpTimer = setTimeout(loadTotp, 5000);
  }
}

/* ───────── 解锁 ───────── */

let vaultTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleVault() {
  clearTimeout(vaultTimer);
  const left = app.get().vaultUntil - now();
  if (left > 0) vaultTimer = setTimeout(() => setVault(0), left * 1000);
}

function setVault(until: number) {
  app.set(until > now() ? { vaultUntil: until } : { vaultUntil: 0, revealed: {} });
  scheduleVault();
}

export const isUnlocked = () => app.get().vaultUntil > now();

export async function unlock(password: string): Promise<void> {
  const r = await api.unlock(password);
  setVault(r.unlocked_until);
  const req = app.get().unlockFor;
  app.set({ unlockFor: null });
  if (req) {
    const a = accountById(req.id);
    if (a) runAfterUnlock(a, req.then);
  }
}

export function lockVault() {
  api.lock().catch(() => {});
  setVault(0);
  toast.info("已锁上，再看密码要重新验证");
}

function runAfterUnlock(a: Account, then: UnlockThen) {
  if (then === "reveal") reveal(a);
  else if (then === "copy") copyPassword(a);
  else if (then === "pwresume") startPasswordChange(a, false);
  else startPasswordChange(a, true);
}

/** 需要解锁时，把解锁请求交给该账号的凭据卡（在原地输入，不弹框）。 */
function needUnlock(a: Account, then: UnlockThen) {
  app.set({ selectedId: a.id, unlockFor: { id: a.id, then } });
}

async function withVault<T>(a: Account, then: UnlockThen, fn: () => Promise<T>): Promise<T | undefined> {
  if (!isUnlocked()) {
    needUnlock(a, then);
    return undefined;
  }
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setVault(0);
      needUnlock(a, then);
      return undefined;
    }
    throw e;
  }
}

export async function reveal(a: Account) {
  if (app.get().revealed[a.id]) {
    app.set((s) => {
      const r = { ...s.revealed };
      delete r[a.id];
      return { revealed: r };
    });
    return;
  }
  try {
    await withVault(a, "reveal", async () => {
      const r = await api.revealPassword(a.id);
      app.set((s) => ({ revealed: { ...s.revealed, [a.id]: { password: r.password, previous: r.previous_password } } }));
    });
  } catch (e) {
    toast.err(errText(e));
  }
}

export async function copyPassword(a: Account): Promise<boolean> {
  try {
    const done = await withVault(a, "copy", async () => {
      const pw = app.get().revealed[a.id]?.password ?? (await api.revealPassword(a.id)).password;
      await copyText(pw);
      toast.ok("密码已复制");
      return true;
    });
    return !!done;
  } catch (e) {
    toast.err(errText(e));
    return false;
  }
}

export async function copyTotp(a: Account): Promise<boolean> {
  const code = app.get().totp.codes[String(a.id)];
  if (!code) return false;
  try {
    await copyText(code);
    toast.ok(`验证码 ${code.slice(0, 3)} ${code.slice(3)} 已复制`);
    return true;
  } catch (e) {
    toast.err(`复制失败：${errText(e)}`);
    return false;
  }
}

export async function copyPlain(text: string, msg: string): Promise<boolean> {
  try {
    await copyText(text);
    toast.ok(msg);
    return true;
  } catch (e) {
    toast.err(`复制失败：${errText(e)}`);
    return false;
  }
}

/* ───────── 浏览器 / 授权 ───────── */

function launched(r: { warning?: string }, msg: string) {
  if (r.warning) toast.err(`${msg}，但${r.warning}`);
  else toast.ok(msg);
}

export async function openTarget(a: Account, target: "browser" | "mail" | "password") {
  try {
    const r = await api.open(a.id, target);
    launched(r, target === "mail" ? "已打开 Gmail" : target === "password" ? "已打开改密页" : "已打开这个号的浏览器");
  } catch (e) {
    toast.err(errText(e));
  }
}

export async function openUrl(a: Account, url: string) {
  try {
    launched(await api.openUrl(a.id, url), "已在这个号的浏览器里打开验证页");
  } catch (e) {
    toast.err(errText(e));
  }
}

const authPolls = new Map<number, ReturnType<typeof setInterval>>();

export function cancelAwaitAuth(id: number) {
  clearInterval(authPolls.get(id));
  authPolls.delete(id);
  app.set((s) => ({ awaitingAuth: s.awaitingAuth.filter((x) => x !== id) }));
}

/** 授权在该号浏览器里完成；这边每 3 秒看一眼，拿到新授权就收尾（最多等 5 分钟）。 */
export async function authorize(a: Account) {
  try {
    launched(await api.authorize(a.id), "授权页已在这个号的浏览器里打开");
  } catch (e) {
    toast.err(errText(e));
    return;
  }
  cancelAwaitAuth(a.id);
  const before = { has: a.has_token, at: a.quota_at };
  const started = Date.now();
  app.set((s) => ({ awaitingAuth: [...s.awaitingAuth, a.id] }));
  authPolls.set(
    a.id,
    setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) {
        cancelAwaitAuth(a.id);
        return;
      }
      try {
        const accounts = await api.accounts();
        const cur = accounts.find((x) => x.id === a.id);
        app.set({ accounts });
        if (cur && cur.has_token && (!before.has || cur.quota_at > before.at)) {
          cancelAwaitAuth(a.id);
          flashDone(a.id);
          toast.ok(`${cur.email} 授权好了`);
        }
      } catch {
        /* 下次再看 */
      }
    }, 3000),
  );
}

/* ───────── 额度 ───────── */

export async function refreshAll() {
  if (app.get().refreshingAll) return;
  app.set({ refreshingAll: true });
  try {
    const accounts = await api.refreshQuota();
    app.set({ accounts });
    const failed = accounts.filter((a) => a.has_token && a.quota_error).length;
    const total = accounts.filter((a) => a.has_token).length;
    if (!total) toast.info("还没有授权过的号，先授权才能看额度");
    else if (failed) toast.err(`额度已刷新，${failed} 个号没查到，原因写在各自的额度卡里`);
    else toast.ok(`${total} 个号的额度已刷新`);
  } catch (e) {
    toast.err(errText(e));
  } finally {
    app.set({ refreshingAll: false });
  }
}

const autoTried = new Set<number>();
export async function refreshOne(id: number, silent = false) {
  if (app.get().refreshingIds.includes(id)) return;
  if (silent) {
    if (autoTried.has(id)) return;
    autoTried.add(id);
  }
  app.set((s) => ({ refreshingIds: [...s.refreshingIds, id] }));
  try {
    const accounts = await api.refreshQuota([id]);
    app.set({ accounts });
    const a = accounts.find((x) => x.id === id);
    if (!silent) {
      if (a?.quota_error) toast.err("额度没查到，原因写在额度卡里");
      else toast.ok("额度已更新");
    }
  } catch (e) {
    if (!silent) toast.err(errText(e));
  } finally {
    app.set((s) => ({ refreshingIds: s.refreshingIds.filter((x) => x !== id) }));
  }
}

/* ───────── 标签 ───────── */

export async function setTags(a: Account, tags: string[]) {
  const prev = a.tags;
  replaceAccount({ ...a, tags }); // 先在界面上生效，失败再退回
  try {
    replaceAccount(await api.setTags(a.id, tags));
  } catch (e) {
    const cur = accountById(a.id);
    if (cur) replaceAccount({ ...cur, tags: prev });
    toast.err(errText(e));
  }
}

export async function setTagColor(tag: string, color: string) {
  try {
    const r = await api.tagColor(tag, color);
    app.set((s) => ({ settings: s.settings ? { ...s.settings, tag_colors: r.tag_colors } : s.settings }));
  } catch (e) {
    toast.err(errText(e));
  }
}

/* ───────── 删除（可撤销） ───────── */

const pendingDeletes = new Map<number, ReturnType<typeof setTimeout>>();

function commitDelete(id: number, keepalive = false) {
  clearTimeout(pendingDeletes.get(id));
  pendingDeletes.delete(id);
  return api
    .deleteAccount(id, keepalive)
    .then(() => app.set((s) => ({ accounts: s.accounts.filter((a) => a.id !== id), hidden: s.hidden.filter((x) => x !== id) })))
    .catch((e) => {
      app.set((s) => ({ hidden: s.hidden.filter((x) => x !== id) }));
      toast.err(`没删掉：${errText(e)}`);
    });
}

export function deleteWithUndo(a: Account) {
  const s = app.get();
  const list = filteredAccounts(s);
  const idx = list.findIndex((x) => x.id === a.id);
  const nextSel = s.selectedId === a.id ? (list[idx + 1] ?? list[idx - 1])?.id ?? 0 : s.selectedId;
  app.set((st) => ({ hidden: [...st.hidden, a.id], selectedId: nextSel }));
  pendingDeletes.set(a.id, setTimeout(() => commitDelete(a.id), 8500));
  toast.info(`已移出 ${a.email}`, {
    duration: 8000,
    action: {
      label: "撤销",
      run: () => {
        clearTimeout(pendingDeletes.get(a.id));
        pendingDeletes.delete(a.id);
        app.set((st) => ({ hidden: st.hidden.filter((x) => x !== a.id), selectedId: a.id }));
      },
    },
  });
}

// 关窗前把还在撤销窗口里的删除真正提交。
window.addEventListener("pagehide", () => {
  for (const id of [...pendingDeletes.keys()]) commitDelete(id, true);
});

/* ───────── 改密 ───────── */

export function inputOf(a: Account): AccountInput {
  return {
    email: a.email, note: a.note, login_date: a.login_date, risk_days: a.risk_days,
    pwd_changed_date: a.pwd_changed_date, proxy: a.proxy, profile_dir: a.profile_dir, chrome_profile: a.chrome_profile,
  };
}

export async function markChanged(a: Account) {
  try {
    const updated = await api.markChanged(a.id);
    replaceAccount(updated);
    flashDone(a.id);
    toast.ok("已记为今天改密", {
      action: {
        label: "撤销",
        run: async () => {
          try {
            replaceAccount(await api.updateAccount(a.id, inputOf(a)));
          } catch (e) {
            toast.err(errText(e));
          }
        },
      },
    });
  } catch (e) {
    toast.err(errText(e));
  }
}

export async function startPasswordChange(a: Account, openBrowser = true) {
  try {
    await withVault(a, openBrowser ? "pwchange" : "pwresume", async () => {
      const r = await api.pwStart(a.id);
      app.set({ pwchange: { id: a.id, current: r.current_password, next: r.new_password } });
      if (!a.has_pending_password) replaceAccount({ ...a, has_pending_password: true });
      if (openBrowser) {
        api.open(a.id, "password").catch((e) => toast.err(errText(e)));
      }
    });
  } catch (e) {
    toast.err(errText(e));
  }
}

export async function regeneratePassword(id: number) {
  const a = accountById(id);
  if (!a) return;
  try {
    await withVault(a, "pwchange", async () => {
      const r = await api.pwStart(id, true);
      app.set({ pwchange: { id, current: r.current_password, next: r.new_password } });
      toast.ok("换了一个新密码");
    });
  } catch (e) {
    toast.err(errText(e));
  }
}

export async function confirmPasswordChange(id: number) {
  const updated = await api.pwConfirm(id);
  replaceAccount(updated);
  flashDone(id);
  app.set((s) => {
    const r = { ...s.revealed };
    delete r[id];
    return { pwchange: null, revealed: r };
  });
  toast.ok("新密码生效了，改密日期记为今天");
}

export async function cancelPasswordChange(id: number) {
  await api.pwCancel(id);
  const a = accountById(id);
  if (a) replaceAccount({ ...a, has_pending_password: false });
  app.set({ pwchange: null });
  toast.info("已放弃新密码，原密码不变");
}

/* ───────── 账号 / 设置 / 导入 ───────── */

export async function saveAccount(input: AccountInput, id?: number): Promise<Account> {
  const saved = id ? await api.updateAccount(id, input) : await api.createAccount(input);
  if (id) {
    replaceAccount(saved);
    app.set((s) => {
      const r = { ...s.revealed };
      delete r[id];
      return { revealed: r };
    });
  } else {
    app.set((s) => ({ accounts: [...s.accounts, saved], selectedId: saved.id, filter: "all", tag: "", query: "" }));
  }
  loadTotp();
  return saved;
}

export async function saveSettings(st: Settings) {
  const saved = await api.saveSettings(st);
  app.set({ settings: saved });
}

export async function switchClient(a: Account, target: ClientTarget) {
  if (app.get().switching) return;
  app.set({ switching: target });
  try {
    const r = await api.switchTo(a.id, target);
    await loadClients();
    const name = CLIENTS[target].short;
    flashDone(a.id);
    if (r.warning) toast.err(`${name} 已切到 ${r.email}，但${r.warning}`);
    else toast.ok(`${name} 已切到 ${r.email}`);
  } catch (e) {
    toast.err(errText(e));
  } finally {
    app.set({ switching: null });
  }
}

export async function switchNext(target: ClientTarget) {
  if (app.get().switching) return;
  app.set({ switching: target });
  try {
    const r = await api.switchNext(target);
    await Promise.all([loadClients(), reloadAccountsQuiet()]);
    const id = app.get().clients.find((c) => c.target === target)?.account_id;
    if (id) flashDone(id);
    const name = CLIENTS[target].short;
    if (r.warning) toast.err(`${name} 已切到 ${r.email}，但${r.warning}`);
    else toast.ok(`${name} 已切到 ${r.email}`);
  } catch (e) {
    const msg = errText(e);
    toast.err(msg.includes("没有可切换") ? "没有合适的备用号：要已授权、过了风控期、额度够" : msg);
  } finally {
    app.set({ switching: null });
  }
}

async function reloadAccountsQuiet() {
  try {
    app.set({ accounts: await api.accounts() });
  } catch {
    /* 忽略 */
  }
}

/** 某个号此刻被哪些客户端登录着。 */
export function clientsOf(s: AppState, id: number): ClientStatus[] {
  return s.clients.filter((c) => c.account_id === id);
}

export const CLIENTS: Record<ClientTarget, { short: string; name: string }> = {
  agy: { short: "CLI", name: "Antigravity CLI" },
  ide: { short: "IDE", name: "Antigravity IDE" },
  classic: { short: "经典款", name: "Antigravity 经典款" },
};
export const clientName = (t: ClientTarget) => CLIENTS[t].name;

/* ───────── 选择与筛选 ───────── */

export function select(id: number) {
  if (app.get().selectedId !== id) app.set({ selectedId: id, unlockFor: null });
}

export function setFilter(filter: Filter) {
  app.set({ filter });
}

export function moveSelection(delta: number) {
  const s = app.get();
  const list = filteredAccounts(s);
  if (!list.length) return;
  const i = list.findIndex((a) => a.id === s.selectedId);
  const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta));
  const id = list[next].id;
  select(id);
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus({ preventScroll: true });
  });
}

/** 判断账号是否满足「切下个」的候选条件（与后端 nextScore 口径一致）。 */
export function isNextCandidate(a: Account, settings: Settings | null, currentId: number): boolean {
  if (!a.has_token || a.id === currentId || a.status === "risk") return false;
  if (!a.quota || !a.quota.groups?.length) return false;
  const pool = settings?.next_pool || "any";
  const need = (settings?.next_threshold ?? 10) / 100;
  let checked = 0;
  for (const g of a.quota.groups) {
    const isClaude = /claude|gpt/i.test(g.display_name);
    if (pool === "gemini" && isClaude) continue;
    if (pool === "claude" && !isClaude) continue;
    for (const b of g.buckets || []) {
      checked++;
      if (b.remaining_fraction < need) return false;
    }
  }
  return checked > 0;
}
