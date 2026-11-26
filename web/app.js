"use strict";

const state = {
  accounts: [], clients: [], settings: null, dataDir: "", defaultUserData: "",
  filter: "all", tag: "", query: "", loaded: false, addingTagId: 0,
  vault: { until: 0, user: "" }, // 查看密码的解锁截止时间（Unix 秒）
  revealed: new Map(),           // 账号 ID → { password, previous }；锁定时清空
  totp: { codes: {}, errors: {}, periodEnd: 0, period: 30 },
};

// 带图标和文字的按钮；iconOnly 时文字作为无障碍名称和悬停提示。
function button({ label, iconName, variant = "", iconOnly = false, title, onClick }) {
  const cls = iconOnly ? `button.btn-icon.btn-sm${variant}` : `button.btn.btn-sm${variant}`;
  return h(cls, {
    type: "button",
    title: title || (iconOnly ? label : undefined),
    "aria-label": iconOnly ? label : undefined,
    onclick: onClick,
  }, iconName ? icon(iconName) : null, iconOnly ? null : h("span", {}, label));
}

/* ---------- 提示（合并去重、无闪屏动画） ---------- */

const toastTimers = new Map();
function toast(msg, isError) {
  const key = `${isError}:${msg}`;
  const old = toastTimers.get(key);
  if (old) {
    clearTimeout(old.timer);
    old.timer = setTimeout(() => dismissToast(key), isError ? 6000 : 2800);
    return;
  }
  // 成功反馈只保留最新一条；错误最多两条，不遮住整列行尾操作。
  for (const [existingKey, entry] of toastTimers) {
    if (!entry.isError && !isError) dismissToast(existingKey);
  }
  if (isError) {
    const errors = [...toastTimers.entries()].filter(([, entry]) => entry.isError);
    if (errors.length >= 2) dismissToast(errors[0][0]);
  }
  const el = h(isError ? "div.toast.error" : "div.toast", { role: isError ? "alert" : "status" },
    icon(isError ? "warning" : "check-circle"),
    h("p", {}, msg),
    h("button.btn-icon", { type: "button", "aria-label": "关闭提示", onclick: () => dismissToast(key) }, icon("x")));
  $("#toasts").append(el);
  const entry = { el, timer: 0, isError };
  toastTimers.set(key, entry);
  entry.timer = setTimeout(() => dismissToast(key), isError ? 6000 : 2800);
}

function dismissToast(key) {
  const entry = toastTimers.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.el.remove();
  toastTimers.delete(key);
}

// Bencho 风格原地复制确认：图标瞬态切换为绿勾，1.3 秒后静默复原。
function flashCopied(btn) {
  if (!btn || !btn.isConnected) return;
  btn.classList.add("is-copied");
  const use = btn.querySelector("use");
  const prevHref = use ? use.getAttribute("href") : "";
  if (use && prevHref) use.setAttribute("href", "icons.svg#i-check");
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.classList.remove("is-copied");
    if (use && prevHref) use.setAttribute("href", prevHref);
  }, 1300);
}

async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add("is-busy");
  btn.setAttribute("aria-busy", "true");
  try { await fn(); } catch (e) { toast(e.message, true); } finally {
    btn.disabled = false;
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
  }
}

/* ---------- 主题切换（浅色 / 深色） ---------- */

function effectiveTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncThemeButton() {
  const isDark = effectiveTheme() === "dark";
  const label = isDark ? "切换为浅色外观" : "切换为深色外观";
  $("#btn-theme").setAttribute("aria-label", label);
  $("#btn-theme").setAttribute("title", label);
}

$("#btn-theme").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("gam-theme", next); } catch {}
  syncThemeButton();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeButton);
syncThemeButton();

/* ---------- 对话框 ---------- */

// 非提交型关闭按钮：让输入框里的 Enter 始终交给主操作按钮，而不是第一个「取消」。
for (const btn of document.querySelectorAll("button[data-close]")) {
  btn.addEventListener("click", () => btn.closest("dialog").close(btn.dataset.close));
}

// 打开模态框；关闭后焦点回到打开它的控件。
function showDialog(dlg) {
  const opener = document.activeElement;
  dlg.addEventListener("close", () => { if (opener && opener.isConnected) opener.focus(); }, { once: true });
  dlg.showModal();
  const initial = dlg.querySelector("[autofocus]");
  if (initial) initial.focus();
}

function clearFormError(form, errorEl) {
  errorEl.textContent = "";
  for (const field of form.querySelectorAll("[aria-invalid=\"true\"]")) {
    field.removeAttribute("aria-invalid");
    if (field.getAttribute("aria-describedby") === errorEl.id) field.removeAttribute("aria-describedby");
  }
}

function setFormError(form, errorEl, message) {
  clearFormError(form, errorEl);
  errorEl.textContent = message;
  const rules = [
    [/邮箱/, "email"], [/首次登录|登录日期/, "login_date"], [/改密日期/, "pwd_changed_date"],
    [/风控期/, form.id === "form-settings" ? "default_risk_days" : "risk_days"],
    [/额度门槛|剩余额度/, "next_threshold"], [/Chrome 路径/i, "chrome_path"],
    [/用户数据目录/, "chrome_user_data"], [/代理/, form.id === "form-settings" ? "default_proxy" : "proxy"],
    [/2FA|密钥/i, "totp_secret"], [/Token/i, "refresh_token"], [/密码/, "password"],
  ];
  const match = rules.find(([pattern, name]) => pattern.test(message) && form.elements.namedItem(name));
  const field = match && form.elements.namedItem(match[1]);
  if (!field) {
    errorEl.tabIndex = -1;
    errorEl.focus();
    return;
  }
  const disclosure = field.closest("details");
  if (disclosure) disclosure.open = true;
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", errorEl.id);
  field.focus();
}

for (const [formSelector, errorSelector] of [["#form-account", "#account-error"], ["#form-settings", "#settings-error"]]) {
  const form = $(formSelector);
  const errorEl = $(errorSelector);
  form.addEventListener("input", (e) => {
    e.target.removeAttribute("aria-invalid");
    if (e.target.getAttribute("aria-describedby") === errorEl.id) e.target.removeAttribute("aria-describedby");
    errorEl.textContent = "";
  });
}

function confirmDialog({ title, message, okLabel, danger }) {
  const dlg = $("#dlg-confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.className = danger ? "btn btn-danger" : "btn btn-primary";
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.returnValue = "";
    showDialog(dlg);
    $("#confirm-cancel").focus();
  });
}

/* ---------- 分段筛选滑动指示器（BoardUI + HeroUI Pro） ---------- */

function syncSegThumb() {
  const seg = $("#status-segment");
  const thumb = $("#seg-thumb");
  const active = seg.querySelector('.seg-item[aria-pressed="true"]');
  if (!active || !thumb) return;
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.height = `${active.offsetHeight}px`;
}

if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(syncSegThumb);
  ro.observe($("#status-segment"));
  for (const el of document.querySelectorAll("#status-segment .seg-item")) ro.observe(el);
}

/* ---------- 时间 ---------- */

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 额度 ---------- */

function quotaRow(name, windowName, fraction, resetTime) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const level = quotaLevel(pct);
  const win = windowLabel[windowName] || windowName;
  const fullWin = windowName === "5h" ? "5 小时" : win;
  const title = resetTime
    ? `${name}（${fullWin}）：剩余 ${pct}%，${fromNow(resetTime)}重置（${fmtTime(resetTime)}）`
    : `${name}（${fullWin}）：剩余 ${pct}%`;
  const fill = h("i");
  fill.style.width = `${pct}%`;
  return [
    h("span.quota-name", { title }, shortGroupName(name)),
    h("span.quota-win", { title }, win),
    h(level ? `div.bar.${level}` : "div.bar", {
      role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct),
      "aria-label": `${name} ${fullWin}剩余额度`, title,
    }, fill),
    h("span.quota-reset", { title, "data-reset": resetTime || undefined }, resetTime ? fmtCountdown(resetTime) : ""),
    h(level ? `span.quota-pct.${level}` : "span.quota-pct", { title }, `${pct}%`),
  ];
}

