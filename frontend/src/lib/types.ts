// 后端接口的数据结构（与 Go 里的 JSON 字段一一对应）。

export type AccountStatus = "risk" | "due" | "changed";

export interface QuotaBucket {
  window: string; // "weekly" | "5h"
  display_name?: string;
  remaining_fraction: number;
  reset_time: string;
}

export interface QuotaGroup {
  display_name: string;
  buckets: QuotaBucket[];
}

export interface QuotaInfo {
  tier: string;
  groups: QuotaGroup[];
}

export interface Account {
  id: number;
  email: string;
  note: string;
  tags: string[];
  login_date: string;
  risk_days: number;
  pwd_changed_date: string;
  proxy: string;
  profile_dir: string;
  chrome_profile: string;
  created_at: number;
  quota_error: string;
  quota_at: number;
  login_days: number;
  risk_left: number;
  status: AccountStatus;
  profile_path: string;
  has_token: boolean;
  has_avatar: boolean;
  has_password: boolean;
  has_totp: boolean;
  has_pending_password: boolean;
  quota: QuotaInfo | null;
}

export type ClientTarget = "agy" | "ide" | "classic";

export interface ClientStatus {
  target: ClientTarget;
  label: string;
  installed: boolean;
  running: boolean;
  account_id: number;
  email: string;
  has_backup: boolean;
}

export interface Settings {
  chrome_path: string;
  chrome_user_data: string;
  default_proxy: string;
  default_risk_days: number;
  tag_colors?: Record<string, string>;
  ide_path: string;
  classic_path: string;
  next_pool: "any" | "gemini" | "claude";
  next_threshold: number;
}

export interface SettingsResponse {
  settings: Settings;
  data_dir: string;
  default_chrome_user_data: string;
}

export interface AppInfo {
  platform: string;
  os_user: string;
  capabilities: {
    switch_clients: boolean;
    chrome_password_sync: boolean;
    os_unlock: boolean;
    tray: boolean;
  };
}

export interface TotpResponse {
  codes: Record<string, string>;
  errors: Record<string, string>;
  period_end: number;
  period: number;
}

export interface ChromeProfile {
  dir: string;
  email: string;
  name: string;
  gaia_name: string;
  created: string;
  has_avatar: boolean;
  account_id: number;
}

export interface UIPrefs {
  lightweight: boolean;
  mini_pinned: boolean;
}

export interface SwitchResult {
  target: ClientTarget;
  email: string;
  warning?: string;
}

/** 账号表单提交体：只写字段为空表示不修改。 */
export interface AccountInput {
  email: string;
  note: string;
  tags?: string[];
  login_date: string;
  risk_days: number;
  pwd_changed_date: string;
  proxy: string;
  profile_dir: string;
  chrome_profile: string;
  refresh_token?: string;
  password?: string;
  totp_secret?: string;
  clear_password?: boolean;
  clear_totp?: boolean;
}
