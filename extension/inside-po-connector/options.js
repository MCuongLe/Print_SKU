"use strict";

// Trang Options của Extension: đăng nhập Admin, tên máy, công tắc, trạng thái, lượt gần nhất, nhật ký.
// Mọi việc đi qua service worker bằng chrome.runtime.sendMessage; trang này không giữ token.
const $ = id => document.getElementById(id);
const ICONS = {
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pause: '<circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  ok: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
  skipped: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'
};
const ico = (name, cls = "") => `<svg class="ico sm${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = n => String(n).padStart(2, "0");
const toDate = value => { const d = value === null || value === undefined || value === "" ? null : new Date(value); return d && Number.isFinite(d.getTime()) ? d : null; };
const hhmm = value => { const d = toDate(value); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "—"; };
const hhmmDate = value => { const d = toDate(value); return d ? `${hhmm(d)} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : "—"; };
const KIND = { sku: "SKU", group_uid: "Group UID", cut_adj: "Đối chiếu ADJ", storage_risk: "Rủi ro lưu trữ" };
// Loại chỉ có một kiểu đọc (gia tăng theo mốc / bản chụp mới): nút Chạy ngay chạy thẳng, không có menu.
const ONE_MODE = new Set(["cut_adj", "storage_risk"]);
const MODE = { incremental: "Gia tăng", full: "Toàn bộ" };
const STATUS = { ok: ["Đã áp dụng", "ok"], held: ["Chờ Admin", "pause"], skipped: ["Bỏ qua", "skipped"], error: ["Lỗi", "error"] };
const TONE = { ok: "ok", held: "held", skipped: "skipped", error: "error" };
const chip = status => { const [label, icon] = STATUS[status] || [status || "—", "skipped"]; return `<span class="chip" data-tone="${esc(TONE[status] || "")}">${ico(icon)}${esc(label)}</span>`; };

let state = null;
let pending = 0;
let openMenu = null;

async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    $("fatal").hidden = response !== undefined && response !== null;
    return response ?? null;
  } catch (_) {
    $("fatal").hidden = false;
    return null;
  }
}

function hydrate() {
  document.querySelectorAll("[data-ico]").forEach(el => { el.innerHTML = ICONS[el.dataset.ico] || ""; });
}

function renderSession(s) {
  $("signin").hidden = Boolean(s.signedIn);
  $("signed").hidden = !s.signedIn;
  $("who-email").textContent = s.email || "";
}

function renderDevice(s) {
  const device = $("device");
  if (document.activeElement !== device) device.value = s.device || "";
  const named = Boolean(String(s.device || "").trim());
  const toggle = $("enabled");
  toggle.disabled = !named;
  toggle.checked = named && s.enabled !== false;
  $("enabled-sub").hidden = named;
}

function renderStatus(s) {
  const tabs = s.tabs || {};
  for (const [key, id] of [["wms", "wms"], ["inside", "inside"]]) {
    $("dot-" + id).dataset.on = String(Boolean(tabs[key]));
    $("txt-" + id).textContent = tabs[key] ? "Đang mở" : "Không có tab";
  }
  $("next-text").textContent = `Lượt kế: ${hhmm(s.nextAlarmAt)}`;
  $("paused").hidden = s.config?.enabled !== false;
}

function renderProblems(s) {
  const problems = Array.isArray(s.problems) ? s.problems : [];
  $("problems").hidden = !problems.length;
  $("problems-list").innerHTML = problems.map(item => `<li>${esc(item)}</li>`).join("");
}

function renderLast(s) {
  const last = s.last || {};
  const running = s.running?.kind || null;
  const kinds = Array.isArray(s.kinds) && s.kinds.length ? s.kinds : ["sku", "group_uid"];
  $("last").innerHTML = kinds.map(kind => {
    const item = last[kind];
    const spinning = running === kind;
    const button = ONE_MODE.has(kind)
      ? `<button type="button" data-run="${kind}" data-mode="incremental"${running ? " disabled" : ""}>${spinning ? ico("loader", "spin") : ico("play")}Chạy ngay</button>`
      : `<button type="button" data-run-toggle="${kind}" aria-haspopup="menu" aria-expanded="false"${running ? " disabled" : ""}>${spinning ? ico("loader", "spin") : ico("play")}Chạy ngay${ico("down")}</button>
        <div class="menu" role="menu" data-menu="${kind}" hidden><button type="button" role="menuitem" data-run="${kind}" data-mode="incremental">Gia tăng</button><button type="button" role="menuitem" data-run="${kind}" data-mode="full">Toàn bộ</button></div>`;
    return `<div class="last-row" data-kind="${kind}">
      <div class="head"><span>${esc(KIND[kind] || kind)}</span>${item ? `<span class="sub">${esc(hhmmDate(item.at))}</span>${chip(item.status)}` : '<span class="sub">Chưa có lượt</span>'}</div>
      <div class="runwrap">${button}</div>
      ${item?.message ? `<div class="msg">${esc(item.message)}</div>` : ""}
    </div>`;
  }).join("");
  openMenu = null;
}

