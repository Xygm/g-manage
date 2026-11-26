import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Copy, Fingerprint } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { app, canSwitch, CLIENTS, copyPlain, reloadAccounts, saveAccount, saveSettings } from "../lib/app";
import { modLabel } from "../lib/bridge";
import { todayStr } from "../lib/format";
import { useStore } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { setThemePref, useThemePref, type ThemePref } from "../lib/theme";
import { errText, toast } from "../lib/toast";
import type { AccountInput, ChromeProfile, ClientStatus, Settings } from "../lib/types";
import { Button, Spinner, cx } from "../ui/button";
import { Avatar } from "../ui/display";
import { Collapse, Field, Segmented, TextInput } from "../ui/form";
import { ConfirmPop, Sheet } from "../ui/overlay";

/** 把后端报错对到具体的输入框上。 */
function fieldOf(msg: string, names: string[]): string {
  const rules: [RegExp, string][] = [
    [/邮箱/, "email"], [/首次登录|登录日期/, "login_date"], [/改密日期/, "pwd_changed_date"], [/默认风控期/, "default_risk_days"], [/风控期/, "risk_days"],
    [/额度门槛|额度池/, "next_threshold"], [/Chrome 路径/i, "chrome_path"], [/个人资料文件夹/, "chrome_profile"], [/用户数据目录/, "profile_dir"],
    [/代理/, names.includes("default_proxy") ? "default_proxy" : "proxy"], [/2FA|密钥/i, "totp_secret"], [/Token/i, "refresh_token"], [/标签/, "tags"],
  ];
  return rules.find(([re, n]) => re.test(msg) && names.includes(n))?.[1] ?? "";
}

