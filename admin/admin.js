"use strict";
const BASE = document.body.dataset.base, API = BASE + "/api";
const app = document.getElementById("app");
let ME = null, CSRF = "", lastActive = Date.now(), idleTimer = null;

/* ───────── helpers ───────── */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") Object.assign(e.style, v);            // CSP: style attribute nahi, CSSOM
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(2)) { if (kid == null || kid === false) continue; e.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return e;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const fmt = (d) => (d ? new Date(d).toLocaleString() : "-");
const can = (p) => ME && ME.perms.includes(p);
const btn = (label, cls, fn) => h("button", { class: "btn " + (cls || ""), type: "button", onclick: fn }, label);
const field = (label, input) => h("div", {}, h("label", {}, label), input);
function toast(msg) { const t = h("div", { class: "toast" }, msg); document.body.append(t); setTimeout(() => t.remove(), 2500); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== "session" && e.message !== "cancelled") alert(e.message || "Error"); } };

async function api(path, { method = "GET", body, raw } = {}, retry = true) {
  lastActive = Date.now();
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", "x-csrf": CSRF }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 428 && retry) { await askReauth(); return api(path, { method, body, raw }, false); }
  if (raw) return r;
  const d = await r.json().catch(() => ({}));
  if (r.status === 404 && ME) { sessionEnded(); throw new Error("session"); }   // login ke baad 404 = session khatam
  if (!r.ok) { const e = new Error(d.error || "Error"); e.data = d; e.status = r.status; throw e; }
  return d;
}

function modal(title, ...content) {
  const m = h("div", { class: "modal" }, h("div", { class: "card" }, h("div", { class: "row" }, h("h2", { style: { flex: "1" } }, title), btn("✕", "ghost sm", () => m.remove())), ...content));
  m.addEventListener("mousedown", (e) => { if (e.target === m) m.remove(); });
  document.body.append(m);
  return m;
}

function askReauth() {
  return new Promise((resolve, reject) => {
    const pw = h("input", { type: "password", autocomplete: "current-password", style: { width: "100%" } });
    const err = h("div", { class: "err" });
    const m = modal("🔐 Dobara password daalo", h("p", { class: "sub" }, "Ye khatarnak kaam hai. Apna admin password confirm karo (5 minute tak valid)."), pw, err,
      h("div", { class: "row" }, btn("Confirm", "", async () => {
        try { await fetch(API + "/reauth", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf": CSRF }, body: JSON.stringify({ password: pw.value }) }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Galat password"); }); done = true; m.remove(); resolve(); }
        catch (e) { err.textContent = e.message; }
      }), btn("Cancel", "ghost", () => m.remove())));
    let done = false;
    new MutationObserver(() => { if (!document.body.contains(m) && !done) { done = true; reject(new Error("cancelled")); } }).observe(document.body, { childList: true });
    pw.focus();
  });
}

function sessionEnded(msg) { ME = null; CSRF = ""; clearInterval(idleTimer); showLogin(msg || "Session khatam ho gayi (idle ya expire). Dobara login karo."); }

