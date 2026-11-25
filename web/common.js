"use strict";

// 主控制台（app.js）和托盘小窗（mini.js）共用的小工具。

const $ = (sel) => document.querySelector(sel);

async function api(method, path, body) {
  const headers = { "X-Requested-With": "gam" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.trim() }; }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- DOM 小工具 ---------- */

// 优先使用系统剪贴板；WebView 拒绝异步 Clipboard API 时，退到用户手势触发的页面复制。
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const area = h("textarea.clipboard-fallback", { readonly: "", "aria-hidden": "true" });
  area.value = text;
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch {}
  area.remove();
  return copied;
}

// h("tag.class", {attr}, ...children)：用 DOM API 建元素，避免拼接 HTML。
function h(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

/* ---------- 时间 ---------- */

function toDate(s) {
  const d = typeof s === "number" ? new Date(s * 1000) : new Date(s);
  return isNaN(d) ? null : d;
}

function fmtTime(s) {
  const d = toDate(s);
  return d ? d.toLocaleString("zh-CN", { hour12: false }) : "";
}

function fromNow(s) {
  const d = toDate(s);
  if (!d) return "";
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const unit = abs < 60 ? null : abs < 3600 ? [Math.round(abs / 60), "分钟"] : abs < 86400 ? [Math.round(abs / 3600), "小时"] : [Math.round(abs / 86400), "天"];
  if (!unit) return "刚刚";
  return diff < 0 ? `${unit[0]} ${unit[1]}前` : `${unit[0]} ${unit[1]}后`;
}

// 额度重置倒计时：超过一天显示「6d 14h」，否则「0h 55m」。
function fmtCountdown(s) {
  const d = toDate(s);
  if (!d) return "";
  const left = Math.floor((d.getTime() - Date.now()) / 60000);
  if (left <= 0) return "待重置";
  const days = Math.floor(left / 1440);
  const hours = Math.floor((left % 1440) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${left % 60}m`;
}

// 带 data-reset 的元素每半分钟刷新一次倒计时文字。
setInterval(() => {
  for (const el of document.querySelectorAll("[data-reset]")) el.textContent = fmtCountdown(el.dataset.reset);
}, 30000);

/* ---------- 额度 ---------- */

const windowLabel = { weekly: "周", "5h": "5h" };

// 缩短冗长的上游模型组名，避免在紧凑列中截断；完整原名保留在悬停提示中。
function shortGroupName(name) {
  const n = (name || "").trim();
  if (/^gemini\s+models$/i.test(n)) return "Gemini";
  if (/^claude\s+and\s+gpt\s+models$/i.test(n)) return "Claude / GPT";
  return n.replace(/\s+models$/i, "") || "默认";
}

function quotaLevel(pct) {
  return pct <= 0 ? "zero" : pct < 20 ? "low" : "";
}

/* ---------- Antigravity 客户端 ---------- */

const CLIENTS = {
  agy: { label: "CLI", name: "Antigravity CLI", icon: "terminal-window" },
  ide: { label: "IDE", name: "Antigravity IDE", icon: "code" },
  classic: { label: "经典款", name: "Antigravity 经典款", icon: "app-window" },
};