/** 智能识别整行账号文本（如 邮箱----密码----2FA 或 Excel 制表符分隔），替用户分拣字段。 */
function parseSmartLine(raw: string): Partial<Pick<AccountInput, "email" | "password" | "totp_secret" | "note">> | null {
  const s = raw.trim();
  if (!s || (!s.includes("----") && !s.includes("——") && !s.includes("\t") && !s.includes("|") && !s.startsWith("otpauth://"))) {
    return null;
  }
  if (s.startsWith("otpauth://")) {
    try {
      const m = decodeURIComponent(s).match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      return { email: m ? m[1].toLowerCase() : undefined, totp_secret: s };
    } catch {
      return { totp_secret: s };
    }
  }
  const parts = s.split(/\s*(?:----+|--+|——+|\t|\|)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const emailIdx = parts.findIndex((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p));
  if (emailIdx < 0) return null;
  const email = parts[emailIdx].toLowerCase();
  const rest = parts.filter((_, idx) => idx !== emailIdx);
  let password = "";
  let totp = "";
  const notes: string[] = [];
  for (const item of rest) {
    const compact = item.replace(/\s+/g, "");
    if (!totp && (item.startsWith("otpauth://") || (/^[A-Z2-7]+=*$/i.test(compact) && compact.length >= 16 && compact.length <= 64))) {
      totp = item;
    } else if (!password) {
      password = item;
    } else {
      notes.push(item);
    }
  }
  return { email, password: password || undefined, totp_secret: totp || undefined, note: notes.length ? notes.join(" · ") : undefined };
}

/* ───────── 添加 / 编辑账号 ───────── */

export function AccountSheet() {
  const sheet = useStore(app, (s) => s.sheet);
  const open = sheet?.kind === "add" || sheet?.kind === "edit";
  const editId = sheet?.kind === "edit" ? sheet.id : 0;
  const editing = useStore(app, (s) => (editId ? s.accounts.find((a) => a.id === editId) : undefined));
  const defaultRisk = useStore(app, (s) => s.settings?.default_risk_days ?? 7);
  const [f, setF] = useState<AccountInput>(blank(7));
  const [riskStr, setRiskStr] = useState("7");
  const [initialJson, setInitialJson] = useState("");
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<{ field: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    if (editing) {
      const init: AccountInput = {
        email: editing.email, note: editing.note, login_date: editing.login_date, risk_days: editing.risk_days, pwd_changed_date: editing.pwd_changed_date,
        proxy: editing.proxy, profile_dir: editing.profile_dir, chrome_profile: editing.chrome_profile, password: "", totp_secret: "", refresh_token: "",
        clear_password: false, clear_totp: false,
      };
      setF(init);
      setRiskStr(String(editing.risk_days));
      setInitialJson(JSON.stringify({ ...init, riskStr: String(editing.risk_days) }));
      setMore(!!(editing.proxy || editing.profile_dir || editing.chrome_profile));
    } else {
      const init = blank(defaultRisk);
      setF(init);
      setRiskStr(String(defaultRisk));
      setInitialJson(JSON.stringify({ ...init, riskStr: String(defaultRisk) }));
      setMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  const dirty = open && initialJson !== "" && JSON.stringify({ ...f, riskStr }) !== initialJson;

  const set = <K extends keyof AccountInput>(k: K, v: AccountInput[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    if (err?.field === k) setErr(null);
  };
  const close = () => app.set({ sheet: null });

  const submit = async () => {
    const parsedRisk = riskStr.trim() === "" ? NaN : Number(riskStr);
    if (!Number.isInteger(parsedRisk) || parsedRisk < 0) {
      setMore(true);
      setErr({ field: "risk_days", msg: "风控期天数请填 0 或正整数" });
      return;
    }
    if (f.pwd_changed_date && f.login_date && f.pwd_changed_date < f.login_date) {
      setMore(true);
      setErr({ field: "pwd_changed_date", msg: "改密日期不能早于首次登录日期" });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload: AccountInput = { ...f, risk_days: parsedRisk };
      const saved = await saveAccount(payload, editId || undefined);
      close();
      toast.ok(editId ? "已保存" : `已添加 ${saved.email}`);
    } catch (e) {
      const msg = errText(e);
      const field = fieldOf(msg, ["email", "login_date", "pwd_changed_date", "risk_days", "proxy", "profile_dir", "chrome_profile", "totp_secret", "refresh_token"]);
      if (["login_date", "pwd_changed_date", "risk_days", "proxy", "profile_dir", "chrome_profile", "refresh_token"].includes(field)) setMore(true);
      setErr({ field, msg });
    } finally {
      setBusy(false);
    }
  };
  const e = (k: string) => (err && err.field === k ? err.msg : undefined);

  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title={editId ? "编辑账号" : "添加账号"}
      subtitle={editing?.email}
      footer={
        <>
          <AnimatePresence>
            {err && !err.field && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0 }} role="alert" className="min-w-0 flex-1 truncate text-xs text-danger">
                {err.msg}
              </motion.p>
            )}
          </AnimatePresence>
          <div className="flex-1" />
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" busy={busy} onClick={submit} kbd={modLabel("↵")}>
            {editId ? "保存" : "添加"}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            submit();
          }
        }}
        className="flex flex-col gap-3.5"
      >
        <Field label="邮箱" error={e("email")} hint={!editId ? "支持直接粘贴「邮箱----密码----2FA」整行自动分拣" : undefined}>
          {(id) => (
            <TextInput
              id={id}
              type="email"
              value={f.email}
              onChange={(x) => set("email", x.target.value)}
              onPaste={(ev) => {
                if (editId) return;
                const text = ev.clipboardData.getData("text");
                const parsed = parseSmartLine(text);
                if (!parsed) return;
                ev.preventDefault();
                setF((prev) => ({
                  ...prev,
                  email: parsed.email ?? prev.email,
                  password: parsed.password ?? prev.password,
                  totp_secret: parsed.totp_secret ?? prev.totp_secret,
                  note: parsed.note ?? prev.note,
                }));
                setErr(null);
                const filled = [parsed.email && "邮箱", parsed.password && "密码", parsed.totp_secret && "2FA", parsed.note && "备注"].filter(Boolean);
                if (filled.length > 1) toast.ok(`已自动填入${filled.join("、")}`);
              }}
              placeholder="name@gmail.com"
              data-autofocus={!editId || undefined}
              aria-invalid={!!e("email")}
            />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <Field label="密码" hint={editing?.has_password ? (f.clear_password ? "保存后会清除已存的密码" : "已存，留空就不改") : "可选"}>
            {(id) => (
              <div className="relative">
                <TextInput
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={f.password}
                  disabled={f.clear_password}
                  onChange={(x) => set("password", x.target.value)}
                  placeholder={editing?.has_password ? "••••••••" : ""}
                  className={editing?.has_password ? "pr-16" : ""}
                />
                {editing?.has_password && (
                  <ClearToggle
                    on={!!f.clear_password}
                    onChange={(v) => {
                      setF((prev) => ({ ...prev, clear_password: v, password: v ? "" : prev.password }));
                    }}
                  />
                )}
              </div>
            )}
          </Field>
          <Field label="2FA 密钥" error={e("totp_secret")} hint={editing?.has_totp ? (f.clear_totp ? "保存后会清除已存的密钥" : "已存，留空就不改") : "验证器密钥或 otpauth:// 链接"}>
            {(id) => (
              <div className="relative">
                <TextInput
                  id={id}
                  mono
                  value={f.totp_secret}
                  disabled={f.clear_totp}
                  onChange={(x) => {
                    const v = x.target.value;
                    set("totp_secret", v);
                    if (!f.email && v.startsWith("otpauth://")) {
                      const p = parseSmartLine(v);
                      if (p?.email) set("email", p.email);
                    }
                  }}
                  placeholder={editing?.has_totp ? "已存" : "JBSW Y3DP EHPK 3PXP"}
                  aria-invalid={!!e("totp_secret")}
                  className={editing?.has_totp ? "pr-16" : ""}
                />
                {editing?.has_totp && (
                  <ClearToggle
                    on={!!f.clear_totp}
                    onChange={(v) => {
                      setF((prev) => ({ ...prev, clear_totp: v, totp_secret: v ? "" : prev.totp_secret }));
                    }}
                  />
                )}
              </div>
            )}
          </Field>
        </div>
        <Field label="备注">{(id) => <TextInput id={id} value={f.note} onChange={(x) => set("note", x.target.value)} placeholder="用途、来源、状态…" />}</Field>

        <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="-mx-1 flex items-center gap-1.5 self-start rounded-[6px] px-1 py-0.5 text-sm font-medium text-ink-2 hover:text-ink">
          <motion.span animate={{ rotate: more ? 0 : -90 }} transition={spring.snap} className="inline-grid">
            <ChevronDown size={14} strokeWidth={2} />
          </motion.span>
          日期、代理和浏览器
          {!more && <span className="font-normal text-ink-3">· 首次登录 {f.login_date}，风控期 {riskStr || 0} 天</span>}
        </button>
        <Collapse open={more}>
          <div className="flex flex-col gap-3.5 pb-1 pt-0.5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="首次登录" error={e("login_date")}>
                {(id) => <TextInput id={id} type="date" max={todayStr()} value={f.login_date} onChange={(x) => set("login_date", x.target.value)} aria-invalid={!!e("login_date")} />}
              </Field>
              <Field label="风控期（天）" error={e("risk_days")}>
                {(id) => (
                  <TextInput
                    id={id}
                    inputMode="numeric"
                    value={riskStr}
                    onChange={(x) => {
                      setRiskStr(x.target.value.replace(/[^\d]/g, ""));
                      if (err?.field === "risk_days") setErr(null);
                    }}
                    aria-invalid={!!e("risk_days")}
                  />
                )}
              </Field>
              <Field label="改密日期" error={e("pwd_changed_date")} hint="没改过就空着">
                {(id) => <TextInput id={id} type="date" min={f.login_date || undefined} max={todayStr()} value={f.pwd_changed_date} onChange={(x) => set("pwd_changed_date", x.target.value)} aria-invalid={!!e("pwd_changed_date")} />}
              </Field>
            </div>
            <Field label="代理" error={e("proxy")} hint="空着就用设置里的默认代理。看额度和开浏览器都走它">
              {(id) => <TextInput id={id} mono value={f.proxy} onChange={(x) => set("proxy", x.target.value)} placeholder="socks5://127.0.0.1:1080" aria-invalid={!!e("proxy")} />}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]">
              <Field label="Chrome 用户数据目录" error={e("profile_dir")} hint={editing && !f.profile_dir ? `空着 = ${editing.profile_path}` : "空着 = 程序自带的独立资料"}>
                {(id) => <TextInput id={id} mono value={f.profile_dir} onChange={(x) => set("profile_dir", x.target.value)} aria-invalid={!!e("profile_dir")} />}
              </Field>
              <Field label="个人资料文件夹" error={e("chrome_profile")}>
                {(id) => <TextInput id={id} value={f.chrome_profile} onChange={(x) => set("chrome_profile", x.target.value)} placeholder="Profile 11" aria-invalid={!!e("chrome_profile")} />}
              </Field>
            </div>
            <Field label="Refresh Token" error={e("refresh_token")} hint="从别的工具迁过来时粘贴；平时用「授权」就行">
              {(id) => <TextInput id={id} type="password" value={f.refresh_token} onChange={(x) => set("refresh_token", x.target.value)} placeholder={editing ? "留空就不改" : ""} aria-invalid={!!e("refresh_token")} />}
            </Field>
          </div>
        </Collapse>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function ClearToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className={cx("absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[6px] px-1.5 py-0.5 text-xs font-medium transition-colors duration-[120ms]", on ? "bg-danger-soft text-danger" : "text-ink-3 hover:bg-fill hover:text-ink-2")}>
      {on ? "撤销" : "清除"}
    </button>
  );
}

