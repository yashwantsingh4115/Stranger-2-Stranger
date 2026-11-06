"use strict";
require("dotenv").config();

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const cookie = require("cookie");
const { Server } = require("socket.io");
const { moderate } = require("./filter");

/* ───────────────────────── Config ───────────────────────── */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const MONGO_URI = process.env.MONGO_URI;
const PEPPER = process.env.DOB_PEPPER || "";
const MIN_AGE = Number(process.env.MIN_AGE) || 18;
const MESSAGE_TTL_DAYS = Number(process.env.MESSAGE_TTL_DAYS ?? 30);
const ADMINS = new Set((process.env.ADMIN_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

const SESSION_DAYS = 7;
const COOKIE_NAME = "sid";
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const MAX_MSG_LEN = 500;
const HISTORY_LIMIT = 50;
const RESERVED = ["admin", "administrator", "moderator", "mod", "system", "support", "root", "owner", "staff", "everyone", "stranger", "null", "undefined"];
const REASONS = ["Spam", "Abuse / Harassment", "Sexual content", "Underage user", "Other"];
const GENDERS = ["", "male", "female", "other"];

const ROOMS = [
  { id: "general", name: "General" },
  { id: "hindi", name: "Hindi Chat" },
  { id: "friends", name: "Make Friends" },
  { id: "gaming", name: "Gaming" },
  { id: "music", name: "Music" },
  { id: "movies", name: "Movies & Series" },
  { id: "tech", name: "Tech" },
  { id: "study", name: "Study" },
];
const ROOM_IDS = new Set(ROOMS.map((r) => r.id));

if (!MONGO_URI) { console.error("❌ MONGO_URI missing hai. .env file banao (.env.example dekho)."); process.exit(1); }
if (IS_PROD && PEPPER.length < 16) { console.error("❌ Production me DOB_PEPPER (kam se kam 16 characters) set karna zaroori hai."); process.exit(1); }

/* ───────────────────────── Models ───────────────────────── */
const ttl = (schema) => {
  if (MESSAGE_TTL_DAYS > 0) schema.index({ createdAt: 1 }, { expireAfterSeconds: MESSAGE_TTL_DAYS * 86400 });
};

const User = mongoose.model("User", new mongoose.Schema({
  username: { type: String, required: true },
  usernameLower: { type: String, required: true, unique: true },
  dobHash: { type: String, required: true },
  gender: { type: String, enum: GENDERS, default: "" },
  country: { type: String, default: "", maxlength: 30 },
  blocked: { type: [String], default: [] },
  banned: { type: Boolean, default: false },
  banReason: { type: String, default: "" },
  failedAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
}));

const Session = mongoose.model("Session", new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  usernameLower: { type: String, required: true, index: true },
  username: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}));

const msgSchema = new mongoose.Schema({
  room: { type: String, required: true },
  username: { type: String, required: true },
  text: { type: String, required: true, maxlength: MAX_MSG_LEN },
  createdAt: { type: Date, default: Date.now },
});
msgSchema.index({ room: 1, createdAt: -1 });
ttl(msgSchema);
const Message = mongoose.model("Message", msgSchema);

const dmSchema = new mongoose.Schema({
  fromLower: { type: String, required: true }, toLower: { type: String, required: true },
  from: { type: String, required: true }, to: { type: String, required: true },
  text: { type: String, required: true, maxlength: MAX_MSG_LEN },
  createdAt: { type: Date, default: Date.now },
});
dmSchema.index({ fromLower: 1, toLower: 1, createdAt: -1 });
dmSchema.index({ toLower: 1, createdAt: -1 });
ttl(dmSchema);
const DM = mongoose.model("DM", dmSchema);

const Report = mongoose.model("Report", new mongoose.Schema({
  reporter: String, target: String,
  where: { type: String, enum: ["room", "dm", "random"] },
  reason: String,
  context: [{ _id: false, from: String, text: String }],
  status: { type: String, default: "open" },     // open | actioned | dismissed
  createdAt: { type: Date, default: Date.now },
}));

/* ───────────────────────── Helpers ───────────────────────── */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const dobSecret = (lower, dob) => crypto.createHmac("sha256", PEPPER).update(`${lower}|${dob}`).digest("hex");
const reply = (ack, obj) => { if (typeof ack === "function") ack(obj); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error(e.message); res.status(500).json({ error: "Server error. Dobara try karo." }); });

