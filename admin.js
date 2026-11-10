"use strict";
// Admin panel: alag admin accounts (password + 2FA), roles, audit log, moderation, analytics, site controls.
// server.js isko mount() se jodta hai. Admin panel site ke normal users/DOB login se bilkul alag hai.
const path = require("path");
const fs = require("fs");
const util = require("util");
const QRCode = require("qrcode");
const totp = require("./totp");

function adminPath() {
  const raw = String(process.env.ADMIN_PATH || "/admin").trim().replace(/\/+$/, "");
  const bad = !/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(raw) || /^\/(api|socket\.io|health|css|js)(\/|$)/i.test(raw);
  if (bad) { if (process.env.ADMIN_PATH) console.error(`⚠️  ADMIN_PATH "${process.env.ADMIN_PATH}" sahi nahi hai, /admin use ho raha hai.`); return "/admin"; }
  return raw;
}

/* ───────── Roles aur permissions ───────── */
const MOD = ["reports.view", "reports.act", "users.view", "users.warn", "users.mute", "users.tempban", "users.ban", "users.notes", "messages.delete", "monitor.view", "appeals.view"];
const ADM = [...MOD, "users.unban", "users.unlock", "users.logout", "users.export", "analytics.view", "announce", "words.edit", "appeals.decide", "audit.view", "bulk", "rooms.manage", "health.view"];
const OWN = [...ADM, "settings.edit", "admins.manage", "logs.view"];
const ROLE_PERMS = { moderator: new Set(MOD), admin: new Set(ADM), owner: new Set(OWN) };
const can = (role, perm) => !!ROLE_PERMS[role] && ROLE_PERMS[role].has(perm);