function blank(risk: number): AccountInput {
  return { email: "", note: "", login_date: todayStr(), risk_days: risk, pwd_changed_date: "", proxy: "", profile_dir: "", chrome_profile: "", password: "", totp_secret: "", refresh_token: "" };
}

/* ───────── 设置 ───────── */

export function SettingsSheet() {
  const open = useStore(app, (s) => s.sheet?.kind === "settings");
  const settings = useStore(app, (s) => s.settings);
  const dataDir = useStore(app, (s) => s.dataDir);
  const defaultUserData = useStore(app, (s) => s.defaultUserData);
  const platform = useStore(app, (s) => s.app?.platform);
  const switchable = useStore(app, () => canSwitch());
  const clients = useStore(app, (s) => s.clients, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const theme = useThemePref();
  const [f, setF] = useState<Settings | null>(null);
  const [riskStr, setRiskStr] = useState("7");
  const [threshStr, setThreshStr] = useState("10");
  const [initialJson, setInitialJson] = useState("");
  const [err, setErr] = useState<{ field: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && settings) {
      const init = { ...settings };
      setF(init);
      setRiskStr(String(settings.default_risk_days));
      setThreshStr(String(settings.next_threshold ?? 10));
      setInitialJson(JSON.stringify({ ...init, riskStr: String(settings.default_risk_days), threshStr: String(settings.next_threshold ?? 10) }));
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!f) return <Sheet open={false} onClose={() => {}} title="">{null}</Sheet>;
  const dirty = open && initialJson !== "" && JSON.stringify({ ...f, riskStr, threshStr }) !== initialJson;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setF((x) => (x ? { ...x, [k]: v } : x));
    if (err?.field === k) setErr(null);
  };
  const close = () => app.set({ sheet: null });
  const submit = async () => {
    const parsedRisk = riskStr.trim() === "" ? NaN : Number(riskStr);
    const parsedThresh = threshStr.trim() === "" ? NaN : Number(threshStr);
    if (!Number.isInteger(parsedRisk) || parsedRisk < 0) {
      setErr({ field: "default_risk_days", msg: "默认风控期天数请填 0 或正整数" });
      return;
    }
    if (switchable && (!Number.isInteger(parsedThresh) || parsedThresh < 0 || parsedThresh > 99)) {
      setErr({ field: "next_threshold", msg: "额度门槛请填 0–99 之间的整数" });
      return;
    }
    setBusy(true);
    try {
      await saveSettings({ ...f, default_risk_days: parsedRisk, next_threshold: switchable ? parsedThresh : f.next_threshold });
      close();
      toast.ok("设置已保存");
    } catch (e) {
      const msg = errText(e);
      setErr({ field: fieldOf(msg, ["default_proxy", "chrome_path", "chrome_user_data", "default_risk_days", "next_threshold"]), msg });
    } finally {
      setBusy(false);
    }
  };
  const e = (k: string) => (err?.field === k ? err.msg : undefined);
  const chromeHint = platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const backed = clients.filter((c) => c.has_backup);

  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title="设置"
      width={560}
      footer={
        <>
          {err && !err.field && <p className="min-w-0 flex-1 truncate text-xs text-danger">{err.msg}</p>}
          <div className="flex-1" />
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Section title="外观">
          <Segmented<ThemePref>
            id="theme"
            full
            items={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            value={theme}
            onChange={setThemePref}
          />
        </Section>
        <Section title="新账号">
          <Field label="默认风控期（天）" error={e("default_risk_days")} hint="新加的号默认按这个天数算风控期">
            {(id) => (
              <TextInput
                id={id}
                wide={false}
                inputMode="numeric"
                value={riskStr}
                onChange={(x) => {
                  setRiskStr(x.target.value.replace(/[^\d]/g, ""));
                  if (err?.field === "default_risk_days") setErr(null);
                }}
                className="w-28 tnum"
                aria-invalid={!!e("default_risk_days")}
              />
            )}
          </Field>
        </Section>
        <Section title="网络">
          <Field label="默认代理" error={e("default_proxy")} hint="号没单独设代理时用它；国内访问 Google 一般要填">
            {(id) => <TextInput id={id} mono value={f.default_proxy} onChange={(x) => set("default_proxy", x.target.value)} placeholder="http://127.0.0.1:7890（空着 = 直连）" aria-invalid={!!e("default_proxy")} />}
          </Field>
        </Section>
        <Section title="浏览器">
          <Field label="Chrome 程序" error={e("chrome_path")} hint="空着会自动找">
            {(id) => <TextInput id={id} mono value={f.chrome_path} onChange={(x) => set("chrome_path", x.target.value)} placeholder={chromeHint} aria-invalid={!!e("chrome_path")} />}
          </Field>
          <Field label="日常 Chrome 资料目录" error={e("chrome_user_data")} hint="「从 Chrome 导入」从这里读已登录的资料">
            {(id) => <TextInput id={id} mono value={f.chrome_user_data} onChange={(x) => set("chrome_user_data", x.target.value)} placeholder={defaultUserData} aria-invalid={!!e("chrome_user_data")} />}
          </Field>
        </Section>
        {switchable && (
          <Section title="Antigravity 切号">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="IDE 程序路径" hint="空着会自动找">
                {(id) => <TextInput id={id} mono value={f.ide_path} onChange={(x) => set("ide_path", x.target.value)} />}
              </Field>
              <Field label="经典款程序路径" hint="空着会自动找">
                {(id) => <TextInput id={id} mono value={f.classic_path} onChange={(x) => set("classic_path", x.target.value)} />}
              </Field>
            </div>
            <Field label="「切下个」看哪个额度" error={e("next_threshold")} hint="只挑已授权、过了风控期、这一项额度（5 小时和每周）都够的号；付费等级高、剩得多、最久没用的优先">
              {() => (
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented
                    id="pool"
                    size="sm"
                    items={[
                      { value: "any", label: "两个都要够" },
                      { value: "gemini", label: "Gemini" },
                      { value: "claude", label: "Claude / GPT" },
                    ]}
                    value={f.next_pool}
                    onChange={(v) => set("next_pool", v)}
                  />
                  <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-ink-2">
                    <span>至少剩</span>
                    <TextInput
                      wide={false}
                      inputMode="numeric"
                      value={threshStr}
                      onChange={(x) => {
                        setThreshStr(x.target.value.replace(/[^\d]/g, "").slice(0, 2));
                        if (err?.field === "next_threshold") setErr(null);
                      }}
                      className="h-7 w-14 px-2 text-center tnum"
                      aria-invalid={!!e("next_threshold")}
                    />
                    <span>%</span>
                  </label>
                </div>
              )}
            </Field>
            {backed.length > 0 && <FingerprintRestore clients={backed} />}
          </Section>
        )}
        <Section title="数据">
          <div className="flex items-center gap-2 rounded-[8px] bg-fill px-3 py-2">
            <code className="selectable min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{dataDir}</code>
            <Button size="xs" variant="ghost" icon={Copy} onClick={() => copyPlain(dataDir, "数据目录路径已复制")}>
              复制路径
            </Button>
          </div>
          <p className="text-xs text-ink-3">账号、密码和 2FA 都存在这个文件夹里。换电脑时整个文件夹拷走就行。</p>
        </Section>
      </div>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold tracking-[0.02em] text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function FingerprintRestore({ clients }: { clients: ClientStatus[] }) {
  const [target, setTarget] = useState<ClientStatus | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const anchor = useMemo(
    () => ({
      get current() {
        return target ? refs.current[target.target] ?? null : null;
      },
    }),
    [target],
  );
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-ink-2">恢复本机原始设备指纹</p>
      <div className="flex flex-wrap gap-1.5">
        {clients.map((c) => (
          <Button
            key={c.target}
            ref={(el) => {
              refs.current[c.target] = el;
            }}
            size="sm"
            icon={Fingerprint}
            onClick={() => setTarget(c)}
          >
            {CLIENTS[c.target].short}
          </Button>
        ))}
      </div>
      <ConfirmPop
        open={!!target}
        onClose={() => setTarget(null)}
        anchor={anchor as React.RefObject<HTMLElement | null>}
        placement="bottom-start"
        title={target ? `恢复 ${CLIENTS[target.target].name} 的原始指纹？` : ""}
        message={target ? `${target.running ? "会先关掉它，恢复后再打开。" : ""}登录的号不变。` : ""}
        confirmLabel="恢复"
        onConfirm={async () => {
          if (!target) return;
          try {
            const r = await api.restoreFingerprint(target.target);
            if (r.warning) toast.err(`已恢复，但${r.warning}`);
            else toast.ok(`${CLIENTS[target.target].short} 已恢复本机原始指纹`);
          } catch (err) {
            toast.err(errText(err));
          }
        }}
      />
    </div>
  );
}

/* ───────── 从 Chrome 导入 ───────── */

export function ImportSheet() {
  const open = useStore(app, (s) => s.sheet?.kind === "import");
  const [data, setData] = useState<{ user_data: string; profiles: ChromeProfile[] } | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [permErr, setPermErr] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => {
    setData(null);
    setLoadErr("");
    setPermErr(false);
    api
      .chromeProfiles()
      .then((r) => {
        const profiles = [...r.profiles].sort((x, y) => (y.created || "").localeCompare(x.created || ""));
        setData({ ...r, profiles });
        const importable = profiles.filter((p) => p.email && !p.account_id);
        setPicked(new Set(importable.length <= 5 ? importable.map((p) => p.dir) : []));
      })
      .catch((e) => {
        setPermErr(e instanceof ApiError && e.status === 403);
        setLoadErr(errText(e));
      });
  };

  useEffect(() => {
    if (!open) return;
    load();
  }, [open]);

  const openFullDiskAccess = () => {
    api.openFullDiskAccess().catch((e) => toast.err(errText(e)));
  };
  const revealApp = () => {
    api.revealApp().catch((e) => toast.err(errText(e)));
  };

  const importable = data?.profiles.filter((p) => p.email && !p.account_id) ?? [];
  const allOn = importable.length > 0 && importable.every((p) => picked.has(p.dir));
  const toggle = (dir: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      return n;
    });
  const close = () => app.set({ sheet: null });
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.importProfiles([...picked]);
      close();
      await reloadAccounts();
      const parts = [r.added ? `加了 ${r.added} 个号` : "", r.existed ? `${r.existed} 个已经在列表里` : ""].filter(Boolean);
      toast.ok(parts.length ? `导入好了：${parts.join("，")}` : "没有导入新的号");
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="从 Chrome 导入"
      subtitle={data?.user_data}
      width={600}
      footer={
        <>
          {importable.length > 0 && (
            <button type="button" onClick={() => setPicked(new Set(allOn ? [] : importable.map((p) => p.dir)))} className="text-sm font-medium text-accent hover:underline">
              {allOn ? "全不选" : `全选 ${importable.length} 个`}
            </button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!picked.size} onClick={submit}>
            {picked.size ? `导入 ${picked.size} 个` : "导入"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-2">读取日常 Chrome 里已登录 Google 的资料（邮箱、名字、创建日期、头像）。导入后用程序自带的浏览器打开，Chrome 里的旧资料之后可以删掉。</p>
      {permErr ? (
        <div className="space-y-3 rounded-[10px] bg-danger-soft px-3.5 py-3 text-sm text-ink">
          <p className="font-medium text-danger">macOS 拦截了读取 Chrome 资料目录的权限</p>
          <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-ink-2">
            <li>点下方「打开系统设置」，进入「隐私与安全性 → 完全磁盘访问权限」。</li>
            <li>开启「谷歌账号管理」的开关；若列表中没有，点「在访达中定位本程序」后直接拖进列表（已有旧条目可关闭重开一次）。</li>
            <li>完全退出并重新打开本程序，再点「从 Chrome 导入」。</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button variant="primary" size="sm" onClick={openFullDiskAccess}>
              打开系统设置
            </Button>
            <Button variant="ghost" size="sm" onClick={revealApp}>
              在访达中定位本程序
            </Button>
            <Button variant="ghost" size="sm" onClick={load}>
              重新读取
            </Button>
          </div>
        </div>
      ) : loadErr ? (
        <p className="rounded-[8px] bg-danger-soft px-3 py-2 text-sm text-danger">{loadErr}</p>
      ) : !data ? (
        <div className="flex items-center gap-2 py-6 text-sm text-ink-3">
          <Spinner /> 正在读取 Chrome 资料…
        </div>
      ) : data.profiles.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-3">没找到 Chrome 资料</p>
      ) : (
        <ul className="flex flex-col gap-0.5 rounded-[10px] bg-surface-2 p-1 shadow-[inset_0_0_0_0.5px_var(--line)]">
          {data.profiles.map((p) => {
            const can = !!p.email && !p.account_id;
            const on = picked.has(p.dir);
            return (
              <li key={p.dir}>
                <button
                  type="button"
                  disabled={!can}
                  onClick={() => toggle(p.dir)}
                  aria-pressed={on}
                  className={cx("flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-left transition-colors duration-[120ms]", can ? "hover:bg-fill" : "opacity-50", on && "bg-accent-soft hover:bg-accent-soft")}
                >
                  <span className={cx("grid size-[18px] shrink-0 place-items-center rounded-[5px] transition-colors duration-[120ms]", on ? "bg-accent text-white" : "bg-surface shadow-[inset_0_0_0_1px_var(--line-strong)]")}>
                    <AnimatePresence>
                      {on && (
                        <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.press }} exit={{ scale: 0.4, opacity: 0, transition: fade.out }}>
                          <Check size={12} strokeWidth={3} />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <Avatar src={p.has_avatar ? `/api/chrome-profiles/${encodeURIComponent(p.dir)}/avatar` : undefined} email={p.email || p.name || "?"} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{p.email || p.name || p.dir}</span>
                    <span className="block truncate text-xs text-ink-3">{p.name || p.gaia_name || p.dir}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-ink-3">
                    {!p.email ? "没登录 Google" : p.account_id ? "已在列表里" : p.created ? `${p.created} 建的` : ""}
                    <span className="block font-mono text-2xs">{p.dir}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