function validateUsername(raw) {
  if (typeof raw !== "string") return "Username galat hai.";
  const u = raw.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return "Username 3-20 characters ka hona chahiye (sirf letters, numbers aur _).";
  if (RESERVED.includes(u.toLowerCase())) return "Ye username allowed nahi hai.";
  return null;
}

function validateDob(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "DOB sahi format me daalo.";
  const [y, m, d] = raw.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return "Ye DOB valid date nahi hai.";
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)) age--;
  if (age < 0 || age > 120) return "Ye DOB valid nahi hai.";
  if (age < MIN_AGE) return `Is chatroom ke liye kam se kam ${MIN_AGE} saal ka hona zaroori hai.`;
  return null;
}

function cleanMessage(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return !t || t.length > MAX_MSG_LEN ? null : t;
}

const cleanInterest = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097F ]/g, "").trim().slice(0, 20);

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

/* ───────────────────────── App ───────────────────────── */
const app = express();
const server = http.createServer(app);
app.disable("x-powered-by");
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== "0") app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"], "script-src": ["'self'"], "style-src": ["'self'"],
      "img-src": ["'self'", "data:"], "connect-src": ["'self'", "ws:", "wss:"],
      "object-src": ["'none'"], "frame-ancestors": ["'none'"],
      "upgrade-insecure-requests": IS_PROD ? [] : null,
    },
  },
}));
app.use(express.json({ limit: "2kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: IS_PROD ? "1h" : 0 }));
app.use("/api", (req, res, next) => (req.method !== "GET" && !sameOrigin(req) ? res.status(403).json({ error: "Forbidden" }) : next()));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Bahut zyada koshish ho gayi. Thodi der baad try karo." },
});

async function getSession(token) {
  if (!token || typeof token !== "string" || token.length > 128) return null;
  return Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
}

const requireAuth = wrap(async (req, res, next) => {
  const s = await getSession(cookie.parse(req.headers.cookie || "")[COOKIE_NAME]);
  if (!s) return res.status(401).json({ error: "Not logged in" });
  req.sess = s;
  next();
});
const requireAdmin = (req, res, next) => (ADMINS.has(req.sess.usernameLower) ? next() : res.status(403).json({ error: "Forbidden" }));

function kickUser(lower, msg) {
  io.in(`user:${lower}`).emit("kicked", msg);
  io.in(`user:${lower}`).disconnectSockets(true);
}

/* ───────────────────────── Auth routes ───────────────────────── */
app.post("/api/login", loginLimiter, wrap(async (req, res) => {
  const { username, dob, agree } = req.body || {};
  const err = validateUsername(username) || validateDob(dob);
  if (err) return res.status(400).json({ error: err });
  if (agree !== true) return res.status(400).json({ error: `Rules accept karna aur ${MIN_AGE}+ confirm karna zaroori hai.` });

  const name = username.trim();
  const lower = name.toLowerCase();
  const TAKEN = "Ye username pehle se kisi aur ka hai ya DOB galat hai.";
  let user = await User.findOne({ usernameLower: lower });

  if (!user) {
    try {
      const dobHash = await bcrypt.hash(dobSecret(lower, dob), 12);
      user = await User.create({ username: name, usernameLower: lower, dobHash });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: TAKEN });
      throw e;
    }
  } else {
    if (user.lockUntil && user.lockUntil > new Date()) {
      return res.status(429).json({ error: `Bahut galat koshish. ${Math.ceil((user.lockUntil - new Date()) / 60000)} minute baad try karo.` });
    }
    if (!(await bcrypt.compare(dobSecret(lower, dob), user.dobHash))) {
      const failed = user.failedAttempts + 1;
      await User.updateOne({ _id: user._id }, failed >= MAX_FAILED
        ? { failedAttempts: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedAttempts: failed });
      return res.status(401).json({ error: TAKEN });
    }
    if (user.banned) return res.status(403).json({ error: "Ye account ban kar diya gaya hai." });
    await User.updateOne({ _id: user._id }, { failedAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
  }

  await Session.deleteMany({ usernameLower: lower });
  kickUser(lower, "Tumne dusri jagah se login kiya hai.");
  const token = crypto.randomBytes(32).toString("hex");
  await Session.create({ tokenHash: sha256(token), usernameLower: lower, username: user.username, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) });
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "strict", secure: IS_PROD, path: "/", maxAge: SESSION_DAYS * 86400000 });
  res.json({ ok: true });
}));