/* ───────── login / setup ───────── */
async function showLogin(msg) {
  clear(app);
  let st = { setup: false };
  try { st = await (await fetch(API + "/state")).json(); } catch {}
  const err = h("div", { class: "err" }, msg || "");
  const post = async (path, body) => {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Error");
  };
  if (st.setup) {
    const key = h("input", { type: "password", autocomplete: "off" }), u = h("input", { autocomplete: "username", maxlength: 24 });
    const p1 = h("input", { type: "password", autocomplete: "new-password" }), p2 = h("input", { type: "password", autocomplete: "new-password" });
    app.append(h("div", { class: "center" }, h("form", { class: "card narrow", onsubmit: guard(async (e) => {
      e.preventDefault(); err.textContent = "";
      if (p1.value !== p2.value) { err.textContent = "Dono password same nahi hain."; return; }
      try { await post("/setup", { setupKey: key.value, username: u.value, password: p1.value }); boot(); } catch (x) { err.textContent = x.message; }
    }) }, h("h1", {}, "🛡️ Admin setup"), h("p", { class: "sub" }, "Pehla Owner account banao. Iske baad 2FA bhi lagana hoga."),
      field("Setup key (Render ke ADMIN_SETUP_KEY wali)", key), field("Owner username", u), field("Password (12+ characters, letters + numbers)", p1), field("Password dobara", p2),
      h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Owner banao")), err)));
    return;
  }
  const u = h("input", { autocomplete: "username", maxlength: 24 }), p = h("input", { type: "password", autocomplete: "current-password" });
  const c = h("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 12, placeholder: "123456 ya recovery code" });
  app.append(h("div", { class: "center" }, h("form", { class: "card narrow", onsubmit: guard(async (e) => {
    e.preventDefault(); err.textContent = "";
    try { await post("/login", { username: u.value, password: p.value, code: c.value }); boot(); } catch (x) { err.textContent = x.message; }
  }) }, h("h1", {}, "🛡️ Admin login"), h("p", { class: "sub" }, "Sirf authorized admins ke liye."),
    field("Username", u), field("Password", p), field("2FA code (authenticator app)", c),
    h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Login")), err)));
}

/* ───────── forced steps: password change, 2FA enroll ───────── */
function showForcePassword() {
  clear(app);
  const cur = h("input", { type: "password", autocomplete: "current-password" }), n1 = h("input", { type: "password", autocomplete: "new-password" }), n2 = h("input", { type: "password", autocomplete: "new-password" });
  const err = h("div", { class: "err" });
  app.append(h("div", { class: "center" }, h("form", { class: "card narrow", onsubmit: guard(async (e) => {
    e.preventDefault(); err.textContent = "";
    if (n1.value !== n2.value) { err.textContent = "Dono password same nahi hain."; return; }
    try { await api("/password", { method: "POST", body: { current: cur.value, next: n1.value } }); boot(); } catch (x) { err.textContent = x.message; }
  }) }, h("h1", {}, "Naya password set karo"), h("p", { class: "sub" }, "Pehle login ke liye temporary password mila tha. Ab apna password banao."),
    field("Abhi wala (temporary) password", cur), field("Naya password (12+ characters)", n1), field("Naya password dobara", n2),
    h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save")), err)));
}

async function showEnroll() {
  clear(app);
  const box = h("div", { class: "card narrow" }, h("h1", {}, "2FA lagao"), h("p", { class: "sub" }, "Loading…"));
  app.append(h("div", { class: "center" }, box));
  const d = await api("/2fa/setup", { method: "POST" });
  const code = h("input", { inputmode: "numeric", maxlength: 6, autocomplete: "one-time-code", placeholder: "6-digit code" }), err = h("div", { class: "err" });
  clear(box).append(h("h1", {}, "2FA lagao"),
    h("p", { class: "sub" }, "Google Authenticator / Authy / Microsoft Authenticator me ye QR scan karo, phir app ka 6-digit code daalo."),
    h("img", { src: d.qr, width: 220, height: 220, alt: "2FA QR" }),
    h("p", { class: "muted" }, "QR na chale to ye key app me haath se daalo:"), h("div", { class: "codes" }, d.secret),
    field("App ka code", code),
    h("div", { class: "row" }, btn("Confirm", "", guard(async () => {
      err.textContent = "";
      try {
        const r = await api("/2fa/confirm", { method: "POST", body: { code: code.value } });
        clear(box).append(h("h1", {}, "✅ 2FA chalu"), h("p", { class: "warn" }, "Ye 8 recovery codes abhi save kar lo (password manager ya kagaz). Phone kho jaye to inhi se login hota hai. Har code sirf ek baar chalta hai aur dobara nahi dikhega."),
          h("div", { class: "codes" }, r.recoveryCodes.map((c) => h("div", {}, c))), h("div", { class: "row" }, btn("Maine save kar liye", "", () => boot())));
      } catch (x) { err.textContent = x.message; }
    }))), err);
}

/* ───────── shell ───────── */
const TABS = [
  { id: "dash", label: "📊 Dashboard", perm: "users.view" }, { id: "reports", label: "🚩 Reports", perm: "reports.view" },
  { id: "users", label: "👥 Users", perm: "users.view" }, { id: "monitor", label: "👁 Live monitor", perm: "monitor.view" },
  { id: "appeals", label: "📨 Appeals", perm: "appeals.view" }, { id: "rooms", label: "💬 Rooms & Announce", perm: "rooms.manage" },
  { id: "analytics", label: "📈 Analytics", perm: "analytics.view" }, { id: "words", label: "🚫 Bad words", perm: "words.edit" },
  { id: "settings", label: "⚙️ Site settings", perm: "settings.edit" }, { id: "admins", label: "🛡️ Admins", perm: "admins.manage" },
  { id: "audit", label: "📜 Audit log", perm: "audit.view" }, { id: "health", label: "🩺 Health & logs", perm: "health.view" },
  { id: "account", label: "🔑 My account", perm: null },
];
let current = "dash", refreshTimer = null;

function showApp() {
  clear(app);
  const content = h("div", { class: "content" }), idle = h("span", { class: "muted" });
  const side = h("div", { class: "side" }, h("div", { class: "brand" }, "🛡️ Admin"));
  for (const t of TABS) if (!t.perm || can(t.perm)) side.append(h("button", { class: "tab", "data-tab": t.id, onclick: () => go(t.id) }, t.label));
  const go = (id) => {
    current = id; clearInterval(refreshTimer);
    side.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
    clear(content);
    const fn = RENDER[id];
    Promise.resolve(fn(content)).catch((e) => { if (e.message !== "session") content.append(h("div", { class: "err" }, e.message)); });
  };
  app.append(h("div", { class: "layout" }, side, h("div", { class: "main" },
    h("div", { class: "top" }, h("b", {}, ME.username), h("span", { class: "badge " + ME.role }, ME.role), h("span", { class: "grow" }), idle,
      btn("Logout", "ghost sm", guard(async () => { await fetch(API + "/logout", { method: "POST", headers: { "x-csrf": CSRF } }); sessionEnded("Logout ho gaye."); }))),
    content)));
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    const left = ME.idleMinutes * 60000 - (Date.now() - lastActive);
    idle.textContent = `Idle logout: ${Math.max(0, Math.ceil(left / 60000))} min`;
    if (left <= 0) sessionEnded("Idle timeout: session band ho gayi. Dobara login karo.");
  }, 5000);
  for (const ev of ["click", "keydown"]) document.addEventListener(ev, () => { lastActive = Date.now(); });
  go(can("users.view") ? "dash" : "account");
}

async function boot() {
  const r = await fetch(API + "/me");
  if (!r.ok) return showLogin();
  ME = await r.json(); CSRF = ME.csrf; lastActive = Date.now();
  if (ME.mustChangePassword) return showForcePassword();
  if (!ME.totpEnabled) return showEnroll().catch((e) => alert(e.message));
  showApp();
}

/* ───────── generic UI pieces ───────── */
function table(head, rows) {
  return h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))));
}
function pager(state, total, reload) {
  return h("div", { class: "pager" }, btn("← Prev", "ghost sm", () => { if (state.page > 1) { state.page--; reload(); } }), `Page ${state.page} / ${total}`, btn("Next →", "ghost sm", () => { if (state.page < total) { state.page++; reload(); } }));
}
const ask = (q, def = "") => prompt(q, def);

function statusBadges(u) {
  const out = [];
  if (u.banned) out.push(h("span", { class: "badge red" }, "banned"));
  else if (u.bannedUntil && new Date(u.bannedUntil) > new Date()) out.push(h("span", { class: "badge red" }, "temp-ban " + fmt(u.bannedUntil)));
  if (u.mutedUntil && new Date(u.mutedUntil) > new Date()) out.push(h("span", { class: "badge" }, "muted"));
  if (u.online) out.push(h("span", { class: "badge green" }, "online"));
  return out.length ? out : ["-"];
}

/* ───────── Dashboard ───────── */
async function renderDash(box) {
  const s = await api("/stats");
  const cards = [["👥 Total registered users", s.totalUsers, true], ["🆕 Last 24 hours", s.new24], ["📅 Last 7 days", s.new7], ["🟢 Online now", s.online],
    ["⛔ Banned", s.banned], ["⏳ Temp-banned", s.tempBanned], ["🔇 Muted", s.muted], ["🚩 Open reports", s.openReports], ["📨 Open appeals", s.openAppeals]];
  box.append(h("h2", {}, "Dashboard"));
  const f = s.flags, on = [f.maintenance && "🛠️ Maintenance mode ON", f.readOnly && "🔒 Read-only mode ON", !f.registration && "🚫 Registration band"].filter(Boolean);
  if (on.length) box.append(h("div", { class: "warn" }, on.join("  ·  ")));
  if (can("users.export")) {
    const days = s.lastExport ? (Date.now() - new Date(s.lastExport)) / 86400000 : null;
    if (days === null || days > 7) box.append(h("div", { class: "warn" }, days === null ? "⚠️ Abhi tak users ka backup (CSV export) nahi liya gaya. " : `⚠️ Aakhri backup ${Math.floor(days)} din pehle liya tha. `, "Users tab me 'Export CSV' se download karke rakho."));
  }
  box.append(h("div", { class: "stats" }, cards.map(([l, v, big]) => h("div", { class: "stat" + (big ? " big" : "") }, h("b", {}, v), h("span", {}, l)))));
}

/* ───────── Reports ───────── */
async function renderReports(box) {
  const st = { page: 1, status: "open" }, list = h("div");
  const sel = h("select", { onchange: () => { st.status = sel.value; st.page = 1; load(); } }, ["open", "actioned", "dismissed"].map((x) => h("option", { value: x }, x)));
  box.append(h("h2", {}, "Reports"), h("div", { class: "row" }, sel), list);
  async function load() {
    const d = await api(`/reports?status=${st.status}&page=${st.page}`);
    clear(list);
    if (!d.reports.length) list.append(h("p", { class: "muted" }, "Koi report nahi. 🎉"));
    d.reports.forEach((r) => list.append(reportCard(r, load)));
    list.append(pager(st, d.pages, load));
  }
  await load();
}

function reportCard(r, reload) {
  const target = r.target, discord = target.endsWith(" [Discord]"), u = encodeURIComponent(target);
  const resolve = (status) => api(`/reports/${r._id}/resolve`, { method: "POST", body: { status } });
  const act = (label, cls, perm, fn) => (!perm || can(perm) ? h("button", { class: "btn sm " + cls, type: "button", onclick: guard(async () => { await fn(); reload(); }) }, label) : null);
  const need = (v) => { if (v === null || v === "") throw new Error("cancelled"); return v; };
  return h("div", { class: "item" },
    h("b", {}, `${target} ← ${r.reporter}`), h("span", { class: "muted" }, ` · ${r.reason} · ${r.where}${r.room ? " · #" + r.room : ""} · ${fmt(r.createdAt)} `), h("span", { class: "badge" }, r.status),
    h("pre", {}, (r.context || []).map((c) => `${c.from}: ${c.text}`).join("\n") || "(no context)"),
    h("div", { class: "row" },
      discord ? null : btn("Open user", "ghost sm", () => openUser(target)),
      r.msgId ? act("🗑 Delete message", "ghost", "messages.delete", () => api(`/messages/${r.msgId}/delete`, { method: "POST" })) : null,
      discord ? null : act("⚠️ Warn", "ghost", "users.warn", async () => { await api(`/users/${u}/warn`, { method: "POST", body: { reason: need(ask("Warning ka reason:", r.reason)) } }); await resolve("actioned"); }),
      discord ? null : act("🔇 Mute 1h", "ghost", "users.mute", async () => { await api(`/users/${u}/mute`, { method: "POST", body: { minutes: 60, reason: r.reason } }); await resolve("actioned"); }),
      discord ? null : act("⏳ Ban 24h", "ghost", "users.tempban", async () => { await api(`/users/${u}/tempban`, { method: "POST", body: { hours: 24, reason: r.reason } }); }),
      discord ? null : act("⛔ Ban", "danger", "users.ban", async () => { await api(`/users/${u}/ban`, { method: "POST", body: { reason: need(ask("Ban ka reason:", r.reason)) } }); }),
      r.status === "open" ? act("Dismiss", "ghost", "reports.act", () => resolve("dismissed")) : null));
}

/* ───────── Users ───────── */
async function renderUsers(box) {
  const st = { page: 1, q: "", filter: "" }, body = h("div"), t = { id: null };
  const q = h("input", { placeholder: "Username search…", maxlength: 20, oninput: () => { clearTimeout(t.id); t.id = setTimeout(() => { st.q = q.value; st.page = 1; load(); }, 300); } });
  const fl = h("select", { onchange: () => { st.filter = fl.value; st.page = 1; load(); } }, [["", "Sab"], ["banned", "Banned"], ["muted", "Muted"], ["warned", "Warnings wale"]].map(([v, l]) => h("option", { value: v }, l)));
  const exp = can("users.export") ? btn("⬇ Export CSV (backup)", "ghost", guard(async () => {
    const r = await api("/export/users.csv", { raw: true });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Export fail");
    const a = h("a", { href: URL.createObjectURL(await r.blob()), download: `users-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove(); toast("CSV download ho gaya.");
  })) : null;
  box.append(h("h2", {}, "Users ", h("span", { class: "muted", id: "utotal" })), h("div", { class: "row" }, q, fl, exp), body);
  if (can("bulk")) box.append(bulkPanel());
  async function load() {
    const d = await api(`/users?page=${st.page}&q=${encodeURIComponent(st.q)}&filter=${st.filter}`);
    document.getElementById("utotal").textContent = `(${d.total})`;
    clear(body).append(table(["Username", "Gender / Country", "Joined", "Last login", "Status", "Warns", ""],
      d.users.map((u) => [u.username, `${u.gender || "-"} / ${u.country || "-"}`, fmt(u.createdAt), fmt(u.lastLoginAt), statusBadges(u), u.warnings, btn("Open", "ghost sm", () => openUser(u.username))])), pager(st, d.pages, load));
  }
  await load();
}

function bulkPanel() {
  const names = h("textarea", { rows: 3, placeholder: "Usernames (ek line me ek, ya comma se). Max 50." });
  const action = h("select", {}, ["ban", "unban", "mute", "unmute", "tempban", "logout"].map((x) => h("option", { value: x }, x)));
  const mins = h("input", { type: "number", value: 60, min: 1, style: { width: "90px" } }), hrs = h("input", { type: "number", value: 24, min: 1, style: { width: "90px" } }), reason = h("input", { placeholder: "Reason", maxlength: 150 });
  return h("div", { class: "item" }, h("h3", {}, "Bulk action"), names,
    h("div", { class: "row" }, action, "mute min:", mins, "tempban hrs:", hrs, reason,
      btn("Run", "danger sm", guard(async () => {
        const list = names.value.split(/[\s,]+/).filter(Boolean);
        if (!list.length || !confirm(`${list.length} users par "${action.value}" chalana hai?`)) return;
        const d = await api("/bulk", { method: "POST", body: { action: action.value, usernames: list, minutes: Number(mins.value), hours: Number(hrs.value), reason: reason.value } });
        alert(d.results.map((r) => `${r.username}: ${r.ok ? "ok" : r.error}`).join("\n"));
      }))));
}

async function openUser(name) {
  const m = modal("👤 " + name), body = h("div");
  m.querySelector(".card").append(body);
  const enc = encodeURIComponent(name);
  async function load() {
    const d = await api(`/users/${enc}`), u = d.user;
    const run = (fn) => guard(async () => { await fn(); await load(); });
    const post = (p, b) => api(`/users/${enc}/${p}`, { method: "POST", body: b });
    const nn = (v) => { if (v === null || v === "") throw new Error("cancelled"); return v; };
    const A = (label, cls, perm, fn) => (can(perm) ? btn(label, cls + " sm", run(fn)) : null);
    clear(body).append(
      h("div", { class: "row" }, statusBadges(u), u.isProtected ? h("span", { class: "badge" }, "protected (ADMIN_USERS)") : null, u.locked ? h("span", { class: "badge red" }, "login-locked") : null),
      h("div", { class: "muted" }, `Joined ${fmt(u.createdAt)} · Last login ${fmt(u.lastLoginAt)} · ${u.gender || "-"} / ${u.country || "-"}`),
      h("div", { class: "muted" }, `Blocked by ${u.blockedBy} users · blocks ${u.blockedCount} · reports against ${d.against.length}+ · reports filed ${d.byCount}`),
      u.banned || u.bannedUntil ? h("div", { class: "warn" }, `Ban: ${u.banned ? "permanent" : "till " + fmt(u.bannedUntil)}${u.banReason ? " · " + u.banReason : ""}`) : null,
      u.isProtected ? null : h("div", { class: "row" },
        A("⚠️ Warn", "ghost", "users.warn", () => post("warn", { reason: nn(ask("Warning reason:")) })),
        A("🔇 Mute", "ghost", "users.mute", async () => { const m1 = nn(ask("Kitne minute mute? (0 = unmute)", "60")); await post("mute", { minutes: Number(m1), reason: Number(m1) ? ask("Reason:") || "" : "" }); }),
        A("⏳ Temp ban", "ghost", "users.tempban", async () => { const hh = nn(ask("Kitne ghante? (1-720)", "24")); await post("tempban", { hours: Number(hh), reason: ask("Reason:") || "" }); }),
        u.banned || (u.bannedUntil && new Date(u.bannedUntil) > new Date()) ? A("✅ Unban", "", "users.unban", () => post("unban")) : A("⛔ Ban", "danger", "users.ban", () => post("ban", { reason: ask("Ban reason:") || "" })),
        u.locked || u.failedAttempts ? A("🔓 Unlock login", "ghost", "users.unlock", () => post("unlock")) : null,
        A("🚪 Force logout", "ghost", "users.logout", () => post("logout"))),
      h("h3", {}, `Warnings (${u.warnings.length})`), u.warnings.length ? h("div", {}, u.warnings.map((w) => h("div", {}, `${fmt(w.at)} · ${w.by}: ${w.reason}`))) : h("div", { class: "muted" }, "Koi nahi"),
      u.mutedUntil && new Date(u.mutedUntil) > new Date() ? h("div", { class: "muted" }, `Muted till ${fmt(u.mutedUntil)} ${u.muteReason || ""}`) : null,
      h("h3", {}, "Private notes"),
      d.notes.length ? h("div", {}, d.notes.map((n) => h("div", {}, h("span", { class: "muted" }, `${fmt(n.at)} · ${n.admin}: `), n.text))) : h("div", { class: "muted" }, "Koi note nahi"),
      can("users.notes") ? h("div", { class: "row" }, (() => { const i = h("input", { placeholder: "Naya note (sirf admins ko dikhega)", maxlength: 500, style: { flex: "1" } }); return [i, btn("Add", "sm", run(async () => { if (i.value.trim()) await post("note", { text: i.value }); }))]; })()) : null,
      h("h3", {}, "Reports against this user"),
      d.against.length ? d.against.map((r) => h("div", { class: "item" }, h("div", {}, `${r.reason} · ${r.where} · by ${r.reporter} · ${fmt(r.createdAt)} `, h("span", { class: "badge" }, r.status)), h("pre", {}, (r.context || []).map((c) => `${c.from}: ${c.text}`).join("\n") || "(no context)"))) : h("div", { class: "muted" }, "Koi nahi"),
      d.appeals.length ? [h("h3", {}, "Appeals"), d.appeals.map((a) => h("div", {}, `${fmt(a.createdAt)} · ${a.status}: ${a.message}`))] : null);
  }
  await load().catch((e) => { body.append(h("div", { class: "err" }, e.message)); });
}

/* ───────── Live monitor ───────── */
async function renderMonitor(box) {
  const list = h("div"), auto = h("input", { type: "checkbox", checked: true });
  const sel = h("select", { onchange: load }, ME.rooms.map((r) => h("option", { value: r.id }, r.name)));
  box.append(h("h2", {}, "Live monitor (read-only)"), h("p", { class: "sub" }, "Room ke pichle messages. Kholna audit log me likha jata hai. Messages 20 min baad apne aap delete ho jate hain."),
    h("div", { class: "row" }, sel, h("label", {}, auto, " auto-refresh (10s)"), btn("Refresh", "ghost sm", load)), list);
  async function load() {
    const d = await api(`/monitor/${sel.value}`);
    clear(list).append(h("div", { class: "muted" }, `${d.online} online${d.closed ? " · 🔒 closed" : ""}`));
    if (!d.messages.length) list.append(h("p", { class: "muted" }, "Is room me abhi koi message nahi."));
    for (const m of d.messages) list.append(h("div", { class: "msgline" }, h("span", { class: "muted" }, new Date(m.createdAt).toLocaleTimeString()), h("b", {}, m.username + (m.src === "discord" ? " [D]" : "")),
      h("span", { class: "t" }, m.text), can("messages.delete") ? btn("🗑", "ghost sm", guard(async () => { if (confirm("Ye message delete karein?")) { await api(`/messages/${m.id}/delete`, { method: "POST" }); load(); } })) : null));
  }
  refreshTimer = setInterval(() => { if (auto.checked) load().catch(() => {}); }, 10000);
  await load();
}

/* ───────── Appeals ───────── */
async function renderAppeals(box) {
  const list = h("div"), sel = h("select", { onchange: load }, ["open", "approved", "rejected"].map((x) => h("option", { value: x }, x)));
  box.append(h("h2", {}, "Ban appeals"), h("div", { class: "row" }, sel), list);
  async function load() {
    const d = await api(`/appeals?status=${sel.value}`);
    clear(list);
    if (!d.appeals.length) list.append(h("p", { class: "muted" }, "Koi appeal nahi."));
    for (const a of d.appeals) list.append(h("div", { class: "item" }, h("b", {}, a.username), h("span", { class: "muted" }, ` · ${fmt(a.createdAt)}${a.decidedBy ? " · " + a.decidedBy : ""}`), h("pre", {}, a.message),
      a.status === "open" && can("appeals.decide") ? h("div", { class: "row" }, btn("Open user", "ghost sm", () => openUser(a.username)),
        btn("✅ Approve (unban)", "sm", guard(async () => { await api(`/appeals/${a._id}/decide`, { method: "POST", body: { decision: "approve", note: ask("Note (optional):") || "" } }); load(); })),
        btn("❌ Reject", "danger sm", guard(async () => { await api(`/appeals/${a._id}/decide`, { method: "POST", body: { decision: "reject", note: ask("Reject ka reason (optional):") || "" } }); load(); }))) : null));
  }
  await load();
}

/* ───────── Rooms + announce ───────── */
async function renderRooms(box) {
  const wrapT = h("div");
  const text = h("input", { maxlength: 200, placeholder: "Announcement (max 200 characters)", style: { width: "100%" } });
  const target = h("select", {}, [h("option", { value: "all" }, "Sab rooms"), ...ME.rooms.map((r) => h("option", { value: r.id }, r.name))]);
  box.append(h("h2", {}, "Rooms"), wrapT, h("h3", {}, "📢 Announcement bhejo"), text,
    h("div", { class: "row" }, target, btn("Send", "", guard(async () => { await api("/announce", { method: "POST", body: { text: text.value, room: target.value } }); text.value = ""; toast("Bhej diya."); }))));
  async function load() {
    const d = await api("/rooms");
    clear(wrapT).append(table(["Room", "Display name", "Slowmode (sec)", "Status", "Online"], d.rooms.map((r) => {
      const nm = h("input", { value: r.customName, placeholder: r.name, maxlength: 24 }), sl = h("input", { type: "number", min: 0, max: 300, value: r.slow, style: { width: "80px" } });
      const save = (b) => guard(async () => { await api(`/rooms/${r.id}`, { method: "POST", body: b }); load(); });
      return [r.id, h("div", { class: "row" }, nm, btn("Save", "ghost sm", () => save({ name: nm.value })())),
        h("div", { class: "row" }, sl, btn("Set", "ghost sm", () => save({ slow: Number(sl.value) })())),
        h("div", { class: "row" }, r.closed ? h("span", { class: "badge red" }, "closed") : h("span", { class: "badge green" }, "open"), btn(r.closed ? "Open karo" : "Close karo", "ghost sm", () => save({ closed: !r.closed })())), r.online];
    })));
  }
  await load();
}

/* ───────── Analytics ───────── */
function columns(items, titleFn) {
  const max = Math.max(1, ...items.map((i) => i.v));
  const c = h("div", { class: "cols" });
  for (const i of items) { const b = h("div", { title: titleFn(i) }); b.style.height = Math.max(2, (i.v / max) * 100) + "%"; c.append(b); }
  return c;
}
function hbars(entries) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  if (!entries.length) return h("div", { class: "muted" }, "Data nahi.");
  return h("div", {}, entries.map(([l, n]) => { const bar = h("div", { class: "bar" }); bar.style.width = Math.max(1, (n / max) * 60) + "%"; return h("div", { class: "hb" }, h("span", { class: "l" }, l), bar, h("span", { class: "n" }, n)); }));
}
async function renderAnalytics(box) {
  const d = await api("/analytics"), off = new Date().getTimezoneOffset();
  const hours = d.hourly.map((x) => { const t = (x.h * 60 - off + 1440) % 1440; return { ...x, label: `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`, v: x.roomMsgs + x.dmMsgs, t }; }).sort((a, b) => a.t - b.t);
  const t7 = d.totals7;
  box.append(h("h2", {}, "Analytics"),
    h("h3", {}, "Naye users: pichle 30 din"), columns(d.signups.map((s) => ({ v: s.n, d: s.d })), (i) => `${i.d}: ${i.v}`),
    h("h3", {}, "Peak hours: messages (pichle 7 din, aapke local time me)"), columns(hours, (i) => `${i.label}: ${i.roomMsgs} room + ${i.dmMsgs} DM, peak online ${i.peak}`),
    h("div", { class: "stats" }, [["Room messages (7d)", t7.roomMsgs], ["DM messages (7d)", t7.dmMsgs], ["Logins (7d)", t7.logins], ["Naye signups (7d)", t7.signups],
      ["Random matches (7d)", t7.randomMatches], ["Random avg chat (sec)", d.randomAvgSec], ["Random messages (7d)", t7.randomMsgs]].map(([l, v]) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, l)))),
    h("p", { class: "muted" }, "Note: stats us din se bante hain jab ye feature chalu hua."),
    h("h3", {}, "Gender"), hbars(Object.entries(d.gender)), h("h3", {}, "Top countries"), hbars(d.countries),
    h("h3", {}, `Reports (pichle 30 din): ${d.reports.total}`), h("div", { class: "muted" }, "Reason ke hisaab se"), hbars(Object.entries(d.reports.byReason)),
    h("div", { class: "muted" }, "Kahan (room / dm / random)"), hbars(Object.entries(d.reports.byWhere)), h("div", { class: "muted" }, "Kis room me"), hbars(Object.entries(d.reports.byRoom)),
    h("div", { class: "muted" }, "Pichle 14 din"), columns(d.reports.perDay.map((s) => ({ v: s.n, d: s.d })), (i) => `${i.d}: ${i.v}`));
}

/* ───────── Bad words ───────── */
async function renderWords(box) {
  const d = await api("/words"), ta = h("textarea", { rows: 12, placeholder: "Ek line me ek word/phrase (3-30 characters)" });
  ta.value = d.words.join("\n");
  box.append(h("h2", {}, "Custom bad words"), h("p", { class: "sub" }, "Ye words built-in list ke saath mask hote hain (****). Leetspeak (sh1t) bhi pakad leta hai. Max 500."), ta,
    h("div", { class: "row" }, btn("Save", "", guard(async () => { const r = await api("/words", { method: "POST", body: { words: ta.value.split("\n") } }); toast(`${r.count} words save hue.`); }))));
}

/* ───────── Site settings ───────── */
async function renderSettings(box) {
  const s = await api("/settings");
  const chk = (v) => h("input", { type: "checkbox", checked: v });
  const mt = chk(s.maintenance), ro = chk(s.readOnly), rg = chk(s.registration);
  const age = h("input", { type: "number", min: 13, max: 30, value: s.minAge || "", placeholder: `default ${s.defaultMinAge}`, style: { width: "120px" } });
  const banner = h("input", { value: s.banner, maxlength: 200, style: { width: "100%" }, placeholder: "Sab users ko upar dikhne wala message (khali = band)" });
  const warns = h("input", { type: "number", min: 1, max: 10, value: s.autoBanWarnings, style: { width: "80px" } });
  box.append(h("h2", {}, "Site settings"),
    h("div", { class: "item" }, h("label", {}, mt, " 🛠️ Maintenance mode (sab users logout, naye login band; sirf admin panel chalta hai)"), h("label", {}, ro, " 🔒 Read-only mode (log padh sakte hain, message nahi bhej sakte)"), h("label", {}, rg, " ✅ Naye registration allowed")),
    h("div", { class: "item" }, field("Minimum age (khali = default)", age), field("Banner message", banner), field("Itni warnings ke baad auto-ban", warns)),
    btn("Save settings", "", guard(async () => {
      await api("/settings", { method: "POST", body: { maintenance: mt.checked, readOnly: ro.checked, registration: rg.checked, minAge: age.value === "" ? null : Number(age.value), banner: banner.value, autoBanWarnings: Number(warns.value) } });
      toast("Settings save ho gayi.");
    })));
}

/* ───────── Admin accounts ───────── */
async function renderAdmins(box) {
  const list = h("div");
  const u = h("input", { placeholder: "username", maxlength: 24 }), role = h("select", {}, ["moderator", "admin"].map((x) => h("option", { value: x }, x)));
  box.append(h("h2", {}, "Admin accounts"), list, h("h3", {}, "Naya admin banao"), h("div", { class: "row" }, u, role, btn("Create", "", guard(async () => {
    const r = await api("/admins", { method: "POST", body: { username: u.value, role: role.value } });
    modal("✅ Admin ban gaya", h("p", { class: "warn" }, "Ye temporary password sirf abhi dikhega. Admin ko safe tareeke se do. Pehle login par use naya password aur 2FA set karna hoga."),
      h("div", {}, "Username: ", h("b", {}, u.value)), h("div", { class: "codes" }, r.tempPassword));
    u.value = ""; load();
  }))));
  async function load() {
    const d = await api("/admins");
    const act = (a, p, b, label, cls) => btn(label, "ghost sm " + (cls || ""), guard(async () => {
      if (!confirm(`${a.username}: ${label}?`)) return;
      const r = await api(`/admins/${encodeURIComponent(a.username)}/${p}`, { method: "POST", body: b });
      if (r.tempPassword) modal("♻️ Reset ho gaya", h("p", { class: "warn" }, "Naya temporary password (sirf abhi dikhega). 2FA bhi reset hua hai."), h("div", { class: "codes" }, r.tempPassword));
      load();
    }));
    clear(list).append(table(["Admin", "Role", "2FA", "Status", "Last login", "IP", ""], d.admins.map((a) => [a.username, h("span", { class: "badge " + a.role }, a.role), a.totpEnabled ? "✅" : "❌ pending",
      a.disabled ? h("span", { class: "badge red" }, "disabled") : a.locked ? h("span", { class: "badge red" }, "locked") : h("span", { class: "badge green" }, "active"), fmt(a.lastLoginAt), a.lastLoginIp || "-",
      a.role === "owner" || a.username === ME.username ? "-" : h("div", { class: "row" }, a.disabled ? act(a, "enable", {}, "Enable") : act(a, "disable", {}, "Disable"),
        act(a, "role", { role: a.role === "admin" ? "moderator" : "admin" }, a.role === "admin" ? "→ moderator" : "→ admin"), act(a, "reset", {}, "Reset password+2FA", "danger"))])));
  }
  await load();
}

/* ───────── Audit log ───────── */
async function renderAudit(box) {
  const st = { page: 1 }, out = h("div");
  const who = h("input", { placeholder: "admin naam", maxlength: 24 }), act = h("input", { placeholder: "action (jaise ban)", maxlength: 30 });
  box.append(h("h2", {}, "Audit log"), h("p", { class: "sub" }, "Har admin kaam yahan likha jata hai: kisne, kab, kya, kis IP se. Ye badla ya hataya nahi ja sakta."), h("div", { class: "row" }, who, act, btn("Filter", "ghost sm", () => { st.page = 1; load(); })), out);
  async function load() {
    const d = await api(`/audit?page=${st.page}&admin=${encodeURIComponent(who.value)}&action=${encodeURIComponent(act.value)}`);
    clear(out).append(table(["Time", "Admin", "Action", "Target", "Details", "IP"], d.rows.map((r) => [fmt(r.at), `${r.admin}${r.role ? " (" + r.role + ")" : ""}`, h("b", {}, r.action), r.target || "-", h("span", { class: "muted" }, JSON.stringify(r.details || {})), r.ip || "-"])), pager(st, d.pages, load));
  }
  await load();
}

/* ───────── Health + logs ───────── */
async function renderHealth(box) {
  const d = await api("/health-info");
  box.append(h("h2", {}, "Health"), h("div", { class: "stats" }, [["Database", d.db], ["Uptime (min)", Math.round(d.uptimeSec / 60)], ["Memory (MB)", d.memoryMB], ["Sockets", d.sockets], ["Online users", d.onlineUsers], ["Random queue", d.randomQueue], ["Node", d.node],
    ["Users", d.counts.users], ["Sessions", d.counts.sessions], ["Room msgs", d.counts.messages], ["DMs", d.counts.dms], ["Reports", d.counts.reports], ["Audit entries", d.counts.audit], ["IP allowlist", d.ipAllowlist ? "ON" : "off"]]
    .map(([l, v]) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, l)))));
  if (can("logs.view")) {
    const pre = h("pre", { class: "log" });
    box.append(h("h3", {}, "Server logs (aakhri 200 lines)"), pre);
    const l = await api("/logs");
    pre.textContent = l.lines.map((x) => `${new Date(x.t).toLocaleTimeString()} [${x.level}] ${x.msg}`).join("\n") || "(khali)";
    pre.scrollTop = pre.scrollHeight;
  }
}

/* ───────── My account ───────── */
async function renderAccount(box) {
  const cur = h("input", { type: "password", autocomplete: "current-password" }), n1 = h("input", { type: "password", autocomplete: "new-password" }), n2 = h("input", { type: "password", autocomplete: "new-password" });
  box.append(h("h2", {}, "My account"),
    h("div", { class: "item" }, h("div", {}, `Username: ${ME.username}  ·  Role: ${ME.role}`), h("div", { class: "muted" }, `2FA: ${ME.totpEnabled ? "chalu ✅" : "band"}  ·  Pichla login: ${fmt(ME.lastLoginAt)} (${ME.lastLoginIp || "-"})  ·  Idle logout: ${ME.idleMinutes} min`)),
    h("div", { class: "item" }, h("h3", {}, "Password badlo"), field("Abhi wala", cur), field("Naya (12+ characters, letters + numbers)", n1), field("Naya dobara", n2),
      h("div", { class: "row" }, btn("Save", "", guard(async () => {
        if (n1.value !== n2.value) throw new Error("Dono naye password same nahi hain.");
        await api("/password", { method: "POST", body: { current: cur.value, next: n1.value } }); cur.value = n1.value = n2.value = ""; toast("Password badal gaya.");
      })))));
}

const RENDER = { dash: renderDash, reports: renderReports, users: renderUsers, monitor: renderMonitor, appeals: renderAppeals, rooms: renderRooms, analytics: renderAnalytics,
  words: renderWords, settings: renderSettings, admins: renderAdmins, audit: renderAudit, health: renderHealth, account: renderAccount };

boot();
