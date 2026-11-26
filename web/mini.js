"use strict";

// 托盘小窗：看 CLI / IDE / 经典款当前登录的号和它的额度，就地切号。

const QUOTA_REFRESH_MS = 5 * 60 * 1000; // 小窗开着时，当前账号的额度最多 5 分钟查一次

const mini = {
  tab: localStorage.getItem("gam-mini-tab") || "agy",
  accounts: [], clients: [], prefs: { lightweight: false, mini_pinned: false },
  shown: true, quotaAt: 0, picking: false, confirming: null, busy: false,
};

function post(cmd) {
  if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(cmd);
}

let statusTimer = 0;
function status(msg, isError) {
  const el = $("#mini-status");
  el.textContent = msg;
  el.classList.toggle("error", Boolean(isError));
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { el.textContent = ""; }, isError ? 8000 : 4000);
}

async function load() {
  const [accounts, clients] = await Promise.all([api("GET", "/api/accounts"), api("GET", "/api/clients")]);
  mini.accounts = accounts;
  mini.clients = clients;
  render();
}

// 只刷新三端当前登录的号（不在列表里的号查不了）。
async function refreshActiveQuota(force) {
  const ids = [...new Set(mini.clients.map((c) => c.account_id).filter(Boolean))];
  if (!ids.length || (!force && Date.now() - mini.quotaAt < QUOTA_REFRESH_MS)) return;
  mini.quotaAt = Date.now();
  mini.accounts = await api("POST", `/api/quota/refresh?ids=${ids.join(",")}`);
  render();
}

function currentClient() {
  return mini.clients.find((c) => c.target === mini.tab);
}

function accountById(id) {
  return mini.accounts.find((a) => a.id === id);
}

function minPct(a) {
  const fractions = ((a.quota && a.quota.groups) || []).flatMap((g) => (g.buckets || []).map((b) => b.remaining_fraction));
  return fractions.length ? Math.round(Math.min(...fractions) * 100) : null;
}

/* ---------- 渲染 ---------- */

function render() {
  renderTabs();
  renderMain();
  $("#mini-main").setAttribute("aria-labelledby", `mini-tab-${mini.tab}`);
  const pinned = mini.prefs.mini_pinned;
  const pin = $("#mini-pin");
  pin.setAttribute("aria-pressed", String(pinned));
  pin.title = pinned ? "已固定：置顶且不自动收起，点击取消" : "固定：置顶且不自动收起";
  pin.setAttribute("aria-label", pin.title);
  $("#mini-light").checked = mini.prefs.lightweight;
}

function activateTab(target, focus = false) {
  if (!mini.clients.some((c) => c.target === target)) return;
  mini.tab = target;
  mini.picking = false;
  mini.confirming = null;
  try { localStorage.setItem("gam-mini-tab", target); } catch {}
  render();
  if (focus) $(`#mini-tab-${target}`)?.focus();
}

function renderTabs() {
  $("#mini-tabs").replaceChildren(...mini.clients.map((c) => {
    const meta = CLIENTS[c.target];
    const selected = c.target === mini.tab;
    return h(selected ? "button.mini-tab.active" : "button.mini-tab", {
      type: "button", role: "tab", id: `mini-tab-${c.target}`,
      "aria-selected": String(selected), "aria-controls": "mini-main", tabindex: selected ? "0" : "-1",
      title: !c.installed ? `没找到 ${meta.name}` : c.running ? `${meta.name} 正在运行` : `${meta.name} 没有运行`,
      onclick: () => activateTab(c.target, true),
      onkeydown: (e) => {
        const current = mini.clients.findIndex((item) => item.target === c.target);
        let next = current;
        if (e.key === "ArrowLeft") next = (current - 1 + mini.clients.length) % mini.clients.length;
        else if (e.key === "ArrowRight") next = (current + 1) % mini.clients.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = mini.clients.length - 1;
        else return;
        e.preventDefault();
        activateTab(mini.clients[next].target, true);
      },
    }, icon(meta.icon), h("span", {}, meta.label), h(c.running ? "span.mini-dot.on" : "span.mini-dot", { "aria-hidden": "true" }));
  }));
}