app.get("/api/me", requireAuth, wrap(async (req, res) => {
  const u = await User.findOne({ usernameLower: req.sess.usernameLower }).select("username gender country blocked banned").lean();
  if (!u || u.banned) return res.status(401).json({ error: "Not logged in" });
  res.set("Cache-Control", "no-store").json({
    username: u.username, gender: u.gender, country: u.country, blocked: u.blocked,
    isAdmin: ADMINS.has(req.sess.usernameLower), rooms: ROOMS, minAge: MIN_AGE,
  });
}));

app.post("/api/profile", requireAuth, wrap(async (req, res) => {
  const gender = String((req.body || {}).gender || "");
  if (!GENDERS.includes(gender)) return res.status(400).json({ error: "Gender galat hai." });
  const country = String((req.body || {}).country || "").replace(/[^\p{L}\s.'-]/gu, "").trim().slice(0, 30);
  const lower = req.sess.usernameLower;
  await User.updateOne({ usernameLower: lower }, { gender, country });
  for (const [, s] of io.sockets.sockets) if (s.data.lower === lower) { s.data.gender = gender; s.data.country = country; }
  res.json({ ok: true, gender, country });
}));

app.post("/api/logout", wrap(async (req, res) => {
  const token = cookie.parse(req.headers.cookie || "")[COOKIE_NAME];
  if (token) {
    const h = sha256(token);
    await Session.deleteOne({ tokenHash: h }).catch(() => {});
    for (const [, s] of io.sockets.sockets) if (s.data.tokenHash === h) s.disconnect(true);
  }
  res.clearCookie(COOKIE_NAME, { path: "/" }).json({ ok: true });
}));

/* ───────────────────────── Admin routes ───────────────────────── */
app.get("/api/admin/reports", requireAuth, requireAdmin, wrap(async (req, res) => {
  const [reports, banned] = await Promise.all([
    Report.find({ status: "open" }).sort({ createdAt: -1 }).limit(100).lean(),
    User.find({ banned: true }).select("username banReason").lean(),
  ]);
  res.json({ reports, banned });
}));

async function banUser(lowerRaw, reason) {
  const lower = String(lowerRaw || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(lower) || ADMINS.has(lower)) return { status: 400, error: "Is user ko ban nahi kar sakte." };
  const r = await User.updateOne({ usernameLower: lower }, { banned: true, banReason: String(reason || "").slice(0, 200) });
  if (!r.matchedCount) return { status: 404, error: "User nahi mila." };
  await Session.deleteMany({ usernameLower: lower });
  kickUser(lower, "Tumhara account ban kar diya gaya hai.");
  await Report.updateMany({ target: new RegExp(`^${lower}$`, "i"), status: "open" }, { status: "actioned" });
  return { ok: true };
}

app.post("/api/admin/ban", requireAuth, requireAdmin, wrap(async (req, res) => {
  const r = await banUser((req.body || {}).username, (req.body || {}).reason);
  res.status(r.status || 200).json(r.error ? { error: r.error } : { ok: true });
}));

app.post("/api/admin/unban", requireAuth, requireAdmin, wrap(async (req, res) => {
  await User.updateOne({ usernameLower: String((req.body || {}).username || "").trim().toLowerCase() }, { banned: false, banReason: "" });
  res.json({ ok: true });
}));

app.post("/api/admin/dismiss", requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = String((req.body || {}).id || "");
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Bad id" });
  await Report.updateOne({ _id: id }, { status: "dismissed" });
  res.json({ ok: true });
}));

/* ───────────────────────── Health + Bot API (Discord bot) ───────────────────────── */
app.get("/health", (req, res) => {
  const db = mongoose.connection.readyState === 1;
  res.status(db ? 200 : 503).json({ ok: db });
});

const BOT_KEY = process.env.BOT_API_KEY || "";
const BOT_ENABLED = BOT_KEY.length >= 24;
const BOT_KEY_DIGEST = Buffer.from(sha256(BOT_KEY));
const bot = express.Router();
bot.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
bot.use((req, res, next) => {
  if (!BOT_ENABLED) return res.status(404).json({ error: "Not found" });
  const h = String(req.headers.authorization || "");
  const given = Buffer.from(sha256(h.startsWith("Bearer ") ? h.slice(7) : ""));
  if (!crypto.timingSafeEqual(given, BOT_KEY_DIGEST)) return res.status(401).json({ error: "Unauthorized" });
  next();
});
const lowerName = (v) => String(v || "").trim().toLowerCase();
const validName = (l) => /^[a-z0-9_]{3,20}$/.test(l);