function appealAccount(a, btn) {
  busy(btn, async () => {
    const r = await api("POST", `/api/accounts/${a.id}/appeal`);
    await loadAccounts();
    launched(r, `已在 ${a.email} 的浏览器中打开官方申诉页`);
  });
}

function checkAccountService(a, btn) {
  busy(btn, async () => {
    try {
      const r = await api("POST", `/api/accounts/${a.id}/service-check`);
      state.accounts = r.accounts;
      render();
      toast(r.message, r.status === "disabled");
    } catch (err) {
      await loadAccounts();
      throw err;
    }
  });
}

function serviceNotice(a) {
  if (!a.service_disabled) return null;
  const appealed = a.appeal_at > 0;
  return h("div.service-notice", { role: "note" },
    icon("warning"),
    h("div.service-body", {},
      h("strong.service-title", {}, appealed ? "Antigravity 申诉审核中" : "Antigravity 已停用"),
      h("p", {}, "该账号的对话服务已被 Google 限制，需要提交申诉。"),
      a.service_error_id ? h("button.service-error-id", {
        type: "button", title: "复制 Error ID", "aria-label": `复制 Error ID ${a.service_error_id}`,
        onclick: (e) => copyText(a.service_error_id, "Error ID 已复制", e.currentTarget),
      }, h("span", {}, `Error ID: ${a.service_error_id}`), icon("copy")) : null,
      h("div.service-actions", {},
        button({ label: appealed ? "再次打开申诉" : "去申诉", iconName: "shield-check", variant: ".btn-soft-danger",
          title: "在这个账号的独立浏览器中打开 Google 官方申诉表单", onClick: (e) => appealAccount(a, e.currentTarget) }),
        button({ label: "重新检测", iconName: "arrows-clockwise", variant: ".btn-ghost",
          title: "先查接口；当前 CLI 是这个账号时再发一条最小真实对话", onClick: (e) => checkAccountService(a, e.currentTarget) }),
        appealed ? h("span.service-time", { title: fmtTime(a.appeal_at) }, `${fromNow(a.appeal_at)}已提交`) : null)));
}

// 兼容清理已存数据库里的原始 Google JSON 报错，并提取安全验证链接供一键在独立浏览器打开。
function cleanQuotaError(raw) {
  if (!raw) return { text: "", verifyUrl: "" };
  let s = String(raw).trim();
  if (s.includes("SUBSCRIPTION_REQUIRED") || s.includes("#3501")) {
    return {
      text: "未开通可用许可（#3501）：该账号未获得免费档资格（常见于代理节点或账号归属地区不支持），点顶栏「刷新额度」可诊断具体原因",
      verifyUrl: "",
    };
  }
  const brace = s.indexOf("{");
  if (brace >= 0 && s.includes('"error"')) {
    try {
      const parsed = JSON.parse(s.slice(brace));
      const err = parsed && parsed.error;
      if (err && typeof err === "object" && err.message) {
        const reason = Array.isArray(err.details) && err.details.find((d) => d && d.reason)?.reason;
        s = reason ? `Google 返回 ${err.code || ""}（${reason}）：${err.message}` : `Google 返回 ${err.code || ""}：${err.message}`;
      }
    } catch {}
  }
  const urlMatch = s.match(/https:\/\/(?:[a-z0-9-]+\.)*google\.com\/[^\s)"]*/i);
  const verifyUrl = urlMatch && s.includes("VALIDATION_REQUIRED") ? urlMatch[0] : "";
  if (verifyUrl) s = s.replace(verifyUrl, "").trim().replace(/[：:]$/, "");
  return { text: s, verifyUrl };
}

function quotaCell(a) {
  const notice = serviceNotice(a);
  if (!a.has_token) {
    return h("div.quota", {}, notice, h("span.quota-unauth", { title: "点击右侧「授权」后即可查询反重力额度" }, "— 未授权"));
  }
  const q = a.quota;
  const rows = [];
  for (const g of (q && q.groups) || []) {
    for (const b of g.buckets || []) rows.push(...quotaRow(g.display_name, b.window, b.remaining_fraction, b.reset_time));
  }
  const hasHead = (q && q.tier) || a.quota_at;
  const errInfo = cleanQuotaError(a.quota_error);
  if (a.service_disabled && /服务已被停用|violation of terms of service/i.test(errInfo.text)) errInfo.text = "";
  const checkEntry = !a.service_disabled ? button({
    label: "检测服务", iconName: "shield-check", variant: ".btn-ghost.service-check-entry",
    title: "先查接口；当前 CLI 是这个账号时再发一条最小真实对话",
    onClick: (e) => checkAccountService(a, e.currentTarget),
  }) : null;
  return h("div.quota", {}, notice,
    (hasHead || checkEntry) ? h("div.quota-head", {},
      q && q.tier ? h("span.badge.badge-tier", {}, q.tier) : null,
      a.quota_at ? h("span.quota-foot", { title: fmtTime(a.quota_at) }, `${a.quota_error ? "上次尝试" : "更新于"} ${fromNow(a.quota_at)}`) : null,
      checkEntry) : null,
    rows.length ? h("div.quota-grid", {}, rows)
      : q ? h("p.muted", {}, "暂无额度数据")
      : a.quota_error ? null
      : h("p.muted", {}, "尚未查询，点顶栏「刷新额度」"),
    errInfo.text ? h("div.quota-error", { role: "note" },
      icon("warning"),
      h("div.quota-error-body", {},
        h("span", {}, errInfo.text),
        errInfo.verifyUrl ? h("button.btn-link.quota-verify", {
          type: "button",
          onclick: (e) => busy(e.currentTarget, async () => {
            launched(await api("POST", `/api/accounts/${a.id}/open?url=${encodeURIComponent(errInfo.verifyUrl)}`), `已在 ${a.email} 的浏览器中打开验证页`);
          }),
        }, "在该号浏览器中去验证 →") : null)) : null,
  );
}

/* ---------- 列表 ---------- */

const statusOrder = { due: 0, risk: 1, changed: 2 };

// 只有过了风控期才提供改密操作；有待确认的新密码时优先提示继续，避免新密码丢失。
function statusCell(a) {
  if (a.has_pending_password) {
    return h("div", {},
      h("span.badge.badge-pending", {}, icon("key"), "新密码待确认"),
      h("p.meta", {}, "改完后点「改好了」才替换旧密码"),
      h("div.status-actions", {},
        button({ label: "继续改密", iconName: "key", variant: ".btn-soft-warn", onClick: (e) => openChangeDialog(a, e.currentTarget) })));
  }
  if (a.status === "due") {
    return h("div", {},
      h("span.badge.badge-due", {}, icon("warning"), "该改密码了"),
      h("p.meta", {}, `风控期 ${a.risk_days} 天已过`),
      h("div.status-actions", {},
        button({ label: "去改密", iconName: "key", variant: ".btn-soft-warn", title: "生成新密码并打开改密页", onClick: (e) => openChangeDialog(a, e.currentTarget) }),
        button({
          label: "已改密", iconName: "check-circle", variant: ".btn-ghost", title: "标记今天已改过密码",
          onClick: (e) => {
            const btn = e.currentTarget;
            confirmDialog({ title: "标记为已改密？", message: `确认 ${a.email} 今天已经改过密码。`, okLabel: "标记已改密" }).then((ok) => {
              if (ok) busy(btn, async () => { await api("POST", `/api/accounts/${a.id}/password-changed`); await loadAccounts(); toast("已标记为已改密"); });
            });
          },
        })));
  }
  if (a.status === "risk") {
    const fill = h("i");
    fill.style.width = `${a.risk_days ? Math.min(100, Math.round((a.login_days / a.risk_days) * 100)) : 100}%`;
    return h("div", {},
      h("span.badge.badge-risk", {}, icon("clock"), `风控期中 · 剩 ${a.risk_left} 天`),
      h("div.risk-track", { title: `已过 ${a.login_days} / ${a.risk_days} 天` }, fill));
  }
  return h("div", {},
    h("span.badge.badge-changed", {}, icon("check-circle"), "已改密"),
    h("p.meta.mono", {}, a.pwd_changed_date));
}

// 浏览器已打开但密码没能写进它的密码库时，后端返回 warning。
function launched(r, okMsg) {
  if (r && r.warning) toast(`${okMsg}。${r.warning}`, true);
  else toast(okMsg);
}

function open(a, target, btn) {
  busy(btn, async () => {
    launched(await api("POST", `/api/accounts/${a.id}/open?target=${target}`), `已用 ${a.email} 的浏览器打开`);
  });
}

/* ---------- 切换 Antigravity 客户端账号 ---------- */

let activeMenu = null;
let activeMenuAnchor = null;

function closeMenu(restoreFocus = false) {
  if (!activeMenu) return;
  const anchor = activeMenuAnchor;
  activeMenu.remove();
  activeMenu = null;
  activeMenuAnchor = null;
  if (anchor) anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor && anchor.isConnected) anchor.focus();
}