function renderLog(s) {
  const log = (s.log || []).slice(0, 50);
  $("log").innerHTML = log.length
    ? log.map(entry => `<tr><td class="time">${esc(hhmmDate(entry.at))}</td><td>${esc(KIND[entry.kind] || entry.kind || "—")}</td><td>${esc(MODE[entry.mode] || entry.mode || "—")}</td><td>${chip(entry.status)}</td><td class="msgc">${esc(entry.message || "")}</td></tr>`).join("")
    : '<tr><td colspan="5" class="empty">Chưa có nhật ký</td></tr>';
}

function render(s) {
  state = s;
  renderProblems(s);
  renderSession(s);
  renderDevice(s);
  renderStatus(s);
  if (!openMenu) renderLast(s);
  renderLog(s);
}

async function refresh() {
  if (pending) return;
  const response = await send({ type: "AUTO_STATUS" });
  if (!response) return;
  const s = response.signedIn !== undefined ? response : response.data;
  if (s) render(s);
}

async function act(message, onError) {
  pending += 1;
  try {
    const response = await send(message);
    if (response && response.ok === false && onError) onError(response.error || "Chưa thực hiện được");
    return response;
  } finally {
    pending -= 1;
    await refresh();
  }
}

$("signin").addEventListener("submit", async event => {
  event.preventDefault();
  const err = $("signin-err");
  err.hidden = true;
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) { err.textContent = "Nhập email và mật khẩu"; err.hidden = false; return; }
  const btn = $("signin-btn");
  btn.disabled = true;
  const response = await act({ type: "AUTO_SIGN_IN", email, password }, message => { err.textContent = message; err.hidden = false; });
  btn.disabled = false;
  if (response && response.ok) $("password").value = "";
});

$("signout-btn").addEventListener("click", () => act({ type: "AUTO_SIGN_OUT" }));

async function saveDevice() {
  const input = $("device");
  const value = input.value.trim().slice(0, 40);
  const err = $("device-err");
  if (!value) { err.textContent = "Nhập tên máy"; err.hidden = false; return; }
  err.hidden = true;
  if (value === (state?.device || "")) return;
  await act({ type: "AUTO_SET_DEVICE", device: value }, message => { err.textContent = message; err.hidden = false; });
}
$("device").addEventListener("blur", saveDevice);
$("device").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); saveDevice(); } });
$("enabled").addEventListener("change", event => act({ type: "AUTO_SET_ENABLED", enabled: event.target.checked }));

$("last").addEventListener("click", event => {
  const toggle = event.target.closest("[data-run-toggle]");
  if (toggle) {
    const kind = toggle.dataset.runToggle;
    const menu = $("last").querySelector(`[data-menu="${kind}"]`);
    const willOpen = menu.hidden;
    $("last").querySelectorAll("[data-menu]").forEach(m => { m.hidden = true; });
    $("last").querySelectorAll("[data-run-toggle]").forEach(b => b.setAttribute("aria-expanded", "false"));
    menu.hidden = !willOpen;
    toggle.setAttribute("aria-expanded", String(willOpen));
    openMenu = willOpen ? kind : null;
    event.stopPropagation();
    return;
  }
  const run = event.target.closest("[data-run]");
  if (run) {
    openMenu = null;
    const kind = run.dataset.run;
    const mode = run.dataset.mode;
    state = { ...state, running: { kind } };
    renderLast(state);
    const err = $("run-err");
    err.hidden = true;
    send({ type: "AUTO_RUN_NOW", kind, mode }).then(response => {
      if (response && response.ok === false) { err.textContent = response.error || response.result?.message || "Chưa chạy được"; err.hidden = false; }
    }).finally(refresh);
  }
});
document.addEventListener("click", event => {
  if (!openMenu || event.target.closest(".runwrap")) return;
  openMenu = null;
  $("last").querySelectorAll("[data-menu]").forEach(m => { m.hidden = true; });
  $("last").querySelectorAll("[data-run-toggle]").forEach(b => b.setAttribute("aria-expanded", "false"));
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !openMenu) return;
  openMenu = null;
  $("last").querySelectorAll("[data-menu]").forEach(m => { m.hidden = true; });
});

hydrate();
try { $("ver").textContent = `v${chrome.runtime.getManifest().version}`; } catch (_) { $("ver").textContent = ""; }
refresh();
setInterval(refresh, 15000);