bot.get("/stats", wrap(async (req, res) => {
  const since = new Date(Date.now() - 86400000);
  const [totalUsers, newUsers24h, messages24h, dms24h, openReports, banned] = await Promise.all([
    User.countDocuments(), User.countDocuments({ createdAt: { $gte: since } }),
    Message.countDocuments({ createdAt: { $gte: since } }), DM.countDocuments({ createdAt: { $gte: since } }),
    Report.countDocuments({ status: "open" }), User.countDocuments({ banned: true }),
  ]);
  const names = new Set();
  for (const [, s] of io.sockets.sockets) names.add(s.data.lower);
  const rooms = {};
  for (const r of ROOMS) rooms[r.name] = io.sockets.adapter.rooms.get(`room:${r.id}`)?.size || 0;
  res.json({ online: names.size, rooms, randomQueue: queue.length, totalUsers, newUsers24h, messages24h, dms24h, openReports, banned, uptimeSec: Math.round(process.uptime()) });
}));

bot.get("/online", (req, res) => {
  const m = new Map();
  for (const [, s] of io.sockets.sockets) m.set(s.data.lower, { username: s.data.username, room: s.data.room });
  res.json({ users: [...m.values()] });
});

bot.get("/reports", wrap(async (req, res) => {
  const q = { status: "open" };
  if (req.query.since) { const d = new Date(String(req.query.since)); if (!isNaN(d)) q.createdAt = { $gt: d }; }
  res.json({ reports: await Report.find(q).sort({ createdAt: 1 }).limit(25).lean() });
}));

bot.get("/user/:name", wrap(async (req, res) => {
  const lower = lowerName(req.params.name);
  if (!validName(lower)) return res.status(400).json({ error: "Username galat hai." });
  const u = await User.findOne({ usernameLower: lower }).lean();
  if (!u) return res.status(404).json({ error: "User nahi mila." });
  const nameRe = new RegExp(`^${lower}$`, "i");
  const [reportsAgainst, reportsBy] = await Promise.all([Report.countDocuments({ target: nameRe }), Report.countDocuments({ reporter: nameRe })]);
  const online = [...io.sockets.sockets.values()].some((s) => s.data.lower === lower);
  res.json({
    username: u.username, gender: u.gender, country: u.country, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    banned: u.banned, banReason: u.banReason, blockedCount: u.blocked.length, reportsAgainst, reportsBy, online,
    isAdmin: ADMINS.has(lower),
  });
}));

bot.post("/ban", wrap(async (req, res) => {
  const r = await banUser((req.body || {}).username, (req.body || {}).reason);
  res.status(r.status || 200).json(r.error ? { error: r.error } : { ok: true });
}));

bot.post("/unban", wrap(async (req, res) => {
  const lower = lowerName((req.body || {}).username);
  if (!validName(lower)) return res.status(400).json({ error: "Username galat hai." });
  const r = await User.updateOne({ usernameLower: lower }, { banned: false, banReason: "" });
  if (!r.matchedCount) return res.status(404).json({ error: "User nahi mila." });
  res.json({ ok: true });
}));

bot.post("/kick", wrap(async (req, res) => {
  const lower = lowerName((req.body || {}).username);
  if (!validName(lower) || ADMINS.has(lower)) return res.status(400).json({ error: "Is user ko kick nahi kar sakte." });
  await Session.deleteMany({ usernameLower: lower });
  kickUser(lower, "Admin ne tumhe logout kar diya hai. Dobara login kar sakte ho.");
  res.json({ ok: true });
}));

bot.post("/dismiss", wrap(async (req, res) => {
  const id = String((req.body || {}).id || "");
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Bad id" });
  await Report.updateOne({ _id: id }, { status: "dismissed" });
  res.json({ ok: true });
}));

bot.post("/announce", wrap(async (req, res) => {
  const text = cleanMessage(String((req.body || {}).text || ""));
  const room = String((req.body || {}).room || "all");
  if (!text || text.length > 200) return res.status(400).json({ error: "Announcement 1-200 characters ki honi chahiye." });
  if (room !== "all" && !ROOM_IDS.has(room)) return res.status(400).json({ error: "Room galat hai." });
  (room === "all" ? io : io.to(`room:${room}`)).emit("announce", { text });
  res.json({ ok: true });
}));

