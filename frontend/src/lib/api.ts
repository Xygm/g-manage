import type {
  Account, AccountInput, AppInfo, ChromeProfile, ClientStatus, ClientTarget,
  ServiceCheckResponse, Settings, SettingsResponse, SwitchResult, TotpResponse, UIPrefs,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "gam" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive });
  } catch {
    throw new ApiError("连不上程序内核，请确认程序还在运行", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.trim() };
    }
  }
  if (!res.ok) {
    const e = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "";
    const msg = e || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

// 仅开发预览：?demo 时假装能切号，并给出三个假客户端，方便看切号相关界面。
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
const demoClients: ClientStatus[] = [
  { target: "agy", label: "CLI", installed: true, running: true, account_id: 1, email: "", has_backup: false },
  { target: "ide", label: "IDE", installed: true, running: true, account_id: 2, email: "", has_backup: true },
  { target: "classic", label: "经典款", installed: false, running: false, account_id: 0, email: "", has_backup: false },
];

export const api = {
  app: async (): Promise<AppInfo> => {
    try {
      const info = await request<AppInfo>("GET", "/api/app");
      return DEMO ? { ...info, capabilities: { ...info.capabilities, switch_clients: true } } : info;
    } catch {
      // 旧内核没有这个接口：按 Windows 能力兜底。
      return { platform: "windows", os_user: "", capabilities: { switch_clients: true, chrome_password_sync: true, os_unlock: true, tray: true } };
    }
  },
  accounts: () => request<Account[]>("GET", "/api/accounts"),
  createAccount: (b: AccountInput) => request<Account>("POST", "/api/accounts", b),
  updateAccount: (id: number, b: AccountInput) => request<Account>("PUT", `/api/accounts/${id}`, b),
  deleteAccount: (id: number, keepalive = false) => request<void>("DELETE", `/api/accounts/${id}`, undefined, keepalive),
  setTags: (id: number, tags: string[]) => request<Account>("PUT", `/api/accounts/${id}/tags`, { tags }),
  open: (id: number, target: "browser" | "mail" | "password") => request<{ warning: string }>("POST", `/api/accounts/${id}/open?target=${target}`),
  openUrl: (id: number, url: string) => request<{ warning: string }>("POST", `/api/accounts/${id}/open?url=${enc(url)}`),
  authorize: (id: number) => request<{ warning: string }>("POST", `/api/accounts/${id}/authorize`),
  markChanged: (id: number) => request<Account>("POST", `/api/accounts/${id}/password-changed`),
  refreshQuota: (ids?: number[]) => request<Account[]>("POST", ids && ids.length ? `/api/quota/refresh?ids=${ids.join(",")}` : "/api/quota/refresh"),
  appeal: (id: number) => request<{ warning: string }>("POST", `/api/accounts/${id}/appeal`),
  serviceCheck: (id: number) => request<ServiceCheckResponse>("POST", `/api/accounts/${id}/service-check`),
  chromeProfiles: () => request<{ user_data: string; profiles: ChromeProfile[] }>("GET", "/api/chrome-profiles"),
  importProfiles: (dirs: string[]) => request<{ added: number; existed: number }>("POST", "/api/chrome-profiles/import", { dirs }),
  detachChrome: () => request<{ converted: number }>("POST", "/api/accounts/detach-chrome"),
  revealPassword: (id: number) => request<{ password: string; previous_password: string }>("POST", `/api/accounts/${id}/reveal-password`),
  pwStart: (id: number, regenerate = false) => request<{ current_password: string; new_password: string }>("POST", `/api/accounts/${id}/password-change/start`, { regenerate }),
  pwConfirm: (id: number) => request<Account>("POST", `/api/accounts/${id}/password-change/confirm`),
  pwCancel: (id: number) => request<void>("POST", `/api/accounts/${id}/password-change/cancel`),
  totp: () => request<TotpResponse>("GET", "/api/totp"),
  vault: () => request<{ unlocked_until: number; user: string }>("GET", "/api/vault"),
  unlock: (password: string) => request<{ unlocked_until: number }>("POST", "/api/vault/unlock", { password }),
  lock: () => request<void>("POST", "/api/vault/lock"),
  settings: () => request<SettingsResponse>("GET", "/api/settings"),
  saveSettings: (s: Settings) => request<Settings>("PUT", "/api/settings", s),
  tagColor: (tag: string, color: string) => request<{ tag_colors: Record<string, string> }>("PUT", "/api/tag-colors", { tag, color }),
  clients: () => (DEMO ? Promise.resolve(demoClients) : request<ClientStatus[]>("GET", "/api/clients")),
  switchTo: (id: number, target: ClientTarget) => request<SwitchResult>("POST", `/api/accounts/${id}/switch?target=${target}`),
  switchNext: (target: ClientTarget) => request<SwitchResult>("POST", `/api/clients/${target}/next`),
  restoreFingerprint: (target: ClientTarget) => request<{ warning: string }>("POST", `/api/clients/${target}/restore-fingerprint`),
  uiPrefs: () => request<UIPrefs>("GET", "/api/ui-prefs"),
  saveUiPrefs: (p: UIPrefs) => request<UIPrefs>("PUT", "/api/ui-prefs", p),
  openFullDiskAccess: () => request<void>("POST", "/api/system/full-disk-access"),
  revealApp: () => request<void>("POST", "/api/system/reveal-app"),
};