function renderMain() {
  const c = currentClient();
  const main = $("#mini-main");
  if (!c) {
    main.replaceChildren(h("p.mini-empty", {}, "读取中…"));
    return;
  }
  const meta = CLIENTS[c.target];
  if (!c.installed) {
    main.replaceChildren(h("div.mini-empty", {},
      icon(meta.icon), h("p", {}, `没找到 ${meta.name}`),
      h("p.muted", {}, c.target === "agy" ? "安装 agy 后再来" : "装在不常见位置的话，在主控制台的设置里填程序路径")));
    return;
  }
  const acc = accountById(c.account_id);
  main.replaceChildren(accountCard(c, acc), quotaList(c, acc));
}

function accountCard(c, acc) {
  const email = acc ? acc.email : c.email;
  const tier = acc && acc.quota && acc.quota.tier;
  const candidates = mini.accounts.filter((a) => a.has_token && a.id !== c.account_id);
  const canPick = candidates.length > 0;
  const canNext = candidates.some((a) => a.status !== "risk");
  const head = h("div.mini-acct", {},
    icon("envelope-simple"),
    h("span.mini-email", { title: email || "" }, email || "未登录"),
    tier ? h("span.badge.badge-tier", {}, tier) : null,
    ...(acc ? acc.tags.slice(0, 2).map((t) => h("span.mini-tag", { title: t }, icon("tag"), t)) : []));
  const picker = h("button.mini-picker", {
    type: "button", "aria-expanded": String(mini.picking), "aria-controls": "mini-account-list",
    disabled: mini.busy || !canPick,
    title: canPick ? "选择另一个已授权账号" : "没有其它已授权账号",
    onclick: () => {
      mini.picking = !mini.picking;
      mini.confirming = null;
      render();
      (mini.picking ? $(".mini-option") : $(".mini-picker"))?.focus();
    },
  }, icon("shuffle"), h("span", {}, "切换账号"), icon("caret-down"));
  const next = h("button.btn.btn-sm.btn-soft-accent.mini-next", {
    type: "button", disabled: mini.busy || !canNext,
    title: canNext ? "按设置里的规则挑下一个可用的号（跳过风控期内的号）" : "没有不在风控期的其它已授权账号",
    onclick: () => confirmThen(c, "切到下一个可用的号", () => api("POST", `/api/clients/${c.target}/next`)),
  }, icon("skip-forward"), h("span", {}, "切下个"));
  return h("section.mini-card", {},
    head,
    h("div.mini-actions", {}, picker, next),
    miniServiceNotice(acc),
    mini.picking ? pickerList(c) : null,
    mini.confirming ? confirmBar() : null);
}

async function miniServiceAction(acc, action) {
  if (mini.busy) return;
  mini.busy = true;
  render();
  status(action === "appeal" ? "正在打开官方申诉页…" : "正在检测 Antigravity 服务…");
  try {
    if (action === "appeal") {
      const r = await api("POST", `/api/accounts/${acc.id}/appeal`);
      await load();
      const message = `已在 ${acc.email} 的浏览器中打开官方申诉页`;
      status(r.warning ? `${message}。${r.warning}` : message, Boolean(r.warning));
    } else {
      const r = await api("POST", `/api/accounts/${acc.id}/service-check`);
      mini.accounts = r.accounts;
      status(r.message, r.status === "disabled");
    }
  } catch (e) {
    status(e.message, true);
    await load().catch((err) => status(err.message, true));
  } finally {
    mini.busy = false;
    render();
  }
}