document.addEventListener("pointerdown", (e) => {
  if (activeMenu && !activeMenu.contains(e.target) && !e.target.closest("[data-menu-trigger]")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  const trigger = e.target.closest && e.target.closest("[data-menu-trigger]");
  if (trigger && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    trigger.click();
    if (e.key === "ArrowUp" && activeMenu) {
      const items = activeMenu.querySelectorAll("button:not([disabled])");
      items[items.length - 1]?.focus();
    }
    return;
  }
  if (e.key === "Escape" && activeMenu) {
    e.preventDefault();
    closeMenu(true);
  }
});
window.addEventListener("scroll", () => closeMenu(), true);

// 在 anchor 下方弹出操作菜单；方向键移动，Escape / Tab 关闭并回到触发点。
function openMenu(anchor, items) {
  if (activeMenu && activeMenu.dataset.owner === anchor.dataset.menuTrigger) { closeMenu(true); return; }
  closeMenu();
  activeMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const pop = h("div.menu-pop", { role: "menu", "aria-label": "可用操作", "data-owner": anchor.dataset.menuTrigger },
    ...items.map((it) => h("button.menu-item", {
      type: "button", role: "menuitem", tabindex: "-1", disabled: it.disabled, title: it.title,
      onclick: () => { closeMenu(true); it.onClick(); },
    }, icon(it.iconName), h("span.menu-label", {}, it.label), it.hint ? h("span.menu-hint", {}, it.hint) : null)));
  document.body.append(pop);
  activeMenu = pop;
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.right - popRect.width));
  const top = rect.bottom + 6 + popRect.height > window.innerHeight ? rect.top - popRect.height - 6 : rect.bottom + 6;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(8, top))}px`;
  pop.addEventListener("keydown", (e) => {
    const enabled = [...pop.querySelectorAll("button:not([disabled])")];
    const current = enabled.indexOf(document.activeElement);
    let next = current;
    if (e.key === "ArrowDown") next = (current + 1 + enabled.length) % enabled.length;
    else if (e.key === "ArrowUp") next = (current - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    else if (e.key === "Tab") { e.preventDefault(); closeMenu(true); return; }
    else return;
    e.preventDefault();
    if (enabled.length) enabled[Math.max(0, next)].focus();
  });
  const enabled = pop.querySelectorAll("button:not([disabled])");
  enabled[0]?.focus();
}

function activeClientsOf(a) {
  return state.clients.filter((c) => c.account_id === a.id);
}

async function loadClients() {
  try {
    state.clients = await api("GET", "/api/clients");
  } catch (e) {
    state.clients = [];
    toast(`读取 Antigravity 客户端状态失败：${e.message}`, true);
  }
}

// 切桌面客户端会关闭并重启它，运行中时先确认一次。
async function switchClient(a, c, btn) {
  const meta = CLIENTS[c.target];
  if (c.target !== "agy" && c.running) {
    const ok = await confirmDialog({
      title: `把 ${meta.name} 切换为 ${a.email}？`,
      message: `会先关闭正在运行的 ${meta.name}（没保存的内容可能丢失），写入这个号和它的设备指纹后自动重新打开。`,
      okLabel: "关闭并切换",
    });
    if (!ok) return;
  }
  await busy(btn, async () => {
    const r = await api("POST", `/api/accounts/${a.id}/switch?target=${c.target}`);
    await loadClients();
    render();
    launched(r, `${meta.name} 已切换为 ${r.email}`);
  });
}

function openSwitchMenu(a, btn) {
  openMenu(btn, state.clients.map((c) => {
    const meta = CLIENTS[c.target];
    const current = c.account_id === a.id;
    const hint = !c.installed ? "未安装" : current ? "当前" : c.target !== "agy" && c.running ? "会重启" : "";
    return {
      label: `切到 ${meta.label}`, hint, iconName: meta.icon,
      disabled: !c.installed || current,
      title: !c.installed ? `没找到 ${meta.name}（可在设置里填程序路径）` : current ? `${meta.name} 当前就是这个号` : `把 ${meta.name} 的登录账号换成 ${a.email}`,
      onClick: () => switchClient(a, c, btn),
    };
  }));
}

function row(a) {
  const active = activeClientsOf(a);
  const actions = h("div.actions", {},
    h("button.btn.btn-sm", {
      type: "button", "data-menu-trigger": `switch-${a.id}`, "aria-haspopup": "menu", "aria-expanded": "false",
      disabled: !a.has_token, title: a.has_token ? "把 Antigravity 的登录账号换成这个号" : "先授权才能切号",
      onclick: (e) => openSwitchMenu(a, e.currentTarget),
    }, icon("shuffle"), h("span", {}, "切号")),
    button({ label: "浏览器", iconName: "globe", title: "打开这个号的浏览器（Google 账号页）", onClick: (e) => open(a, "browser", e.currentTarget) }),
    button({
      label: a.has_token ? "重新授权" : "授权",
      iconName: "shield-check",
      variant: a.has_token ? ".btn-auth" : ".btn-auth.btn-soft-accent",
      title: "在这个号的浏览器里打开 Google 授权页，授权后即可查额度",
      onClick: (e) => busy(e.currentTarget, async () => {
        launched(await api("POST", `/api/accounts/${a.id}/authorize`), "已在该号的浏览器里打开授权页，授权完成后切回窗口会自动更新");
      }),
    }),
    h("span.sep", { "aria-hidden": "true" }),
    button({ label: `编辑 ${a.email}`, iconName: "pencil-simple", iconOnly: true, variant: ".action-subtle", onClick: () => openAccountDialog(a) }),
    button({
      label: `删除 ${a.email}`, iconName: "trash", iconOnly: true, variant: ".action-subtle.danger",
      onClick: (e) => {
        const btn = e.currentTarget;
        confirmDialog({
          title: `删除 ${a.email}？`,
          message: `只删除这条记录和它的授权。\n浏览器资料目录会保留：\n${a.profile_path}`,
          okLabel: "删除记录", danger: true,
        }).then((ok) => {
          if (ok) busy(btn, async () => { await api("DELETE", `/api/accounts/${a.id}`); await loadAccounts(); toast(`已删除 ${a.email}`); });
        });
      },
    }),
  );

  const rowClass = ["tr", a.has_pending_password ? "row-pending" : a.status === "due" ? "row-due" : "", active.length ? "row-active" : "", a.service_disabled ? "row-service-disabled" : ""].filter(Boolean).join(".");
  const chips = [
    a.chrome_profile ? h("span.chip", { title: `日常 Chrome 个人资料：${a.profile_dir}\\${a.chrome_profile}` }, icon("google-chrome-logo"), a.chrome_profile) : null,
    a.proxy ? h("span.chip", { title: a.chrome_profile ? "代理（仅用于查额度）" : "代理" }, icon("globe"), a.proxy) : null,
  ].filter(Boolean);

  return h(rowClass, {},
    h("td", { "data-label": "" }, h("div.account", {},
      avatar(a.has_avatar ? `/api/accounts/${a.id}/avatar` : "", a.email),
      h("div.account-body", {},
        h("button.email-link", { type: "button", title: `${a.email}\n点击在这个号的浏览器里打开 Gmail`, onclick: (e) => open(a, "mail", e.currentTarget) },
          h("span.email-text", {}, a.email), icon("envelope-simple")),
        active.length ? h("div.client-badges", {}, active.map((c) => h("span.client-badge", { title: `${CLIENTS[c.target].name} 当前登录的就是这个号` },
          icon(CLIENTS[c.target].icon), CLIENTS[c.target].label))) : null,
        a.note ? h("p.meta", {}, a.note) : null,
        tagsBar(a),
        chips.length ? h("div.chips", {}, chips) : null,
        a.has_password || a.has_totp ? h("div", { "data-cred": String(a.id) }, credCell(a)) : null))),
    h("td", { "data-label": "登录天数" },
      h("div.days", {}, String(a.login_days), h("small", {}, "天")),
      h("p.meta.mono", {}, a.login_date)),
    h("td", { "data-label": "风控 / 改密" }, statusCell(a)),
    h("td", { "data-label": "反重力额度" }, quotaCell(a)),
    h("td", { "data-label": "" }, actions),
  );
}

function tagsOf(a) {
  return Array.isArray(a.tags) ? a.tags : [];
}

const TAG_HUES = [
  { id: "blue", label: "海蓝" },
  { id: "violet", label: "鸢尾紫" },
  { id: "emerald", label: "翡翠绿" },
  { id: "amber", label: "琥珀黄" },
  { id: "rose", label: "珊瑚红" },
  { id: "cyan", label: "青碧" },
  { id: "orange", label: "暖橙" },
  { id: "indigo", label: "靛青" },
];

// 语义优先 + FNV-1a 哈希兜底；用户手动指定过颜色时以用户选择为准。
function autoTagHue(tag) {
  const s = tag.trim().toLowerCase();
  if (!s) return "blue";
  if (/ultra|pro|vip|会员|订阅|付费|plus/.test(s)) return "violet";
  if (/jio|印|india|土|尼|巴/.test(s)) return "amber";
  if (/美|us|自注|自建|主力|正常|稳/.test(s)) return "emerald";
  if (/kyc|风控|异常|封|申诉|急|重/.test(s)) return "rose";
  if (/日|jp|新|sg|港|台|韩|欧|英|家庭/.test(s)) return "cyan";
  if (/买|渠道|qq|咸鱼|号商|批/.test(s)) return "orange";
  if (/free|免|白嫖|测试|备/.test(s)) return "blue";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return TAG_HUES[(h >>> 0) % TAG_HUES.length].id;
}

function tagHue(tag) {
  const custom = state.settings && state.settings.tag_colors;
  const key = (tag || "").trim().toLowerCase();
  if (custom && key && custom[key]) return custom[key];
  return autoTagHue(key);
}

let activeColorPop = null;
let activeColorAnchor = null;
let pendingNewTagHue = ""; // 新增标签输入框里临时选定的颜色

function closeTagColorPop(restoreFocus = false) {
  if (!activeColorPop) return;
  const anchor = activeColorAnchor;
  activeColorPop.remove();
  activeColorPop = null;
  activeColorAnchor = null;
  if (anchor) anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor && anchor.isConnected) anchor.focus();
}

document.addEventListener("pointerdown", (e) => {
  if (activeColorPop && !activeColorPop.contains(e.target) && !e.target.closest("[data-color-trigger]")) {
    closeTagColorPop();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeColorPop) {
    e.preventDefault();
    closeTagColorPop(true);
  }
});
window.addEventListener("scroll", () => closeTagColorPop(), true);

function openTagColorPop(anchorEl, { currentHue, hasCustom, onPick }) {
  closeTagColorPop();
  activeColorAnchor = anchorEl;
  anchorEl.setAttribute("aria-expanded", "true");
  const pop = h("div.tag-color-pop", { role: "dialog", "aria-label": "选择标签颜色" },
    ...TAG_HUES.map((item) =>
      h(item.id === currentHue ? "button.color-swatch.is-selected" : "button.color-swatch", {
        type: "button",
        "data-hue": item.id,
        title: item.label,
        "aria-label": item.label,
        onclick: (e) => {
          e.stopPropagation();
          closeTagColorPop(true);
          onPick(item.id);
        },
      })),
    hasCustom ? h("button.color-reset", {
      type: "button",
      title: "恢复默认自动配色",
      onclick: (e) => {
        e.stopPropagation();
        closeTagColorPop(true);
        onPick("");
      },
    }, "自动") : null,
  );
  document.body.append(pop);
  activeColorPop = pop;
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.left + rect.width / 2 - popRect.width / 2));
  const top = rect.bottom + 6 + popRect.height > window.innerHeight ? rect.top - popRect.height - 6 : rect.bottom + 6;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(8, top))}px`;
  pop.addEventListener("keydown", (e) => {
    const buttons = [...pop.querySelectorAll("button")];
    const current = buttons.indexOf(document.activeElement);
    let next = current;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1 + buttons.length) % buttons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else if (e.key === "Tab") { e.preventDefault(); closeTagColorPop(true); return; }
    else return;
    e.preventDefault();
    buttons[Math.max(0, next)]?.focus();
  });
  (pop.querySelector(".color-swatch.is-selected") || pop.querySelector(".color-swatch"))?.focus();
}