app.use("/api/bot", bot);

/* ───────────────────────── Socket.IO ───────────────────────── */
const io = new Server(server, { maxHttpBufferSize: 4 * 1024, cors: { origin: false } });

io.use(async (socket, next) => {
  try {
    const origin = socket.handshake.headers.origin;
    if (origin && new URL(origin).host !== socket.handshake.headers.host) return next(new Error("forbidden"));
    const token = cookie.parse(socket.handshake.headers.cookie || "")[COOKIE_NAME];
    const s = await getSession(token);
    if (!s) return next(new Error("unauthorized"));
    const u = await User.findOne({ usernameLower: s.usernameLower }).select("gender country blocked banned").lean();
    if (!u || u.banned) return next(new Error("unauthorized"));
    socket.data = {
      username: s.username, lower: s.usernameLower, tokenHash: sha256(token),
      gender: u.gender, country: u.country, blocked: new Set(u.blocked),
      room: null, hits: [], lastText: "", lastAt: 0, lastReport: 0,
      partner: null, convo: null, lastPartner: null, interest: "",
    };
    next();
  } catch { next(new Error("unauthorized")); }
});

/* ---- helpers for sockets ---- */
function allow(s) {
  const n = Date.now();
  s.data.hits = s.data.hits.filter((t) => n - t < 5000);
  if (s.data.hits.length >= 5) return false;
  s.data.hits.push(n);
  return true;
}

function prepare(s, raw) {
  if (!allow(s)) return { error: "Thoda dheere bhejo." };
  const clean = cleanMessage(raw);
  if (!clean) return { error: `Message khali hai ya ${MAX_MSG_LEN} characters se zyada hai.` };
  const now = Date.now();
  if (clean === s.data.lastText && now - s.data.lastAt < 10000) return { error: "Same message baar-baar mat bhejo." };
  s.data.lastText = clean; s.data.lastAt = now;
  return { text: moderate(clean) };
}

async function broadcastRoom(id) {
  const socks = await io.in(`room:${id}`).fetchSockets();
  const seen = new Map();
  for (const s of socks) seen.set(s.data.lower, { username: s.data.username, gender: s.data.gender, country: s.data.country });
  io.to(`room:${id}`).emit("room_users", { room: id, users: [...seen.values()] });
}

let countTimer = null;
function broadcastCounts() {
  if (countTimer) return;
  countTimer = setTimeout(() => {
    countTimer = null;
    const c = {};
    for (const r of ROOMS) c[r.id] = io.sockets.adapter.rooms.get(`room:${r.id}`)?.size || 0;
    io.emit("room_counts", c);
  }, 300);
}

function leaveRoom(socket) {
  const old = socket.data.room;
  if (!old) return;
  socket.leave(`room:${old}`);
  socket.data.room = null;
  broadcastRoom(old);
}

/* ---- random matching ---- */
const queue = [];
const dequeue = (s) => { const i = queue.indexOf(s); if (i >= 0) queue.splice(i, 1); };
const compatible = (a, b) => a.data.lower !== b.data.lower && !a.data.blocked.has(b.data.lower) && !b.data.blocked.has(a.data.lower);

function tryMatch(s) {
  const cand = queue.filter((o) => o !== s && compatible(s, o));
  if (!cand.length) return false;
  const pick = (s.data.interest && cand.find((o) => o.data.interest === s.data.interest)) || cand[0];
  dequeue(pick); dequeue(s);
  const convo = { log: [] };
  s.data.partner = pick; pick.data.partner = s;
  s.data.convo = pick.data.convo = convo;
  const info = (x) => ({ gender: x.data.gender, country: x.data.country });
  s.emit("random_matched", info(pick));
  pick.emit("random_matched", info(s));
  return true;
}

function endRandom(s, notify = true) {
  dequeue(s);
  const p = s.data.partner;
  if (!p) return;
  s.data.lastPartner = p.data.username; p.data.lastPartner = s.data.username;
  s.data.partner = null; p.data.partner = null;
  if (notify) p.emit("random_ended");
}