function miniServiceNotice(acc) {
  if (!acc || !acc.service_disabled) return null;
  const appealed = acc.appeal_at > 0;
  return h("div.mini-service", { role: "note" },
    h("strong", {}, appealed ? "Antigravity 申诉审核中" : "Antigravity 已停用"),
    h("p", {}, "该账号的对话服务已被 Google 限制。"),
    acc.service_error_id ? h("button.mini-service-error", {
      type: "button", title: "复制 Error ID",
      onclick: async () => {
        if (await copyToClipboard(acc.service_error_id)) status("Error ID 已复制");
        else status("复制失败：浏览器未允许访问剪贴板", true);
      },
    }, `Error ID: ${acc.service_error_id}`) : null,
    h("div.mini-service-actions", {},
      h("button.btn.btn-sm.btn-soft-danger", {
        type: "button", disabled: mini.busy,
        onclick: () => miniServiceAction(acc, "appeal"),
      }, appealed ? "再次打开申诉" : "去申诉"),
      h("button.btn.btn-sm.btn-ghost", {
        type: "button", disabled: mini.busy,
        onclick: () => miniServiceAction(acc, "check"),
      }, "重新检测")));
}

function pickerList(c) {
  const list = mini.accounts.filter((a) => a.has_token && a.id !== c.account_id);
  if (!list.length) return h("p.mini-hint", {}, "没有其它已授权的号");
  return h("div.mini-list", {
    id: "mini-account-list", role: "listbox", "aria-label": "可切换账号",
    onkeydown: (e) => {
      const options = [...e.currentTarget.querySelectorAll(".mini-option")];
      const current = options.indexOf(document.activeElement);
      let next = current;
      if (e.key === "ArrowDown") next = (current + 1 + options.length) % options.length;
      else if (e.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = options.length - 1;
      else return;
      e.preventDefault();
      const target = Math.max(0, next);
      options.forEach((option, index) => { option.tabIndex = index === target ? 0 : -1; });
      options[target]?.focus();
    },
  }, list.map((a, index) => {
    const pct = minPct(a);
    return h("button.mini-option", {
      type: "button", role: "option", "aria-selected": "false", tabindex: index === 0 ? "0" : "-1",
      onclick: () => {
        mini.picking = false;
        confirmThen(c, `切换为 ${a.email}`, () => api("POST", `/api/accounts/${a.id}/switch?target=${c.target}`), ".mini-picker");
      },
    },
    h("span.mini-option-email", { title: a.email }, a.email),
    a.status === "risk" ? h("span.mini-flag", { title: `还在风控期，剩 ${a.risk_left} 天` }, "风控中") : null,
    a.quota && a.quota.tier ? h("span.badge.badge-tier", {}, a.quota.tier) : null,
    h(`span.mini-option-pct${pct === null ? "" : "." + (quotaLevel(pct) || "ok")}`, { title: "各额度窗口里最少的剩余比例" }, pct === null ? "—" : `${pct}%`));
  }));
}

// 桌面客户端正在运行时，切号会关闭并重启它：先在小窗里确认一次（不用系统弹窗，免得小窗失焦收起）。
function confirmThen(c, label, run, returnFocus = ".mini-next") {
  if (c.target !== "agy" && c.running) {
    mini.confirming = { text: `${label}：会关闭并重启 ${CLIENTS[c.target].name}，没保存的内容可能丢失`, run, returnFocus };
    render();
    $(".mini-confirm-actions .btn-primary")?.focus();
    return;
  }
  doSwitch(run);
}

function confirmBar() {
  const { text, run, returnFocus } = mini.confirming;
  return h("div.mini-confirm", { role: "alert" },
    h("p", {}, text),
    h("div.mini-confirm-actions", {},
      h("button.btn.btn-sm.btn-ghost", { type: "button", onclick: () => {
        mini.confirming = null;
        render();
        $(returnFocus)?.focus();
      } }, "取消"),
      h("button.btn.btn-sm.btn-primary", { type: "button", onclick: () => { mini.confirming = null; doSwitch(run); } }, "确认切换")));
}

async function doSwitch(run) {
  mini.busy = true;
  render();
  status("正在切换…");
  try {
    const r = await run();
    status(r.warning ? `已切换为 ${r.email}。${r.warning}` : `已切换为 ${r.email}`, Boolean(r.warning));
    mini.quotaAt = 0;
  } catch (e) {
    status(e.message, true);
  } finally {
    mini.busy = false;
    await load().catch((e) => status(e.message, true));
    refreshActiveQuota(false).catch(() => {});
  }
}

function quotaList(c, acc) {
  if (!acc) {
    return h("p.mini-hint", {}, c.email ? "这个号不在列表里，看不到额度" : "还没有登录");
  }
  if (acc.service_disabled && acc.appeal_at > 0) return null;
  const rows = [];
  for (const g of (acc.quota && acc.quota.groups) || []) {
    for (const b of g.buckets || []) rows.push(quotaRow(g.display_name, b));
  }
  const foot = acc.quota_at ? h("p.mini-hint", { title: fmtTime(acc.quota_at) }, `${acc.quota_error ? "上次尝试" : "额度更新于"} ${fromNow(acc.quota_at)}`) : null;
  return h("section.mini-quota", {},
    rows.length ? rows : h("p.mini-hint", {}, acc.quota_error ? "" : "还没查过额度，点右上角刷新"),
    acc.quota_error ? h("p.mini-error", {}, acc.quota_error) : null,
    foot);
}

function quotaRow(groupName, b) {
  const pct = Math.max(0, Math.min(100, Math.round(b.remaining_fraction * 100)));
  const level = quotaLevel(pct);
  const name = shortGroupName(groupName);
  const win = b.window === "5h" ? "5H" : b.window === "weekly" ? "周配额" : b.window;
  const fill = h("i");
  fill.style.width = `${pct}%`;
  return h(level ? `div.mini-q.${level}` : "div.mini-q", { title: b.reset_time ? `${fmtTime(b.reset_time)} 重置` : "" },
    h("div.mini-q-top", {},
      h(/claude|gpt/i.test(groupName) ? "span.mini-q-mark.claude" : "span.mini-q-mark", { "aria-hidden": "true" }),
      h("span.mini-q-name", {}, `${name} `, h("small", {}, win)),
      b.reset_time ? h("span.mini-q-reset", {}, icon("clock"), h("span", { "data-reset": b.reset_time }, fmtCountdown(b.reset_time))) : null,
      h("span.mini-q-pct", {}, `${pct}%`)),
    h("div.mini-q-bar", { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": `${name} ${win} 剩余额度` }, fill));
}

/* ---------- 顶栏与底栏 ---------- */

async function savePrefs(next) {
  try {
    mini.prefs = await api("PUT", "/api/ui-prefs", next);
  } catch (e) {
    status(e.message, true);
  }
  render();
}

$("#mini-pin").addEventListener("click", () => savePrefs({ ...mini.prefs, mini_pinned: !mini.prefs.mini_pinned }));
$("#mini-light").addEventListener("change", (e) => savePrefs({ ...mini.prefs, lightweight: e.target.checked }));
$("#mini-close").addEventListener("click", () => post("mini:hide"));
$("#mini-open").addEventListener("click", () => post("main:show"));
$("#mini-quit").addEventListener("click", () => post("app:quit"));
$("#mini-refresh").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add("is-busy");
  refreshActiveQuota(true)
    .then(() => load())
    .catch((err) => status(err.message, true))
    .finally(() => { btn.disabled = false; btn.classList.remove("is-busy"); });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (mini.picking || mini.confirming) {
    const returnFocus = mini.confirming ? mini.confirming.returnFocus : ".mini-picker";
    mini.picking = false;
    mini.confirming = null;
    render();
    $(returnFocus)?.focus();
  } else {
    post("mini:hide");
  }
});

// 由界面线程在小窗显示 / 收起时调用。
window.gamMini = {
  onShow() {
    mini.shown = true;
    load().then(() => refreshActiveQuota(false)).catch((e) => status(e.message, true));
  },
  onHide() {
    mini.shown = false;
    mini.picking = false;
    mini.confirming = null;
  },
};

setInterval(() => {
  if (mini.shown && !mini.busy) load().then(() => refreshActiveQuota(false)).catch(() => {});
}, 60000);

(async () => {
  try {
    mini.prefs = await api("GET", "/api/ui-prefs");
    await load();
    await refreshActiveQuota(false);
  } catch (e) {
    status(e.message, true);
  }
})();