async function setTagColor(tag, hue, restoreFocus = false) {
  try {
    const r = await api("PUT", "/api/tag-colors", { tag, color: hue });
    if (state.settings) state.settings.tag_colors = r.tag_colors || {};
    render();
    if (restoreFocus) {
      const label = `修改标签 ${tag} 的颜色`;
      [...document.querySelectorAll("[data-color-trigger]")].find((el) => el.getAttribute("aria-label") === label)?.focus();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function tagsBar(a) {
  const list = tagsOf(a);
  const customMap = (state.settings && state.settings.tag_colors) || {};
  const items = list.map((tag) => {
    const hue = tagHue(tag);
    const key = tag.trim().toLowerCase();
    const openPicker = (e, anchor) => {
      e.preventDefault();
      e.stopPropagation();
      openTagColorPop(anchor, {
        currentHue: hue,
        hasCustom: Boolean(customMap[key]),
        onPick: (nextHue) => setTagColor(tag, nextHue, true),
      });
    };
    return h(state.tag === tag ? "span.tag-pill.active" : "span.tag-pill", {
      "data-hue": hue,
      oncontextmenu: (e) => openPicker(e, e.currentTarget),
    },
      h("button.tag-dot-btn", {
        type: "button",
        "data-color-trigger": "1", "aria-haspopup": "dialog", "aria-expanded": "false",
        title: `给「${tag}」换颜色`,
        "aria-label": `修改标签 ${tag} 的颜色`,
        onclick: (e) => openPicker(e, e.currentTarget),
      }, h("span.tag-dot")),
      h("button.tag-name", {
        type: "button",
        title: state.tag === tag ? `取消「${tag}」筛选（点左侧圆点或右键可换色）` : `只看「${tag}」标签的账号（点左侧圆点或右键可换色）`,
        onclick: () => { state.tag = state.tag === tag ? "" : tag; render(); },
      }, tag),
      h("button.tag-del", {
        type: "button", "aria-label": `移除标签 ${tag}`, title: `移除「${tag}」`,
        onclick: () => removeAccountTag(a, tag),
      }, icon("x")));
  });

  if (state.addingTagId === a.id) {
    let submitting = false;
    let cancelled = false;
    const editorHue = () => pendingNewTagHue || tagHue(input.value || "新标签");
    const input = h("input.tag-input", {
      type: "text", maxlength: "30", list: "tag-suggestions",
      placeholder: "输入标签回车…", "data-tag-input": String(a.id),
      "aria-label": `给 ${a.email} 添加标签`,
    });
    const dotBtn = h("button.tag-dot-btn", {
      type: "button",
      "data-color-trigger": "1", "aria-haspopup": "dialog", "aria-expanded": "false",
      title: "预设标签颜色",
      "aria-label": "选择新标签颜色",
      onmousedown: (e) => e.preventDefault(), // 保持输入框焦点不丢失
      onclick: (e) => {
        openTagColorPop(e.currentTarget, {
          currentHue: editor.dataset.hue || "blue",
          hasCustom: Boolean(pendingNewTagHue),
          onPick: (picked) => {
            pendingNewTagHue = picked;
            editor.dataset.hue = editorHue();
            input.focus();
          },
        });
      },
    }, h("span.tag-dot"));
    const editor = h("span.tag-editor", { "data-hue": pendingNewTagHue || "blue" }, dotBtn, input);
    input.addEventListener("input", () => {
      editor.dataset.hue = editorHue();
    });

    const commit = async (keepOpen) => {
      if (submitting || cancelled) return;
      const val = input.value.trim();
      if (!val) {
        if (!keepOpen) { pendingNewTagHue = ""; state.addingTagId = 0; closeTagColorPop(); render(); }
        return;
      }
      if (list.some((t) => t.toLowerCase() === val.toLowerCase())) {
        toast(`已有标签「${val}」`);
        if (keepOpen) { input.select(); return; }
        pendingNewTagHue = "";
        state.addingTagId = 0;
        render();
        return;
      }
      submitting = true;
      input.disabled = true;
      const chosenHue = pendingNewTagHue;
      try {
        if (chosenHue) {
          const r = await api("PUT", "/api/tag-colors", { tag: val, color: chosenHue });
          if (state.settings) state.settings.tag_colors = r.tag_colors || {};
        }
        pendingNewTagHue = "";
        await saveAccountTags(a.id, [...list, val], keepOpen);
      } catch (err) {
        submitting = false;
        input.disabled = false;
        toast(err.message, true);
        if (keepOpen) input.focus();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") {
        e.preventDefault();
        cancelled = true;
        pendingNewTagHue = "";
        state.addingTagId = 0;
        closeTagColorPop();
        render();
        document.querySelector(`[data-tag-add="${a.id}"]`)?.focus();
      }
    });
    input.addEventListener("blur", (e) => {
      if (activeColorPop && e.relatedTarget && activeColorPop.contains(e.relatedTarget)) return;
      if (!submitting && !cancelled) commit(false);
    });
    items.push(editor);
  } else {
    items.push(h(list.length ? "button.tag-add-btn.compact" : "button.tag-add-btn", {
      type: "button", "data-tag-add": String(a.id),
      title: "添加标签（输入后回车）", "aria-label": `给 ${a.email} 添加标签`,
      onclick: () => {
        pendingNewTagHue = "";
        state.addingTagId = a.id;
        render();
        document.querySelector(`[data-tag-input="${a.id}"]`)?.focus();
      },
    }, icon("plus"), list.length ? null : h("span", {}, "标签")));
  }
  return h("div.tags", {}, items);
}

async function saveAccountTags(id, nextTags, keepOpen) {
  const updated = await api("PUT", `/api/accounts/${id}/tags`, { tags: nextTags });
  const idx = state.accounts.findIndex((x) => x.id === id);
  if (idx >= 0) state.accounts[idx] = updated;
  state.addingTagId = keepOpen ? id : 0;
  render();
  if (keepOpen) document.querySelector(`[data-tag-input="${id}"]`)?.focus();
}

async function removeAccountTag(a, tag) {
  try {
    await saveAccountTags(a.id, tagsOf(a).filter((t) => t !== tag), false);
  } catch (err) {
    toast(err.message, true);
  }
}

function matches(a) {
  if (state.filter === "unauth" ? a.has_token : state.filter !== "all" && a.status !== state.filter) return false;
  if (state.tag && !tagsOf(a).includes(state.tag)) return false;
  if (!state.query) return true;
  return a.email.includes(state.query) || a.note.toLowerCase().includes(state.query) ||
    tagsOf(a).some((t) => t.toLowerCase().includes(state.query));
}

function hasActiveFilters() {
  return state.filter !== "all" || state.tag !== "" || state.query !== "";
}

function resetFilters() {
  state.filter = "all";
  state.tag = "";
  state.query = "";
  $("#search").value = "";
  for (const item of document.querySelectorAll("#status-segment .seg-item")) {
    item.setAttribute("aria-pressed", String(item.dataset.filter === "all"));
  }
  render();
}

function render() {
  const all = state.accounts;
  const counts = {
    all: all.length,
    due: all.filter((a) => a.status === "due").length,
    risk: all.filter((a) => a.status === "risk").length,
    changed: all.filter((a) => a.status === "changed").length,
    unauth: all.filter((a) => !a.has_token).length,
  };
  for (const [k, n] of Object.entries(counts)) document.querySelector(`[data-count="${k}"]`).textContent = n;
  for (const item of document.querySelectorAll("#status-segment .seg-item")) {
    item.tabIndex = item.getAttribute("aria-pressed") === "true" ? 0 : -1;
  }
  document.querySelector(".seg-due").classList.toggle("has-items", counts.due > 0);
  document.title = counts.due ? `(${counts.due}) 谷歌账号管理` : "谷歌账号管理";

  const tagCounts = new Map();
  for (const a of all) for (const tag of tagsOf(a)) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const tags = [...tagCounts.keys()].sort((x, y) => x.localeCompare(y, "zh-CN"));
  if (state.tag && !tagCounts.has(state.tag)) state.tag = "";
  $("#tag-filter").replaceChildren(
    h("option", { value: "" }, "全部标签"),
    ...tags.map((tag) => h("option", { value: tag, selected: tag === state.tag }, `${tag} (${tagCounts.get(tag)})`)));
  $("#tag-filter").value = state.tag;
  $("#tag-select-wrap").classList.toggle("has-value", state.tag !== "");
  $("#tag-suggestions").replaceChildren(...tags.map((tag) => h("option", { value: tag })));

  $("#search-clear").hidden = !state.query;
  $("#search-kbd").hidden = Boolean(state.query);

  const linked = all.filter((a) => a.chrome_profile).length;
  $("#chrome-banner").hidden = linked === 0;
  $("#chrome-banner-count").textContent = linked;

  // 排序：服务停用 > 待确认新密码 > 该改密 > 风控中（按剩余天数升序） > 已改密
  const list = all.filter(matches).sort((x, y) =>
    Number(y.service_disabled) - Number(x.service_disabled) ||
    Number(y.has_pending_password) - Number(x.has_pending_password) ||
    statusOrder[x.status] - statusOrder[y.status] ||
    x.risk_left - y.risk_left || x.id - y.id);
  $("#rows").replaceChildren(...list.map(row));
  tickTotp();

  const filtering = hasActiveFilters();
  $("#filter-meta").hidden = !filtering;
  if (filtering) $("#filter-summary").textContent = `显示 ${list.length} / ${all.length}`;

  const empty = state.loaded && list.length === 0;
  $("#empty").hidden = !empty;
  $(".table-wrap").hidden = empty;
  $("#empty-text").textContent = all.length ? "没有符合当前筛选条件的账号" : "还没有账号";
  $(".empty-actions").hidden = all.length > 0;
  $("#btn-empty-reset").hidden = all.length === 0 || !filtering;

  syncSegThumb();
}

function avatar(src, email) {
  const letter = h("span.avatar", { "aria-hidden": "true" }, email.charAt(0));
  if (!src) return letter;
  const img = h("img.avatar", { src, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(letter), { once: true });
  return img;
}

async function loadAccounts() {
  const [accounts] = await Promise.all([api("GET", "/api/accounts"), loadClients()]);
  state.accounts = accounts;
  state.loaded = true;
  render();
  await loadTotp();
}

/* ---------- 密码与 2FA ---------- */

const now = () => Date.now() / 1000;

function credCell(a) {
  const rows = [];
  if (a.has_password) {
    const shown = state.revealed.get(a.id);
    rows.push(h("div.cred-row", {},
      h("span.cred-label", {}, "密码"),
      h(shown === undefined ? "span.secret.masked" : "span.secret", { title: shown === undefined ? "" : shown.password }, shown === undefined ? "••••••••" : shown.password),
      button({
        label: shown === undefined ? `显示 ${a.email} 的密码` : `隐藏 ${a.email} 的密码`, iconName: shown === undefined ? "eye" : "eye-slash", iconOnly: true,
        onClick: (e) => toggleReveal(a, e.currentTarget),
      }),
      button({ label: `复制 ${a.email} 的密码`, iconName: "copy", iconOnly: true, onClick: (e) => copyPassword(a, e.currentTarget) })));
    if (shown && shown.previous) {
      rows.push(h("div.cred-row.cred-prev", {},
        h("span.cred-label", {}, "旧"),
        h("span.secret", { title: `上一次改密前的密码：${shown.previous}` }, shown.previous),
        button({ label: `复制 ${a.email} 的旧密码`, iconName: "copy", iconOnly: true, onClick: (e) => copyText(shown.previous, "旧密码已复制", e.currentTarget) })));
    }
  }
  if (a.has_totp) {
    const key = String(a.id);
    const err = state.totp.errors[key];
    rows.push(h("div.cred-row", {},
      h("span.cred-label", {}, "2FA"),
      err ? h("span.cred-error", { title: err }, "无法生成")
        : h("button.totp-code", { type: "button", "data-totp": key, title: "点击复制验证码", onclick: (e) => copyTotp(key, e.currentTarget) }, fmtCode(state.totp.codes[key])),
      err ? null : h("span.totp-timer", { "aria-hidden": "true" }, h("span.totp-ring"), h("span.totp-left"))));
  }
  return h("div.cred", {}, rows);
}

function fmtCode(code) {
  return code ? `${code.slice(0, 3)} ${code.slice(3)}` : "··· ···";
}

function refreshCred(id, focusSel) {
  const a = state.accounts.find((x) => x.id === id);
  const box = document.querySelector(`[data-cred="${id}"]`);
  if (!a || !box) return;
  box.replaceChildren(credCell(a));
  tickTotp();
  if (focusSel) box.querySelector(focusSel)?.focus();
}

async function copyText(text, okMsg, triggerEl) {
  if (await copyToClipboard(text)) {
    flashCopied(triggerEl);
    toast(okMsg);
  } else {
    toast("复制失败：浏览器未允许访问剪贴板", true);
  }
}

function copyTotp(key, triggerEl) {
  const code = state.totp.codes[key];
  if (code) copyText(code, `验证码 ${fmtCode(code)} 已复制`, triggerEl);
}

// 需要解锁的操作：未解锁或已过期时先弹出验证框。
async function withUnlock(fn) {
  if (now() >= state.vault.until && !(await promptUnlock())) return;
  try {
    await fn();
  } catch (e) {
    if (e.status !== 401) throw e;
    setVault(0);
    if (await promptUnlock()) await fn();
  }
}

async function fetchPassword(a) {
  const r = await api("POST", `/api/accounts/${a.id}/reveal-password`);
  return { password: r.password, previous: r.previous_password };
}

function toggleReveal(a, btn) {
  if (state.revealed.has(a.id)) {
    state.revealed.delete(a.id);
    refreshCred(a.id, ".btn-icon");
    return;
  }
  busy(btn, () => withUnlock(async () => {
    state.revealed.set(a.id, await fetchPassword(a));
    refreshCred(a.id, ".btn-icon");
  }));
}

function copyPassword(a, btn) {
  busy(btn, () => withUnlock(async () => {
    const pw = (state.revealed.get(a.id) ?? await fetchPassword(a)).password;
    await copyText(pw, `${a.email} 的密码已复制`, btn);
  }));
}

/* ---------- 改密助手（半自动） ---------- */

let pwcAccount = null;

function kvRow(label, valueEl, ...actions) {
  return h("div.pwc-kv", {}, h("span.pwc-key", {}, label), valueEl, ...actions);
}

function renderChangeDialog(a, r) {
  const key = String(a.id);
  $("#pwc-email").textContent = a.email;
  $("#pwc-error").textContent = "";
  $("#pwc-body").replaceChildren(h("ol.pwc-steps", {},
    h("li", {},
      h("p.pwc-step", {}, "在这个号的浏览器里打开 Google 修改密码页面"),
      button({ label: "打开改密页", iconName: "globe", onClick: (e) => open(a, "password", e.currentTarget) })),
    h("li", {},
      h("p.pwc-step", {}, "Google 要求验证身份时，按需复制"),
      kvRow("当前密码",
        r.current_password ? h("code.pwc-value", {}, r.current_password) : h("span.muted", {}, "没保存，需要你自己输入"),
        r.current_password ? button({ label: "复制当前密码", iconName: "copy", iconOnly: true, onClick: (e) => copyText(r.current_password, "当前密码已复制", e.currentTarget) }) : null),
      kvRow("2FA",
        a.has_totp ? h("button.totp-code", { type: "button", "data-totp": key, title: "点击复制验证码", onclick: (e) => copyTotp(key, e.currentTarget) }, fmtCode(state.totp.codes[key]))
          : h("span.muted", {}, "没保存 2FA 密钥，需要用手机验证器"),
        a.has_totp ? h("span.totp-timer", { "aria-hidden": "true" }, h("span.totp-ring"), h("span.totp-left")) : null)),
    h("li", {},
      h("p.pwc-step", {}, "把新密码粘贴到「新密码」和「确认新密码」两栏，提交"),
      kvRow("新密码",
        h("code.pwc-value.pwc-new", {}, r.new_password),
        button({ label: "复制新密码", iconName: "copy", iconOnly: true, onClick: (e) => copyText(r.new_password, "新密码已复制", e.currentTarget) }),
        button({ label: "换一个新密码", iconName: "arrows-clockwise", iconOnly: true, onClick: (e) => regeneratePassword(a, e.currentTarget) })),
      h("p.field-help", {}, `新密码（${r.new_password.length} 位）已先保存为「待确认」，关掉这个窗口也不会丢；Google 提示改成功后再点「改好了」。`))));
  tickTotp();
}

function openChangeDialog(a, btn) {
  busy(btn, () => withUnlock(async () => {
    const r = await api("POST", `/api/accounts/${a.id}/password-change/start`, {});
    pwcAccount = a;
    renderChangeDialog(a, r);
    showDialog($("#dlg-pwchange"));
  }));
}

function regeneratePassword(a, btn) {
  confirmDialog({
    title: "换一个新密码？",
    message: "如果已经在 Google 提交了当前这个新密码，千万不要换，否则新密码会丢失。",
    okLabel: "换一个", danger: true,
  }).then((ok) => {
    if (!ok) return;
    busy(btn, () => withUnlock(async () => {
      renderChangeDialog(a, await api("POST", `/api/accounts/${a.id}/password-change/start`, { regenerate: true }));
      toast("已换成新的密码");
    }));
  });
}

$("#dlg-pwchange").addEventListener("close", () => {
  pwcAccount = null;
  loadAccounts().catch((e) => toast(e.message, true));
});

$("#pwc-confirm").addEventListener("click", (e) => {
  const a = pwcAccount;
  busy(e.currentTarget, async () => {
    try {
      await api("POST", `/api/accounts/${a.id}/password-change/confirm`);
    } catch (err) {
      $("#pwc-error").textContent = err.message;
      return;
    }
    state.revealed.delete(a.id);
    $("#dlg-pwchange").close();
    toast(`${a.email} 已换成新密码，改密日期记为今天`);
  });
});

$("#pwc-cancel").addEventListener("click", () => {
  const a = pwcAccount;
  confirmDialog({
    title: "放弃这个新密码？",
    message: "只有在 Google 上确实没改成时才放弃。如果其实已经改成功了，放弃后新密码就找不回来了。",
    okLabel: "确实没改成，放弃", danger: true,
  }).then(async (ok) => {
    if (!ok) return;
    try {
      await api("POST", `/api/accounts/${a.id}/password-change/cancel`);
      $("#dlg-pwchange").close();
      toast("已放弃新密码，账号密码保持不变");
    } catch (err) {
      $("#pwc-error").textContent = err.message;
    }
  });
});

function promptUnlock() {
  const dlg = $("#dlg-unlock");
  const f = $("#form-unlock");
  f.reset();
  $("#unlock-error").textContent = "";
  $("#unlock-user").textContent = state.vault.user || "当前用户";
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => { f.password.value = ""; resolve(dlg.returnValue === "ok"); }, { once: true });
    dlg.returnValue = "";
    showDialog(dlg);
    f.password.focus();
  });
}