/* ---- block ---- */
async function doBlock(socket, targetLower, ack) {
  if (!targetLower || targetLower === socket.data.lower) return reply(ack, { error: "Galat user." });
  if (socket.data.blocked.size >= 200) return reply(ack, { error: "Block list full hai." });
  if (!(await User.exists({ usernameLower: targetLower }))) return reply(ack, { error: "User nahi mila." });
  await User.updateOne({ usernameLower: socket.data.lower }, { $addToSet: { blocked: targetLower } });
  socket.data.blocked.add(targetLower);
  if (socket.data.partner?.data.lower === targetLower) endRandom(socket);
  reply(ack, { ok: true, blocked: [...socket.data.blocked] });
}

io.on("connection", (socket) => {
  const { username, lower } = socket.data;
  socket.join(`user:${lower}`);
  socket.emit("room_counts", Object.fromEntries(ROOMS.map((r) => [r.id, io.sockets.adapter.rooms.get(`room:${r.id}`)?.size || 0])));

  /* rooms */
  socket.on("join_room", async (roomId, ack) => {
    if (!ROOM_IDS.has(roomId)) return reply(ack, { error: "Room nahi mila." });
    try {
      leaveRoom(socket);
      socket.join(`room:${roomId}`);
      socket.data.room = roomId;
      const rows = await Message.find({ room: roomId }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).lean();
      reply(ack, { ok: true, history: rows.reverse().map((m) => ({ id: String(m._id), room: m.room, username: m.username, text: m.text, createdAt: m.createdAt })) });
      broadcastRoom(roomId); broadcastCounts();
    } catch (e) { console.error("join_room:", e.message); reply(ack, { error: "Room load nahi hua." }); }
  });

  socket.on("message", async (text, ack) => {
    const room = socket.data.room;
    if (!room) return reply(ack, { error: "Pehle room join karo." });
    const p = prepare(socket, text);
    if (p.error) return reply(ack, p);
    try {
      const m = await Message.create({ room, username, text: p.text });
      io.to(`room:${room}`).emit("message", { id: String(m._id), room, username, text: p.text, createdAt: m.createdAt });
      reply(ack, { ok: true });
    } catch (e) { console.error("message:", e.message); reply(ack, { error: "Message send nahi hua." }); }
  });

  let lastTyping = 0;
  socket.on("typing", () => {
    const n = Date.now();
    if (!socket.data.room || n - lastTyping < 1500) return;
    lastTyping = n;
    socket.to(`room:${socket.data.room}`).emit("typing", { room: socket.data.room, username });
  });

  /* direct messages */
  socket.on("dm_send", async (d, ack) => {
    try {
      const toLower = String(d?.to || "").trim().toLowerCase();
      if (!toLower || toLower === lower) return reply(ack, { error: "Is user ko message nahi bhej sakte." });
      const target = await User.findOne({ usernameLower: toLower }).select("username blocked banned").lean();
      if (!target || target.banned || target.blocked.includes(lower) || socket.data.blocked.has(toLower)) {
        return reply(ack, { error: "Is user ko message nahi bhej sakte." });
      }
      const p = prepare(socket, d.text);
      if (p.error) return reply(ack, p);
      const m = await DM.create({ fromLower: lower, toLower, from: username, to: target.username, text: p.text });
      io.to(`user:${lower}`).to(`user:${toLower}`).emit("dm", { id: String(m._id), from: username, to: target.username, text: p.text, createdAt: m.createdAt });
      reply(ack, { ok: true });
    } catch (e) { console.error("dm_send:", e.message); reply(ack, { error: "Message send nahi hua." }); }
  });

  socket.on("dm_history", async (withName, ack) => {
    try {
      const w = String(withName || "").trim().toLowerCase();
      const rows = await DM.find({ $or: [{ fromLower: lower, toLower: w }, { fromLower: w, toLower: lower }] }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).lean();
      reply(ack, { history: rows.reverse().filter((r) => !socket.data.blocked.has(r.fromLower)).map((r) => ({ id: String(r._id), from: r.from, to: r.to, text: r.text, createdAt: r.createdAt })) });
    } catch (e) { reply(ack, { error: "History load nahi hui." }); }
  });

  socket.on("dm_recent", async (ack) => {
    try {
      const rows = await DM.find({ $or: [{ fromLower: lower }, { toLower: lower }] }).sort({ createdAt: -1 }).limit(200).lean();
      const seen = new Map();
      for (const r of rows) {
        const o = r.fromLower === lower ? { l: r.toLower, n: r.to } : { l: r.fromLower, n: r.from };
        if (!seen.has(o.l) && !socket.data.blocked.has(o.l)) seen.set(o.l, { username: o.n, last: r.text, at: r.createdAt });
      }
      reply(ack, { list: [...seen.values()].slice(0, 30) });
    } catch (e) { reply(ack, { list: [] }); }
  });

  /* random 1-to-1 */
  const startRandom = (interest) => {
    endRandom(socket);
    if (typeof interest === "string") socket.data.interest = cleanInterest(interest);
    queue.push(socket);
    if (!tryMatch(socket)) socket.emit("random_waiting");
  };
  socket.on("random_start", startRandom);
  socket.on("random_next", () => startRandom());
  socket.on("random_stop", () => endRandom(socket));

  socket.on("random_msg", (text, ack) => {
    const partner = socket.data.partner;
    if (!partner) return reply(ack, { error: "Koi stranger connected nahi hai." });
    const p = prepare(socket, text);
    if (p.error) return reply(ack, p);
    const log = socket.data.convo.log;
    log.push({ from: username, text: p.text });
    if (log.length > 30) log.shift();
    partner.emit("random_msg", { text: p.text });
    reply(ack, { ok: true, text: p.text });
  });

  socket.on("random_typing", () => socket.data.partner?.emit("random_typing"));
  socket.on("random_block", async (ack) => {
    const t = (socket.data.partner?.data.username || socket.data.lastPartner || "").toLowerCase();
    await doBlock(socket, t, ack).catch(() => reply(ack, { error: "Block nahi hua." }));
  });

  /* block / report */
  socket.on("block", (name, ack) => doBlock(socket, String(name || "").trim().toLowerCase(), ack).catch(() => reply(ack, { error: "Block nahi hua." })));
  socket.on("unblock", async (name, ack) => {
    try {
      const t = String(name || "").trim().toLowerCase();
      await User.updateOne({ usernameLower: lower }, { $pull: { blocked: t } });
      socket.data.blocked.delete(t);
      reply(ack, { ok: true, blocked: [...socket.data.blocked] });
    } catch { reply(ack, { error: "Unblock nahi hua." }); }
  });

  socket.on("report", async (d, ack) => {
    try {
      if (Date.now() - socket.data.lastReport < 10000) return reply(ack, { error: "Thodi der baad dobara report karo." });
      const where = ["room", "dm", "random"].includes(d?.where) ? d.where : "room";
      const reason = REASONS.includes(d?.reason) ? d.reason : "Other";
      let target = "", context = [];
      if (where === "random") {
        target = socket.data.partner?.data.username || socket.data.lastPartner || "";
        context = (socket.data.convo?.log || []).slice(-20);
      } else {
        const t = await User.findOne({ usernameLower: String(d?.target || "").trim().toLowerCase() }).select("username").lean();
        target = t?.username || "";
        if (where === "dm" && target) {
          const w = target.toLowerCase();
          const rows = await DM.find({ $or: [{ fromLower: lower, toLower: w }, { fromLower: w, toLower: lower }] }).sort({ createdAt: -1 }).limit(10).lean();
          context = rows.reverse().map((r) => ({ from: r.from, text: r.text }));
        } else if (d?.text) context = [{ from: target, text: String(d.text).slice(0, MAX_MSG_LEN) }];
      }
      if (!target || target.toLowerCase() === lower) return reply(ack, { error: "Report nahi ho paya." });
      socket.data.lastReport = Date.now();
      await Report.create({ reporter: username, target, where, reason, context });
      reply(ack, { ok: true });
    } catch (e) { console.error("report:", e.message); reply(ack, { error: "Report nahi ho paya." }); }
  });

  socket.on("disconnect", () => {
    endRandom(socket);
    leaveRoom(socket);
    broadcastCounts();
  });
});

/* ───────────────────────── Start ───────────────────────── */
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(async () => {
    await Promise.all([User.init(), Session.init(), Message.init(), DM.init(), Report.init()]);
    console.log("✅ MongoDB connected");
    if (!ADMINS.size) console.log("ℹ️  ADMIN_USERS set nahi hai, admin panel band rahega.");
    console.log(BOT_ENABLED ? "🤖 Discord Bot API: ON" : "ℹ️  BOT_API_KEY set nahi hai (min 24 chars), Discord Bot API band hai.");
    server.listen(PORT, () => console.log(`🚀 Chatroom running: http://localhost:${PORT}`));
  })
  .catch((e) => { console.error("❌ MongoDB connection failed:", e.message); process.exit(1); });

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