function mount(ctx) {
  const { app, express, mongoose, bcrypt, crypto, cookie, rateLimit, bus, IS_PROD, site, ROOMS, ROOM_IDS, ADMINS } = ctx;
  const { User, Session, Message, DM, Report, Appeal } = ctx.models;
  const P = adminPath();
  const IDLE_MS = Math.max(0.05, Number(process.env.ADMIN_IDLE_MIN) || 30) * 60000;
  const ABS_MS = (Number(process.env.ADMIN_MAX_HOURS) || 8) * 3600000;
  const REAUTH_MS = 5 * 60000;
  const SETUP_KEY = String(process.env.ADMIN_SETUP_KEY || "");
  const IPS = new Set(String(process.env.ADMIN_IPS || "").split(",").map((s) => s.trim().replace(/^::ffff:/, "")).filter(Boolean));
  const ENC_KEY = crypto.createHash("sha256").update(`admin-totp|${process.env.ADMIN_ENC_KEY || ctx.PEPPER || "dev-only"}`).digest();
  const COOKIE = "asid";
  const MAX_FAILED = 5, LOCK_MIN = 15;

  /* ───────── Models ───────── */
  const M = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
  const Admin = M("Admin", new mongoose.Schema({
    username: { type: String, required: true },
    usernameLower: { type: String, required: true, unique: true },
    passHash: { type: String, required: true },
    role: { type: String, enum: ["owner", "admin", "moderator"], required: true },
    ownerSlot: { type: String, unique: true, sparse: true },       // sirf ek owner (setup se)
    totpSecretEnc: { type: String, default: "" }, totpPendingEnc: { type: String, default: "" },
    totpEnabled: { type: Boolean, default: false }, lastTotpStep: { type: Number, default: 0 },
    recovery: { type: [{ _id: false, h: String, used: { type: Boolean, default: false } }], default: [] },
    mustChangePassword: { type: Boolean, default: false },
    failedAttempts: { type: Number, default: 0 }, lockUntil: { type: Date, default: null }, disabled: { type: Boolean, default: false },
    knownIps: { type: [String], default: [] }, createdBy: { type: String, default: "" }, createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null }, lastLoginIp: { type: String, default: "" },
  }));
  const AdminSession = M("AdminSession", new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true }, adminId: { type: mongoose.Schema.Types.ObjectId, index: true },
    csrf: String, ip: String, uaHash: String, createdAt: { type: Date, default: Date.now }, lastActive: { type: Date, default: Date.now },
    reauthUntil: { type: Date, default: null }, expiresAt: { type: Date, required: true, index: { expires: 0 } },
  }));
  const auditSchema = new mongoose.Schema({
    at: { type: Date, default: Date.now, index: -1 }, admin: String, role: String, action: { type: String, index: true },
    target: String, details: mongoose.Schema.Types.Mixed, ip: String,
  });
  // Audit log sirf badhta hai: code se edit ya delete karne ki koshish bhi fail hogi
  const NO = () => { throw new Error("Audit log badla nahi ja sakta."); };
  auditSchema.pre(["updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "replaceOne"], { document: false, query: true }, NO);
  auditSchema.pre("save", function () { if (!this.isNew) NO(); });
  const AuditLog = M("AuditLog", auditSchema);
  const Note = M("AdminNote", new mongoose.Schema({ userLower: { type: String, index: true }, admin: String, text: String, at: { type: Date, default: Date.now } }));
  const Stat = M("Stat", new mongoose.Schema({ _id: String, at: { type: Date, index: { expires: 90 * 86400 } }, c: { type: mongoose.Schema.Types.Mixed, default: {} }, peak: { type: Number, default: 0 } }));

  /* ───────── Chhote helpers ───────── */
  const wrap = ctx.wrap;
  const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const nameOk = (s) => /^[a-z0-9_]{3,20}$/.test(s);
  const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, "").trim().slice(0, n);
  const ipOf = (req) => String(req.ip || "").replace(/^::ffff:/, "");
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const notFound = (res) => res.status(404).json({ error: "Not found" });
  const DUMMY = bcrypt.hashSync("dummy-password-for-timing", 12);

  const enc = (text) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
    const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
  };
  const dec = (s) => {
    const [iv, tag, ct] = s.split(".").map((x) => Buffer.from(x, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  };

  function pwError(pw, username) {
    if (typeof pw !== "string") return "Password galat hai.";
    if (pw.length < 12) return "Password kam se kam 12 characters ka hona chahiye.";
    if (pw.length > 128) return "Password bahut lamba hai.";
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password me letters aur numbers dono hone chahiye.";
    if (pw.toLowerCase().includes(String(username).toLowerCase())) return "Password me username nahi hona chahiye.";
    if (/^(.)\1+$/.test(pw) || /password|123456|qwerty/i.test(pw)) return "Ye password bahut aasan hai.";
    return null;
  }

  const alert = (level, title, text) => { try { bus.emit("admin_alert", { level, title, text: String(text).slice(0, 900) }); } catch {} };

  async function audit(req, action, target = "", details = {}) {
    try {
      let d = {};
      try { d = JSON.parse(JSON.stringify(details, (k, v) => (typeof v === "string" ? v.slice(0, 300) : v))); } catch {}
      await AuditLog.create({ admin: req.adm ? req.adm.username : clean(details.admin || "-", 30), role: req.adm ? req.adm.role : "", action, target: String(target).slice(0, 60), details: d, ip: ipOf(req) });
    } catch (e) { console.error("audit:", e.message); }
  }

  /* ───────── Stats (graphs ke liye) ───────── */
  const pending = new Map();
  const bucket = () => new Date().toISOString().slice(0, 13); // "2026-11-09T05"
  function bump(key, n = 1) {
    const id = bucket();
    const b = pending.get(id) || { inc: {}, peak: 0 };
    b.inc[key] = (b.inc[key] || 0) + n;
    pending.set(id, b);
  }
  const onlineSet = () => { const s = new Set(); for (const [, x] of ctx.io().sockets.sockets) s.add(x.data.lower); return s; };
  function samplePeak() {
    const id = bucket(), b = pending.get(id) || { inc: {}, peak: 0 };
    b.peak = Math.max(b.peak, onlineSet().size);
    pending.set(id, b);
  }
  async function flush() {
    const items = [...pending.entries()];
    pending.clear();
    for (const [id, b] of items) {
      const inc = {};
      for (const [k, v] of Object.entries(b.inc)) inc[`c.${k}`] = v;
      const upd = { $setOnInsert: { at: new Date(`${id}:00:00Z`) }, $max: { peak: b.peak || 0 } };
      if (Object.keys(inc).length) upd.$inc = inc;
      await Stat.updateOne({ _id: id }, upd, { upsert: true }).catch((e) => console.error("stat flush:", e.message));
    }
  }

  /* ───────── Logs ring buffer (owner ke liye) ───────── */
  const ring = [];
  const redact = (s) => s.replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, "mongodb$1://***@").replace(/\b[a-f0-9]{40,}\b/gi, "***");
  for (const lvl of ["log", "warn", "error"]) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => { try { ring.push({ t: Date.now(), level: lvl, msg: redact(util.format(...a)).slice(0, 500) }); if (ring.length > 300) ring.shift(); } catch {} orig(...a); };
  }

  /* ───────── Session / auth middleware ───────── */
  const cookieOpts = { httpOnly: true, sameSite: "strict", secure: IS_PROD, path: P };

  async function loadSession(req) {
    const tok = cookie.parse(req.headers.cookie || "")[COOKIE];
    if (!tok || tok.length > 128) return null;
    const s = await AdminSession.findOne({ tokenHash: sha(tok) });
    if (!s) return null;
    const now = Date.now();
    const bad = s.expiresAt.getTime() <= now || s.lastActive.getTime() + IDLE_MS < now || s.uaHash !== sha(req.headers["user-agent"] || "");
    const a = bad ? null : await Admin.findById(s.adminId);
    if (bad || !a || a.disabled) { await AdminSession.deleteOne({ _id: s._id }); return null; }
    if (now - s.lastActive.getTime() > 20000) { s.lastActive = new Date(now); await AdminSession.updateOne({ _id: s._id }, { lastActive: s.lastActive }); }
    return { s, a };
  }

  const ipGate = (req, res, next) => (IPS.size && !IPS.has(ipOf(req)) ? notFound(res) : next());
  const sameOrigin = (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };

  const auth = wrap(async (req, res, next) => {
    const r = await loadSession(req);
    if (!r) return notFound(res);               // login ke bina panel ka pata hi nahi chalta (404)
    req.adm = r.a; req.asess = r.s;
    next();
  });
  const csrf = (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    return safeEq(req.headers["x-csrf"] || "", req.asess.csrf) ? next() : res.status(403).json({ error: "CSRF check fail." });
  };
  const isLimited = (a) => a.mustChangePassword || !a.totpEnabled;
  const full = (req, res, next) => (isLimited(req.adm) ? res.status(403).json({ error: "Pehle password badlo aur 2FA setup karo.", limited: true }) : next());
  const need = (perm, opts = {}) => (req, res, next) => {
    if (!can(req.adm.role, perm)) return res.status(403).json({ error: "Tumhare role ko ye permission nahi hai." });
    if (opts.reauth && !(req.asess.reauthUntil && req.asess.reauthUntil > new Date())) return res.status(428).json({ error: "Ye kaam karne ke liye dobara password daalo.", reauth: true });
    next();
  };

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.ADMIN_RATE_LIMIT) || 15, standardHeaders: true, legacyHeaders: false, message: { error: "Bahut zyada koshish. Thodi der baad try karo." } });

  const actionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "Bahut zyada koshish. Thodi der baad try karo." } });

  /* ───────── Router ───────── */
  const api = express.Router();
  api.use(ipGate);
  api.use(express.json({ limit: "32kb" }));
  api.use((req, res, next) => (req.method !== "GET" && !sameOrigin(req) ? res.status(403).json({ error: "Forbidden" }) : next()));
  api.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  async function startSession(req, res, a) {
    const token = crypto.randomBytes(32).toString("hex"), now = Date.now();
    await AdminSession.deleteMany({ adminId: a._id });   // ek admin = ek active session
    await AdminSession.create({
      tokenHash: sha(token), adminId: a._id, csrf: crypto.randomBytes(24).toString("hex"), ip: ipOf(req), uaHash: sha(req.headers["user-agent"] || ""),
      createdAt: new Date(now), lastActive: new Date(now), reauthUntil: new Date(now + REAUTH_MS), expiresAt: new Date(now + ABS_MS),
    });
    res.cookie(COOKIE, token, cookieOpts);   // session cookie (browser band hote hi chali jati hai)
  }

  async function registerFail(a, req, kind) {
    const failed = a.failedAttempts + 1;
    const locked = failed >= MAX_FAILED;
    await Admin.updateOne({ _id: a._id }, locked ? { failedAttempts: 0, lockUntil: new Date(Date.now() + LOCK_MIN * 60000) } : { failedAttempts: failed });
    await audit({ ip: req.ip, adm: null }, locked ? "login_locked" : "login_failed", a.username, { kind, admin: a.username });
    if (locked) alert("danger", "🔒 Admin account lock hua", `**${a.username}** par ${MAX_FAILED} galat koshish (${kind}). IP: ${ipOf(req)}. ${LOCK_MIN} min ke liye lock.`);
    else if (failed >= 3) alert("warn", "⚠️ Admin login galat", `**${a.username}** par ${failed} galat koshish (${kind}). IP: ${ipOf(req)}`);
  }

  // Login page ko kya dikhana hai (setup ya login). Kuch secret nahi batata.
  api.get("/state", wrap(async (req, res) => {
    const r = await loadSession(req);
    const needsSetup = SETUP_KEY.length >= 20 && (await Admin.countDocuments()) === 0;
    res.json({ authed: !!r, setup: needsSetup });
  }));

  api.post("/setup", loginLimiter, wrap(async (req, res) => {
    const { setupKey, username, password } = req.body || {};
    if (SETUP_KEY.length < 20 || (await Admin.countDocuments()) > 0) return notFound(res);
    if (typeof setupKey !== "string" || !safeEq(sha(setupKey), sha(SETUP_KEY))) { alert("danger", "🚨 Admin setup key galat", `Galat setup key daali gayi. IP: ${ipOf(req)}`); return res.status(401).json({ error: "Setup key galat hai." }); }
    const uname = String(username || "").trim();
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(uname)) return res.status(400).json({ error: "Username 3-24 characters (letters, numbers, . _ -)." });
    const pe = pwError(password, uname);
    if (pe) return res.status(400).json({ error: pe });
    let a;
    try {
      a = await Admin.create({ username: uname, usernameLower: uname.toLowerCase(), passHash: await bcrypt.hash(password, 12), role: "owner", ownerSlot: "primary", createdBy: "setup" });
    } catch (e) { if (e.code === 11000) return notFound(res); throw e; }
    req.adm = a;
    await audit(req, "setup_owner", a.username);
    alert("info", "🛡️ Admin panel setup hua", `Owner **${a.username}** banaya gaya. IP: ${ipOf(req)}`);
    await startSession(req, res, a);
    res.json({ ok: true });
  }));

  api.post("/login", loginLimiter, wrap(async (req, res) => {
    const { username, password, code } = req.body || {};
    if (typeof username !== "string" || typeof password !== "string" || password.length > 200 || username.length > 40) return res.status(400).json({ error: "Details galat hain." });
    const GENERIC = "Username, password ya 2FA code galat hai.";
    const a = await Admin.findOne({ usernameLower: username.trim().toLowerCase() });
    const ok = await bcrypt.compare(password, a ? a.passHash : DUMMY);     // hamesha compare: timing se pata na chale
    if (!a || a.disabled) { await audit({ ip: req.ip, adm: null }, "login_failed", clean(username, 30).replace(/[^\w.-]/g, "?"), { kind: "unknown", admin: "-" }); return res.status(401).json({ error: GENERIC }); }
    if (a.lockUntil && a.lockUntil > new Date()) return res.status(429).json({ error: "Zyada galat koshish hui. Kuch der baad try karo." });
    if (!ok) { await registerFail(a, req, "password"); return res.status(401).json({ error: GENERIC }); }

    const upd = { failedAttempts: 0, lockUntil: null };
    if (a.totpEnabled) {
      const c = String(code || "").replace(/\s/g, "");
      let good = false;
      if (/^\d{6}$/.test(c)) {
        const step = totp.verify(dec(a.totpSecretEnc), c, a.lastTotpStep || 0);
        if (step) { good = true; upd.lastTotpStep = step; }
      } else if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(c)) {
        const h = sha(c.replace("-", "").toLowerCase());
        const idx = a.recovery.findIndex((r) => !r.used && r.h === h);
        if (idx >= 0) { good = true; upd[`recovery.${idx}.used`] = true; alert("warn", "🔑 Recovery code use hua", `**${a.username}** ne recovery code se login kiya. IP: ${ipOf(req)}`); }
      }
      if (!good) { await registerFail(a, req, "2fa"); return res.status(401).json({ error: GENERIC }); }
    }
    const ip = ipOf(req), isNew = !a.knownIps.includes(ip);
    if (isNew) upd.knownIps = [ip, ...a.knownIps].slice(0, 10);
    Object.assign(upd, { lastLoginAt: new Date(), lastLoginIp: ip });
    await Admin.updateOne({ _id: a._id }, upd);
    req.adm = a;
    await audit(req, "login", a.username, { newIp: isNew });
    alert(isNew ? "warn" : "info", isNew ? "🆕 Naye IP se admin login" : "🔐 Admin login", `**${a.username}** (${a.role}) login hua. IP: ${ip}${isNew ? " (pehle is IP se nahi aaya tha)" : ""}`);
    await startSession(req, res, a);
    res.json({ ok: true });
  }));

  api.post("/logout", wrap(async (req, res) => {
    const tok = cookie.parse(req.headers.cookie || "")[COOKIE];
    if (tok) {
      const r = await loadSession(req);
      if (r) { req.adm = r.a; if (safeEq(req.headers["x-csrf"] || "", r.s.csrf)) { await audit(req, "logout", r.a.username); await AdminSession.deleteOne({ _id: r.s._id }); } }
    }
    res.clearCookie(COOKIE, { path: P }).json({ ok: true });
  }));

  /* ---- yahan se login zaroori hai (bina login ke 404) ---- */
  api.use(auth, csrf);

  api.get("/me", (req, res) => {
    const a = req.adm;
    res.json({
      username: a.username, role: a.role, perms: [...ROLE_PERMS[a.role]], csrf: req.asess.csrf,
      mustChangePassword: a.mustChangePassword, totpEnabled: a.totpEnabled, limited: isLimited(a),
      reauthUntil: req.asess.reauthUntil, idleMinutes: IDLE_MS / 60000, lastLoginAt: a.lastLoginAt, lastLoginIp: a.lastLoginIp,
      rooms: ROOMS.map((r) => ({ id: r.id, name: r.name })),
    });
  });

  api.post("/password", actionLimiter, wrap(async (req, res) => {
    const { current, next } = req.body || {};
    const a = req.adm;
    if (typeof current !== "string" || !(await bcrypt.compare(current, a.passHash))) { await registerFail(a, req, "password-change"); return res.status(401).json({ error: "Purana password galat hai." }); }
    const pe = pwError(next, a.username);
    if (pe) return res.status(400).json({ error: pe });
    if (next === current) return res.status(400).json({ error: "Naya password purane se alag rakho." });
    await Admin.updateOne({ _id: a._id }, { passHash: await bcrypt.hash(next, 12), mustChangePassword: false, failedAttempts: 0 });
    await audit(req, "password_change", a.username);
    alert("info", "🔑 Admin password badla", `**${a.username}** ne apna password badla.`);
    res.json({ ok: true });
  }));

  api.post("/2fa/setup", wrap(async (req, res) => {
    const a = req.adm;
    if (a.totpEnabled) return res.status(400).json({ error: "2FA pehle se chalu hai." });
    const secret = totp.newSecret();
    await Admin.updateOne({ _id: a._id }, { totpPendingEnc: enc(secret) });
    const uri = `otpauth://totp/${encodeURIComponent("Chatroom Admin:" + a.username)}?secret=${secret}&issuer=${encodeURIComponent("Chatroom Admin")}&algorithm=SHA1&digits=6&period=30`;
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  }));

  api.post("/2fa/confirm", actionLimiter, wrap(async (req, res) => {
    const a = req.adm;
    if (a.totpEnabled || !a.totpPendingEnc) return res.status(400).json({ error: "Pehle 2FA setup shuru karo." });
    const step = totp.verify(dec(a.totpPendingEnc), String(req.body?.code || "").replace(/\s/g, ""), 0);
    if (!step) return res.status(400).json({ error: "Code galat hai. Authenticator app ka abhi wala code daalo." });
    const codes = Array.from({ length: 8 }, () => { const h = crypto.randomBytes(5).toString("hex"); return `${h.slice(0, 5)}-${h.slice(5)}`; });
    await Admin.updateOne({ _id: a._id }, { totpSecretEnc: a.totpPendingEnc, totpPendingEnc: "", totpEnabled: true, lastTotpStep: step, recovery: codes.map((c) => ({ h: sha(c.replace("-", "")), used: false })) });
    await audit(req, "2fa_enabled", a.username);
    alert("info", "🛡️ 2FA chalu hua", `**${a.username}** ne 2FA chalu kiya.`);
    res.json({ ok: true, recoveryCodes: codes });   // sirf ek baar dikhte hain
  }));

  api.post("/reauth", actionLimiter, wrap(async (req, res) => {
    const a = req.adm;
    if (typeof req.body?.password !== "string" || !(await bcrypt.compare(req.body.password, a.passHash))) { await registerFail(a, req, "reauth"); return res.status(401).json({ error: "Password galat hai." }); }
    const until = new Date(Date.now() + REAUTH_MS);
    await AdminSession.updateOne({ _id: req.asess._id }, { reauthUntil: until });
    res.json({ ok: true, reauthUntil: until });
  }));

  /* ---- yahan se neeche sab features (password badla ho aur 2FA chalu ho tabhi) ---- */
  api.use(full);

  require("./admin-features")({ api, ctx, helpers: { Admin, AdminSession, AuditLog, Note, Stat, AuditLogModel: AuditLog, can, need, audit, alert, bump, flush, ring, clean, esc, nameOk, ipOf, sha, pwError, onlineSet, ROLE_PERMS, REAUTH_MS, enc, dec }, models: { User, Session, Message, DM, Report, Appeal } });

  /* ───────── Pages ───────── */
  const dir = path.join(__dirname, "admin");
  const html = () => fs.readFileSync(path.join(dir, "index.html"), "utf8").replace(/\{\{P\}\}/g, P);
  const guard = (req, res, next) => { res.set({ "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "no-store" }); next(); };
  app.get(P, ipGate, guard, (req, res) => res.type("html").send(html()));
  app.get(`${P}/assets/:file`, ipGate, guard, (req, res) => {
    if (!["admin.js", "admin.css"].includes(req.params.file)) return notFound(res);
    res.sendFile(path.join(dir, req.params.file));
  });
  app.use(`${P}/api`, api);

  /* ───────── Start ───────── */
  async function init() {
    await Promise.all([Admin.init(), AdminSession.init(), AuditLog.init(), Note.init(), Stat.init()]);
    setInterval(samplePeak, 60 * 1000).unref();
    setInterval(flush, 30 * 1000).unref();
    const n = await Admin.countDocuments();
    if (n) console.log(`🛡️ Admin panel: ${P}  (${n} admin account)`);
    else if (SETUP_KEY.length >= 20) console.log(`🛡️ Admin panel setup ke liye kholo: ${P}  (ADMIN_SETUP_KEY se pehla owner banao)`);
    else console.log("⚠️  Koi admin account nahi hai. Render me ADMIN_SETUP_KEY (20+ characters) daalo, phir panel me jao.");
    if (IPS.size) console.log(`🔒 Admin panel sirf in IP se khulega: ${[...IPS].join(", ")}`);
  }

  async function onReport(target, reporter) {
    try {
      const since = new Date(Date.now() - 86400000);
      const reps = await Report.find({ target: new RegExp(`^${esc(target)}$`, "i"), createdAt: { $gte: since } }).select("reporter").lean();
      const distinct = new Set(reps.map((r) => r.reporter));
      onReport.last = onReport.last || new Map();
      if (distinct.size >= 3 && Date.now() - (onReport.last.get(target.toLowerCase()) || 0) > 3600000) {
        onReport.last.set(target.toLowerCase(), Date.now());
        alert("warn", "🚩 Auto-flag: bahut reports", `**${target}** ko pichle 24 ghante me ${distinct.size} alag users ne report kiya.`);
      }
    } catch (e) { console.error("onReport:", e.message); }
  }

  // Discord bot ke kaam bhi audit log me aate hain (admin = "discord-bot")
  const auditBot = (action, target, details = {}) => AuditLog.create({ admin: "discord-bot", role: "bot", action, target: String(target || "").slice(0, 60), details, ip: "discord" }).catch((e) => console.error("auditBot:", e.message));

  return { init, bump, alert, auditBot, onReport, flush, _models: { Admin, AdminSession, AuditLog, Stat } };
}

module.exports = { mount, adminPath, can, ROLE_PERMS };