$("#form-unlock").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "unlock") return;
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[value="unlock"]');
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/vault/unlock", { password: f.password.value });
    setVault(r.unlocked_until);
    $("#dlg-unlock").close("ok");
  } catch (err) {
    $("#unlock-error").textContent = err.message;
    f.password.select();
  } finally {
    btn.disabled = false;
  }
});

let vaultTimer = 0;
function setVault(until) {
  state.vault.until = until;
  clearTimeout(vaultTimer);
  if (until > now()) {
    vaultTimer = setTimeout(() => setVault(0), (until - now()) * 1000);
  } else if (state.revealed.size) {
    const ids = [...state.revealed.keys()];
    state.revealed.clear();
    for (const id of ids) refreshCred(id);
  }
  tickVault();
}

function tickVault() {
  const left = Math.ceil(state.vault.until - now());
  $("#btn-lock").hidden = left <= 0;
  if (left > 0) $("#lock-label").textContent = `已解锁 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

$("#btn-lock").addEventListener("click", () => {
  api("POST", "/api/vault/lock").catch((e) => toast(e.message, true));
  setVault(0);
  toast("已锁定，再查看密码需要重新验证");
});

let totpLoading = false;
async function loadTotp() {
  if (!state.accounts.some((a) => a.has_totp)) {
    state.totp.periodEnd = 0;
    return;
  }
  if (totpLoading) return;
  totpLoading = true;
  try {
    const r = await api("GET", "/api/totp");
    const errorsChanged = JSON.stringify(r.errors) !== JSON.stringify(state.totp.errors);
    state.totp = { codes: r.codes, errors: r.errors, periodEnd: r.period_end, period: r.period };
    if (errorsChanged) render();
    for (const el of document.querySelectorAll("[data-totp]")) el.textContent = fmtCode(state.totp.codes[el.dataset.totp]);
    tickTotp();
  } catch (e) {
    toast(`获取 2FA 验证码失败：${e.message}`, true);
  } finally {
    totpLoading = false;
  }
}

// 每秒更新倒计时；到点后取下一组验证码。
function tickTotp() {
  if (!state.totp.periodEnd) return;
  const left = Math.max(0, Math.ceil(state.totp.periodEnd - now()));
  if (left === 0) {
    loadTotp();
    return;
  }
  for (const t of document.querySelectorAll(".totp-timer")) {
    t.classList.toggle("expiring", left <= 5);
    t.querySelector(".totp-ring").style.setProperty("--p", String(left / state.totp.period));
    t.querySelector(".totp-left").textContent = `${left}s`;
  }
}

setInterval(() => { tickTotp(); tickVault(); }, 1000);

/* ---------- 账号表单 ---------- */

let editing = null;

function openAccountDialog(a) {
  editing = a || null;
  const f = $("#form-account");
  f.reset();
  $("#dlg-account-title").textContent = a ? `编辑 ${a.email}` : "添加账号";
  clearFormError(f, $("#account-error"));
  f.email.value = a ? a.email : "";
  f.note.value = a ? a.note : "";
  f.login_date.value = a ? a.login_date : todayStr();
  f.login_date.max = todayStr();
  f.risk_days.value = a ? a.risk_days : (state.settings ? state.settings.default_risk_days : 7);
  f.pwd_changed_date.value = a ? a.pwd_changed_date : "";
  f.proxy.value = a ? a.proxy : "";
  f.profile_dir.value = a ? a.profile_dir : "";
  f.profile_dir.placeholder = a && !a.profile_dir ? `留空 = ${a.profile_path}` : "留空 = 数据目录\\profiles\\<邮箱>";
  f.chrome_profile.value = a ? a.chrome_profile : "";
  f.refresh_token.value = "";
  f.password.value = "";
  f.password.placeholder = a && a.has_password ? "已保存，留空 = 不修改" : "可选";
  f.totp_secret.value = "";
  f.totp_secret.placeholder = a && a.has_totp ? "已保存，留空 = 不修改" : "可选，如 JBSW Y3DP EHPK 3PXP";
  $("#clear-password-wrap").hidden = !(a && a.has_password);
  $("#clear-totp-wrap").hidden = !(a && a.has_totp);
  // 渐进披露：已有自定义代理或浏览器目录时自动展开，否则保持精简。
  $("#account-advanced").open = Boolean(a && (a.proxy || a.profile_dir || a.chrome_profile));
  showDialog($("#dlg-account"));
}

$("#form-account").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();
  const f = e.target;
  const body = {
    email: f.email.value,
    note: f.note.value,
    login_date: f.login_date.value,
    risk_days: Number(f.risk_days.value),
    pwd_changed_date: f.pwd_changed_date.value,
    proxy: f.proxy.value,
    profile_dir: f.profile_dir.value,
    chrome_profile: f.chrome_profile.value,
    refresh_token: f.refresh_token.value,
    password: f.password.value,
    totp_secret: f.totp_secret.value,
    clear_password: f.clear_password.checked,
    clear_totp: f.clear_totp.checked,
  };
  try {
    if (editing) await api("PUT", `/api/accounts/${editing.id}`, body);
    else await api("POST", "/api/accounts", body);
    $("#dlg-account").close();
    if (editing) state.revealed.delete(editing.id);
    await loadAccounts();
    toast(editing ? "已保存" : `已添加 ${body.email.trim().toLowerCase()}`);
  } catch (err) {
    setFormError(f, $("#account-error"), err.message);
  }
});

/* ---------- 设置 ---------- */

async function loadSettings() {
  const r = await api("GET", "/api/settings");
  state.settings = r.settings;
  state.dataDir = r.data_dir;
  state.defaultUserData = r.default_chrome_user_data;
}

function openSettingsDialog() {
  const f = $("#form-settings");
  const s = state.settings;
  f.default_proxy.value = s.default_proxy;
  f.chrome_path.value = s.chrome_path;
  f.chrome_user_data.value = s.chrome_user_data;
  f.chrome_user_data.placeholder = `留空 = ${state.defaultUserData}`;
  f.default_risk_days.value = s.default_risk_days;
  f.ide_path.value = s.ide_path || "";
  f.classic_path.value = s.classic_path || "";
  f.next_pool.value = s.next_pool || "any";
  f.next_threshold.value = s.next_threshold ?? 10;
  renderFingerprintRestore();
  $("#data-dir").textContent = `数据目录：${state.dataDir}`;
  clearFormError(f, $("#settings-error"));
  showDialog($("#dlg-settings"));
}

// 切过号的桌面客户端可以把设备指纹恢复成本机原始值（登录的账号不变）。
function renderFingerprintRestore() {
  const backed = state.clients.filter((c) => c.has_backup);
  $("#fingerprint-restore").hidden = backed.length === 0;
  $("#fingerprint-buttons").replaceChildren(...backed.map((c) => {
    const meta = CLIENTS[c.target];
    return button({
      label: meta.label, iconName: meta.icon, variant: ".btn-ghost",
      title: `把 ${meta.name} 的设备指纹恢复成第一次切号前的本机原始值${c.running ? "（会重启它）" : ""}`,
      onClick: (e) => {
        const btn = e.currentTarget;
        confirmDialog({
          title: `恢复 ${meta.name} 的原始设备指纹？`,
          message: `${c.running ? `会先关闭正在运行的 ${meta.name}，恢复后重新打开。\n` : ""}登录的账号不变；下次切号时会再次换成那个号自己的指纹。`,
          okLabel: "恢复",
        }).then((ok) => {
          if (ok) busy(btn, async () => {
            launched(await api("POST", `/api/clients/${c.target}/restore-fingerprint`), `${meta.name} 已恢复本机原始设备指纹`);
          });
        });
      },
    });
  }));
}

$("#form-settings").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();
  const f = e.target;
  try {
    state.settings = await api("PUT", "/api/settings", {
      default_proxy: f.default_proxy.value,
      chrome_path: f.chrome_path.value,
      chrome_user_data: f.chrome_user_data.value,
      default_risk_days: Number(f.default_risk_days.value),
      ide_path: f.ide_path.value,
      classic_path: f.classic_path.value,
      next_pool: f.next_pool.value,
      next_threshold: Number(f.next_threshold.value),
    });
    $("#dlg-settings").close();
    toast("设置已保存");
  } catch (err) {
    setFormError(f, $("#settings-error"), err.message);
  }
});

/* ---------- 从 Chrome 导入 ---------- */

async function openImportDialog(btn) {
  await busy(btn, async () => {
    const r = await api("GET", "/api/chrome-profiles");
    $("#import-source").textContent = r.user_data;
    $("#import-error").textContent = "";
    const list = $("#import-list");
    list.replaceChildren(...r.profiles.map((p) => {
      const disabled = !p.email || p.account_id > 0;
      const status = !p.email ? "未登录 Google"
        : p.account_id ? "已在列表中"
        : `资料创建于 ${p.created || "未知"}`;
      const box = h("input", { type: "checkbox", name: "dir", value: p.dir, disabled });
      return h(disabled ? "li.disabled" : "li", {},
        h("label.import-item", {},
          box,
          avatar(p.has_avatar ? `/api/chrome-profiles/${encodeURIComponent(p.dir)}/avatar` : "", p.email || p.name || "?"),
          h("span.import-main", {},
            h("span.import-name", {}, p.name || p.dir),
            h("span.import-email", {}, p.email || "—")),
          h("span.import-meta", {}, h("span.chip", {}, p.dir), h("span.import-status", {}, status))));
    }));
    $("#import-all").checked = false;
    updateImportCount();
    showDialog($("#dlg-import"));
  });
}

function importBoxes() {
  return [...document.querySelectorAll('#import-list input[name="dir"]:not(:disabled)')];
}

function updateImportCount() {
  const n = importBoxes().filter((b) => b.checked).length;
  $("#import-count").textContent = n ? `已选 ${n} 个` : "";
  $("#import-submit").disabled = n === 0;
}

$("#import-list").addEventListener("change", updateImportCount);
$("#import-all").addEventListener("change", (e) => {
  for (const b of importBoxes()) b.checked = e.target.checked;
  updateImportCount();
});

$("#form-import").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "import") return;
  e.preventDefault();
  const dirs = importBoxes().filter((b) => b.checked).map((b) => b.value);
  try {
    const r = await api("POST", "/api/chrome-profiles/import", { dirs });
    $("#dlg-import").close();
    await loadAccounts();
    const parts = [];
    if (r.added) parts.push(`新增 ${r.added} 个账号`);
    if (r.existed) parts.push(`${r.existed} 个已在列表中，已跳过`);
    toast(parts.length ? `导入完成：${parts.join("，")}` : "没有导入任何账号");
  } catch (err) {
    $("#import-error").textContent = err.message;
  }
});

$("#btn-detach").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const n = state.accounts.filter((a) => a.chrome_profile).length;
  confirmDialog({
    title: `把 ${n} 个账号改用自带浏览器？`,
    message: "改完后点「浏览器」「邮箱」会打开程序自带的独立浏览器，每个号第一次打开要重新登录一次（密码和 2FA 可在列表里复制）。\n头像会先保存下来。之后就可以删掉日常 Chrome 里的这些个人资料。",
    okLabel: "全部改用自带浏览器",
  }).then((ok) => {
    if (ok) busy(btn, async () => {
      const r = await api("POST", "/api/accounts/detach-chrome");
      await loadAccounts();
      toast(`已把 ${r.converted} 个账号改为用自带浏览器打开`);
    });
  });
});

/* ---------- 启动与快捷键 ---------- */

$("#btn-add").addEventListener("click", () => openAccountDialog(null));
$("#btn-empty-add").addEventListener("click", () => openAccountDialog(null));
$("#btn-import").addEventListener("click", (e) => openImportDialog(e.currentTarget));
$("#btn-empty-import").addEventListener("click", (e) => openImportDialog(e.currentTarget));
$("#btn-settings").addEventListener("click", openSettingsDialog);
$("#btn-clear-filters").addEventListener("click", resetFilters);
$("#btn-empty-reset").addEventListener("click", resetFilters);

$("#btn-refresh").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const label = btn.querySelector("span");
  const tray = $("#workspace-tray");
  label.textContent = "刷新中…";
  tray.classList.add("is-refreshing");
  busy(btn, async () => {
    state.accounts = await api("POST", "/api/quota/refresh");
    render();
    const failed = state.accounts.filter((a) => a.has_token && a.quota_error).length;
    if (failed) toast(`刷新完成，${failed} 个账号失败，原因见额度列`, true);
    else toast("额度已刷新");
  }).finally(() => {
    label.textContent = "刷新额度";
    tray.classList.remove("is-refreshing");
  });
});

for (const item of document.querySelectorAll("#status-segment .seg-item")) {
  item.addEventListener("click", () => {
    state.filter = item.dataset.filter;
    for (const el of document.querySelectorAll("#status-segment .seg-item")) {
      el.setAttribute("aria-pressed", String(el === item));
    }
    render();
  });
}

$("#status-segment").addEventListener("keydown", (e) => {
  const items = [...e.currentTarget.querySelectorAll(".seg-item")];
  const current = items.indexOf(document.activeElement);
  if (current < 0) return;
  let next = current;
  if (e.key === "ArrowRight") next = (current + 1) % items.length;
  else if (e.key === "ArrowLeft") next = (current - 1 + items.length) % items.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  else return;
  e.preventDefault();
  items[next].focus();
  items[next].click();
});

$("#tag-filter").addEventListener("change", (e) => {
  state.tag = e.target.value;
  render();
});

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value.trim().toLowerCase();
  render();
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.query) {
      state.query = "";
      e.target.value = "";
      render();
    }
    e.target.blur();
  }
});
$("#search-clear").addEventListener("click", () => {
  state.query = "";
  $("#search").value = "";
  render();
  $("#search").focus();
});

// BoardUI 键盘优先：按 / 聚焦搜索框（不在输入态且没有打开弹窗时）
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  e.preventDefault();
  $("#search").focus();
  $("#search").select();
});

// 从 Chrome 授权完切回窗口时，自动拉取最新状态。
window.addEventListener("focus", () => {
  if (state.addingTagId) return;
  loadAccounts().catch((e) => toast(e.message, true));
});

(async () => {
  try {
    const [, , vault] = await Promise.all([loadSettings(), loadAccounts(), api("GET", "/api/vault")]);
    state.vault.user = vault.user;
    setVault(vault.unlocked_until);
  } catch (e) {
    toast(e.message, true);
  }
})();
