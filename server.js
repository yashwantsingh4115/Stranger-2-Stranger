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
const { moderate, setExtraWords } = require("./filter");
const bus = require("./bot/bus");
const { parseBridges } = require("./bot/config");

/* ───────────────────────── Config ───────────────────────── */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const MONGO_URI = process.env.MONGO_URI;
const PEPPER = process.env.DOB_PEPPER || "";
const MIN_AGE = Number(process.env.MIN_AGE) || 18;
const MESSAGE_TTL_DAYS = Number(process.env.MESSAGE_TTL_DAYS ?? 0);           // sirf DM ke liye (0 = kabhi delete nahi)
const ROOM_CLEAR_MINUTES = Math.max(1, Number(process.env.ROOM_CLEAR_MINUTES) || 20); // room messages itne minute baad delete
let roomMsgCount = 0; // restart ke baad kitne room messages aaye (stats ke liye)
const ADMIN_PATH = require("./admin").adminPath(); // admin panel ka address (ADMIN_PATH env se badal sakte ho)
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
  { id: "international", name: "International" },
  { id: "indopak", name: "Indo-Pak Dosti" },
  { id: "friends", name: "Make Friends" },
  // { id: "hindi", name: "Hindi Chat" },
  // { id: "gaming", name: "Gaming" },
  // { id: "music", name: "Music" },
  // { id: "movies", name: "Movies & Series" },
  // { id: "tech", name: "Tech" },
  // { id: "study", name: "Study" },
];
const ROOM_IDS = new Set(ROOMS.map((r) => r.id));

// Discord bridge: BRIDGE_CHANNEL_ID wale Discord channel ki chat BRIDGE_ROOM (site ka room) se juda rahegi
const BRIDGES = parseBridges(process.env, ROOMS[0].id).filter((b) => {
  if (!ROOM_IDS.has(b.room)) console.error(`⚠️  Bridge: room "${b.room}" ROOMS me nahi hai, channel ${b.channelId} skip kiya.`);
  return ROOM_IDS.has(b.room);
});
const BRIDGE_ENABLED = BRIDGES.length > 0 && !!process.env.DISCORD_TOKEN;
const ROOM_TO_CHANNEL = new Map(BRIDGES.map((b) => [b.room, b.channelId]));
const CHANNEL_TO_ROOM = new Map(BRIDGES.map((b) => [b.channelId, b.room]));
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
// Link filter: "discord" = sirf Discord se aaye messages ke links hatao (default), "all" = site ke users (admin ko chhodkar) ke bhi, "off" = band
const LINK_MODE = ["discord", "all", "off"].includes(process.env.BLOCK_LINKS) ? process.env.BLOCK_LINKS : "discord";
const DISCORD_ACTIVE_MS = 15 * 60000; // Discord user itni der tak "active" dikhta hai

if (!MONGO_URI) { console.error("❌ MONGO_URI missing hai. .env file banao (.env.example dekho)."); process.exit(1); }
if (IS_PROD && PEPPER.length < 16) { console.error("❌ Production me DOB_PEPPER (kam se kam 16 characters) set karna zaroori hai."); process.exit(1); }

/* ───────────────────────── Models ───────────────────────── */
const ttl = (schema) => {
  if (MESSAGE_TTL_DAYS > 0) schema.index({ createdAt: 1 }, { expireAfterSeconds: MESSAGE_TTL_DAYS * 86400 });
};

const userSchema = new mongoose.Schema({
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
  bannedUntil: { type: Date, default: null },     // temporary ban
  mutedUntil: { type: Date, default: null },      // mute: padh sakta hai, likh nahi sakta
  muteReason: { type: String, default: "" },
  warnings: { type: [{ _id: false, at: Date, by: String, reason: String }], default: [] },
});
userSchema.index({ createdAt: -1 });
// Registered users kabhi delete nahi hone chahiye: code se delete karne ki koshish bhi fail hogi. (Ban sirf flag lagata hai.)
const NO_DELETE = () => { throw new Error("User accounts delete nahi kiye ja sakte."); };
userSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], { document: false, query: true }, NO_DELETE);
userSchema.pre("deleteOne", { document: true, query: false }, NO_DELETE);
const User = mongoose.model("User", userSchema);

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
  src: { type: String, default: "" },          // "discord" = Discord se aaya message
  edited: { type: Boolean, default: false },
  replyTo: { type: new mongoose.Schema({ rid: String, username: String, text: String }, { _id: false }), default: null },
  discordId: { type: String, default: "" },    // Discord message id (bridge ke liye)
  reactions: { type: [{ _id: false, e: String, u: String }], default: [] }, // u = "s:<username>" ya "d:<discordUserId>"
  createdAt: { type: Date, default: Date.now },
});
msgSchema.index({ discordId: 1 });
msgSchema.index({ room: 1, createdAt: -1 });
msgSchema.index({ createdAt: -1 }); // room messages ko TTL index se nahi, neeche ke cleanup timer se delete karte hain
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

// Chhoti settings jo restart ke baad bhi rehni chahiye (bridge on/off, slowmode)
const Setting = mongoose.model("Setting", new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed }));

// Ban ke khilaf appeal (admin panel me dikhti hai)
const Appeal = mongoose.model("Appeal", new mongoose.Schema({
  username: String, usernameLower: { type: String, index: true }, message: String,
  status: { type: String, default: "open" }, decidedBy: String, decisionNote: String, createdAt: { type: Date, default: Date.now },
}));

// Admin panel se badalne wali site settings (restart ke baad bhi rehti hain)
const site = { maintenance: false, readOnly: false, registration: true, minAge: null, banner: "", closedRooms: [], roomNames: {}, autoBanWarnings: 3, extraWords: [] };
const minAge = () => site.minAge || MIN_AGE;
const isBanned = (u) => !!(u && (u.banned || (u.bannedUntil && u.bannedUntil > new Date())));
let adminApi = { bump() {}, alert() {}, auditBot() {}, auditSystem() {}, onReport() {}, init: async () => {} };
let botsApi = { visible: () => [], isBotName: () => false, onMessage: async () => {}, onJoin: async () => {}, init: async () => {} }; // bots.js jud jaane par asli ho jata hai

const Report = mongoose.model("Report", new mongoose.Schema({
  reporter: String, target: String, room: String, msgId: String,
  where: { type: String, enum: ["room", "dm", "random"] },
  reason: String,
  context: [{ _id: false, from: String, text: String }],
  status: { type: String, default: "open" },     // open | actioned | dismissed
  createdAt: { type: Date, default: Date.now },
}));

/* ───────────────────────── Helpers ───────────────────────── */
const roomCutoff = () => new Date(Date.now() - ROOM_CLEAR_MINUTES * 60000);
const strip = (s) => String(s).replace(/\uFE0F/g, "");
const canonEmoji = (e) => REACTIONS.find((r) => strip(r) === strip(e)) || String(e);
function reactionView(list) {
  const m = new Map();
  for (const r of list || []) {
    const x = m.get(r.e) || { e: r.e, s: [], d: 0 };
    if (String(r.u).startsWith("s:")) x.s.push(r.u.slice(2)); else x.d++;
    m.set(r.e, x);
  }
  return [...m.values()];
}
const msgView = (m) => ({
  id: String(m._id), room: m.room, username: m.username, text: m.text, createdAt: m.createdAt, src: m.src || "",
  edited: !!m.edited, replyTo: m.replyTo ? { id: m.replyTo.rid || "", username: m.replyTo.username, text: m.replyTo.text } : null,
  reactions: reactionView(m.reactions),
});
const snip = (t, n = 80) => { const x = String(t || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|in|me|gg|xyz|co|ly|tv|app|dev|info|ru|cc|link|site|online|club|top)\b(?:\/\S*)?/gi;
const maskLinks = (t) => String(t).replace(URL_RE, "[link hata diya]");

/* Chhoti settings: memory me rakhte hain, DB me bhi save */
let bridgeOff = new Set();      // "*" = sab bridge band, warna room ids
let slowmode = {};              // { "*": sec, roomId: sec }
const discordSeen = new Map();  // room -> Map(discordUserId -> {name, at})  (users panel ke liye)
const discordHits = new Map();  // discordUserId -> [timestamps]  (spam rok)
const saveSetting = (key, value) => Setting.updateOne({ key }, { value }, { upsert: true }).catch((e) => console.error("setting:", e.message));
const bridgeActive = (room) => BRIDGE_ENABLED && ROOM_TO_CHANNEL.has(room) && !bridgeOff.has("*") && !bridgeOff.has(room);
const slowFor = (room) => Math.max(0, Number(slowmode[room] !== undefined ? slowmode[room] : slowmode["*"]) || 0);
const bridgeInfo = () => ({ enabled: BRIDGE_ENABLED, channels: BRIDGES.map((b) => ({ room: b.room, channelId: b.channelId, active: bridgeActive(b.room) })) });
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const dobSecret = (lower, dob) => crypto.createHmac("sha256", PEPPER).update(`${lower}|${dob}`).digest("hex");
const roomList = () => ROOMS.map((r) => ({ id: r.id, name: site.roomNames[r.id] || r.name }));
const reply = (ack, obj) => { if (typeof ack === "function") ack(obj); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error(e.message); res.status(500).json({ error: "Server error. Dobara try karo." }); });

function validateUsername(raw) {
  if (typeof raw !== "string") return "Username galat hai.";
  const u = raw.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return "Username 3-20 characters ka hona chahiye (sirf letters, numbers aur _).";
  if (RESERVED.includes(u.toLowerCase()) || botsApi.isBotName(u.toLowerCase())) return "Ye username allowed nahi hai.";
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
  if (age < minAge()) return `Is chatroom ke liye kam se kam ${minAge()} saal ka hona zaroori hai.`;
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
// Render/Railway jaise proxy ke peeche real user IP ke liye zaroori (rate limit sahi chale). Render par apne aap on hota hai.
const TRUST = process.env.TRUST_PROXY || (process.env.RENDER ? "1" : "0");
if (TRUST !== "0") app.set("trust proxy", Number(TRUST) || 1);

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
// Admin panel apna bada JSON limit khud lagata hai
app.use((req, res, next) => (req.path.startsWith(ADMIN_PATH + "/") ? next() : express.json({ limit: "2kb" })(req, res, next)));
// no-cache: browser har baar check karta hai (ETag se), isliye naya deploy turant dikhta hai. Purani/naayi file ka mix nahi banta.
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: 0, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
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
  if (site.maintenance) return res.status(503).json({ error: "🛠️ Site abhi maintenance me hai. Thodi der baad aana." });
  const { username, dob, agree } = req.body || {};
  const err = validateUsername(username) || validateDob(dob);
  if (err) return res.status(400).json({ error: err });
  if (agree !== true) return res.status(400).json({ error: `Rules accept karna aur ${minAge()}+ confirm karna zaroori hai.` });

  const name = username.trim();
  const lower = name.toLowerCase();
  const TAKEN = "Ye username pehle se kisi aur ka hai ya DOB galat hai.";
  let user = await User.findOne({ usernameLower: lower });

  if (!user) {
    if (!site.registration) return res.status(403).json({ error: "Naye registration abhi band hain. Purane users login kar sakte hain." });
    try {
      const dobHash = await bcrypt.hash(dobSecret(lower, dob), 12);
      user = await User.create({ username: name, usernameLower: lower, dobHash });
      adminApi.bump("signups");
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
    if (isBanned(user)) {
      const until = !user.banned && user.bannedUntil ? ` ${user.bannedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC tak` : "";
      return res.status(403).json({ banned: true, error: `Ye account${until} ban hai.${user.banReason ? " Reason: " + user.banReason : ""}` });
    }
    await User.updateOne({ _id: user._id }, { failedAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
  }

  await Session.deleteMany({ usernameLower: lower });
  kickUser(lower, "Tumne dusri jagah se login kiya hai.");
  const token = crypto.randomBytes(32).toString("hex");
  await Session.create({ tokenHash: sha256(token), usernameLower: lower, username: user.username, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) });
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "strict", secure: IS_PROD, path: "/", maxAge: SESSION_DAYS * 86400000 });
  adminApi.bump("logins");
  res.json({ ok: true });
}));

app.get("/api/me", requireAuth, wrap(async (req, res) => {
  const u = await User.findOne({ usernameLower: req.sess.usernameLower }).select("username gender country blocked banned bannedUntil").lean();
  if (!u || isBanned(u)) return res.status(401).json({ error: "Not logged in" });
  res.set("Cache-Control", "no-store").json({
    username: u.username, gender: u.gender, country: u.country, blocked: u.blocked,
    isAdmin: ADMINS.has(req.sess.usernameLower), rooms: roomList(), minAge: minAge(), banner: site.banner, readOnly: site.readOnly,
    bridgeRooms: BRIDGE_ENABLED ? [...ROOM_TO_CHANNEL.keys()] : [], reactions: REACTIONS,
    roomClearMinutes: ROOM_CLEAR_MINUTES, serverTime: Date.now(),
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

/* ───────────────────────── Ban helper (Discord bot ke liye) ───────────────────────── */
async function banUser(lowerRaw, reason) {
  const lower = String(lowerRaw || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(lower) || ADMINS.has(lower)) return { status: 400, error: "Is user ko ban nahi kar sakte." };
  const r = await User.updateOne({ usernameLower: lower }, { banned: true, banReason: String(reason || "").slice(0, 200), bannedUntil: null });
  if (!r.matchedCount) return { status: 404, error: "User nahi mila." };
  await Session.deleteMany({ usernameLower: lower });
  kickUser(lower, "Tumhara account ban kar diya gaya hai.");
  await Report.updateMany({ target: new RegExp(`^${lower}$`, "i"), status: "open" }, { status: "actioned" });
  return { ok: true };
}

/* ───────────────────────── Ban appeal (banned user bhejta hai) ───────────────────────── */
app.post("/api/appeal", loginLimiter, wrap(async (req, res) => {
  const { username, dob, message } = req.body || {};
  const err = validateUsername(username) || validateDob(dob);
  if (err) return res.status(400).json({ error: err });
  const lower = username.trim().toLowerCase();
  const WRONG = "Username ya DOB galat hai.";
  const user = await User.findOne({ usernameLower: lower });
  if (!user) return res.status(401).json({ error: WRONG });
  if (user.lockUntil && user.lockUntil > new Date()) return res.status(429).json({ error: "Bahut galat koshish. Kuch der baad try karo." });
  if (!(await bcrypt.compare(dobSecret(lower, dob), user.dobHash))) {
    const failed = user.failedAttempts + 1;
    await User.updateOne({ _id: user._id }, failed >= MAX_FAILED ? { failedAttempts: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedAttempts: failed });
    return res.status(401).json({ error: WRONG });
  }
  if (!isBanned(user)) return res.status(400).json({ error: "Tumhara account ban nahi hai." });
  const msg = String(message || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, "").trim();
  if (msg.length < 10 || msg.length > 500) return res.status(400).json({ error: "Appeal 10 se 500 characters ki likho." });
  if (await Appeal.exists({ usernameLower: lower, status: "open" })) return res.status(400).json({ error: "Tumhari appeal pehle se bheji hui hai. Jawab ka intezaar karo." });
  await Appeal.create({ username: user.username, usernameLower: lower, message: msg });
  adminApi.alert("info", "📨 Naya ban appeal", `**${user.username}**: ${snip(msg, 200)}`);
  res.json({ ok: true });
}));

/* ───────────────────────── Admin panel (alag password + 2FA) ───────────────────────── */
function setSlow(room, sec) {
  slowmode[room] = sec;
  saveSetting("slowmode", slowmode);
  io.to(`room:${room}`).emit("slowmode", { room, slow: slowFor(room) });
}
const broadcastRooms = () => io.emit("rooms", roomList());

async function deleteRoomMessage(id) {
  const doc = await Message.findById(id).select("room discordId").lean();
  if (!doc) return false;
  await Message.deleteOne({ _id: id });
  io.to(`room:${doc.room}`).emit("message_deleted", { id: String(id), room: doc.room });
  const ch = ROOM_TO_CHANNEL.get(doc.room);
  if (BRIDGE_ENABLED && ch && doc.discordId) bus.emit("site_delete", { channelId: ch, discordId: doc.discordId });
  return true;
}

adminApi = require("./admin").mount({
  app, express, mongoose, bcrypt, crypto, cookie, rateLimit, bus, IS_PROD, PEPPER, site, ROOMS, ROOM_IDS, ADMINS, wrap,
  models: { User, Session, Message, DM, Report, Appeal },
  io: () => io, kickUser, saveSetting, applyWords: setExtraWords, deleteRoomMessage, getSlow: slowFor, setSlow, broadcastRooms,
  queueLength: () => queue.length, defaultMinAge: MIN_AGE, RESERVED, bots: () => botsApi,
});

// Website ke andar ke bots (admin panel ke Bots page se register hote hain)
botsApi = require("./bots").mount({
  mongoose, site, ROOMS, ROOM_IDS, ADMINS, models: { User, Message, Report }, io: () => io, msgView, broadcastRoom,
  bump: (k, n) => adminApi.bump(k, n), alert: (...a) => adminApi.alert(...a), auditSystem: (...a) => adminApi.auditSystem(...a),
});

/* ───────────────────────── Health + Bot API (Discord bot) ───────────────────────── */
app.get("/health", (req, res) => {
  const db = mongoose.connection.readyState === 1;
  res.status(db ? 200 : 503).json({ ok: db });
});

// Bot website ke andar chalta hai, isliye key apne aap ban jati hai (BOT_API_KEY dena optional hai)
const BOT_KEY = process.env.BOT_API_KEY || (process.env.DISCORD_TOKEN ? crypto.randomBytes(24).toString("hex") : "");
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
  const [totalUsers, newUsers24h, dms24h, openReports, banned] = await Promise.all([
    User.countDocuments(), User.countDocuments({ createdAt: { $gte: since } }),
    DM.countDocuments({ createdAt: { $gte: since } }),
    Report.countDocuments({ status: "open" }), User.countDocuments({ banned: true }),
  ]);
  const names = new Set();
  for (const [, s] of io.sockets.sockets) names.add(s.data.lower);
  const rooms = {};
  for (const r of ROOMS) rooms[r.name] = io.sockets.adapter.rooms.get(`room:${r.id}`)?.size || 0;
  res.json({ online: names.size, rooms, randomQueue: queue.length, totalUsers, newUsers24h, roomMessages: roomMsgCount, dms24h, openReports, banned, uptimeSec: Math.round(process.uptime()) });
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
  if (!r.error) adminApi.auditBot("ban", (req.body || {}).username, { reason: String((req.body || {}).reason || "").slice(0, 200) });
  res.status(r.status || 200).json(r.error ? { error: r.error } : { ok: true });
}));

bot.post("/unban", wrap(async (req, res) => {
  const lower = lowerName((req.body || {}).username);
  if (!validName(lower)) return res.status(400).json({ error: "Username galat hai." });
  const r = await User.updateOne({ usernameLower: lower }, { banned: false, banReason: "", bannedUntil: null });
  if (!r.matchedCount) return res.status(404).json({ error: "User nahi mila." });
  adminApi.auditBot("unban", lower);
  res.json({ ok: true });
}));

bot.post("/kick", wrap(async (req, res) => {
  const lower = lowerName((req.body || {}).username);
  if (!validName(lower) || ADMINS.has(lower)) return res.status(400).json({ error: "Is user ko kick nahi kar sakte." });
  await Session.deleteMany({ usernameLower: lower });
  kickUser(lower, "Admin ne tumhe logout kar diya hai. Dobara login kar sakte ho.");
  adminApi.auditBot("force_logout", lower);
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
  adminApi.auditBot("announce", room, { text });
  res.json({ ok: true });
}));

bot.get("/bridge", (req, res) => res.json(bridgeInfo()));

bot.post("/bridge", wrap(async (req, res) => {
  const act = String((req.body || {}).action || ""), room = String((req.body || {}).room || "").trim();
  if (!BRIDGE_ENABLED) return res.status(400).json({ error: "Bridge set nahi hai (BRIDGES env check karo)." });
  if (!["on", "off"].includes(act)) return res.status(400).json({ error: "Action galat hai." });
  if (room && !ROOM_TO_CHANNEL.has(room)) return res.status(400).json({ error: `Ye room bridge me nahi hai. Bridge wale rooms: ${[...ROOM_TO_CHANNEL.keys()].join(", ")}` });
  if (!room) bridgeOff = act === "off" ? new Set(["*"]) : new Set();
  else if (act === "off") bridgeOff.add(room);
  else { if (bridgeOff.has("*")) bridgeOff = new Set([...ROOM_TO_CHANNEL.keys()].filter((r) => r !== room)); else bridgeOff.delete(room); }
  saveSetting("bridgeOff", [...bridgeOff]);
  const rooms = room ? [room] : [...ROOM_TO_CHANNEL.keys()];
  for (const r of rooms) io.to(`room:${r}`).emit("announce", { text: act === "off" ? "🔗 Discord bridge abhi band hai." : "🔗 Discord bridge wapas chalu ho gaya." });
  res.json(bridgeInfo());
}));

bot.post("/slowmode", wrap(async (req, res) => {
  const sec = Number((req.body || {}).seconds), room = String((req.body || {}).room || "").trim();
  if (!Number.isInteger(sec) || sec < 0 || sec > 300) return res.status(400).json({ error: "Seconds 0 se 300 ke beech hone chahiye." });
  if (room && !ROOM_IDS.has(room)) return res.status(400).json({ error: "Room galat hai." });
  if (room) slowmode[room] = sec; else slowmode = { "*": sec };
  saveSetting("slowmode", slowmode);
  for (const r of ROOMS) io.to(`room:${r.id}`).emit("slowmode", { room: r.id, slow: slowFor(r.id) });
  res.json({ ok: true, room: room || "all", seconds: sec });
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
    if (site.maintenance && !ADMINS.has(s.usernameLower)) return next(new Error("maintenance"));
    const u = await User.findOne({ usernameLower: s.usernameLower }).select("gender country blocked banned bannedUntil mutedUntil").lean();
    if (!u || isBanned(u)) return next(new Error("unauthorized"));
    socket.data = {
      username: s.username, lower: s.usernameLower, tokenHash: sha256(token),
      gender: u.gender, country: u.country, blocked: new Set(u.blocked), mutedUntil: u.mutedUntil || null,
      room: null, hits: [], lastText: "", lastAt: 0, lastReport: 0,
      partner: null, convo: null, lastPartner: null, interest: "",
    };
    next();
  } catch { next(new Error("unauthorized")); }
});

/* ---- reactions + Discord bridge ---- */
// want: true = lagao, false = hatao, null = toggle. Naya state sabko bhejta hai aur Discord par mirror karta hai.
async function applyReaction(id, emoji, userKey, want) {
  const doc = await Message.findById(id).select("room reactions discordId").lean();
  if (!doc) return;
  doc.reactions = doc.reactions || [];
  const has = doc.reactions.some((r) => r.e === emoji && r.u === userKey);
  const add = want === null ? !has : want;
  if (add === has) return;
  if (add) {
    if (doc.reactions.length >= 300 || (!doc.reactions.some((r) => r.e === emoji) && new Set(doc.reactions.map((r) => r.e)).size >= 20)) return;
    await Message.updateOne({ _id: id, reactions: { $not: { $elemMatch: { e: emoji, u: userKey } } } }, { $push: { reactions: { e: emoji, u: userKey } } });
  } else {
    await Message.updateOne({ _id: id }, { $pull: { reactions: { e: emoji, u: userKey } } });
  }
  const fresh = await Message.findById(id).select("room reactions discordId").lean();
  if (!fresh) return;
  fresh.reactions = fresh.reactions || [];
  io.to(`room:${fresh.room}`).emit("reactions", { id: String(id), reactions: reactionView(fresh.reactions) });
  // Site ke user ka reaction Discord par: bot ka apna reaction lagta hai. Hatao tabhi jab site ka koi user us emoji par na bacha ho.
  const channelId = ROOM_TO_CHANNEL.get(fresh.room);
  if (bridgeActive(fresh.room) && fresh.discordId && userKey.startsWith("s:")) {
    const siteLeft = fresh.reactions.some((r) => r.e === emoji && r.u.startsWith("s:"));
    if (add) bus.emit("site_reaction", { channelId, discordId: fresh.discordId, emoji, add: true });
    else if (!siteLeft) bus.emit("site_reaction", { channelId, discordId: fresh.discordId, emoji, add: false });
  }
}

bus.on("bridged", ({ siteId, discordId }) => {
  Message.updateOne({ _id: siteId }, { discordId }).catch((e) => console.error("bridged:", e.message));
});

// Reply ka snapshot (kisi message ko id se, ya Discord id se dhundo)
async function replySnapshot(room, { id, discordId }) {
  let doc = null;
  if (id && mongoose.isValidObjectId(id)) doc = await Message.findById(id).select("room username text src").lean();
  else if (discordId) doc = await Message.findOne({ discordId: String(discordId) }).select("room username text src").lean();
  if (!doc || doc.room !== room) return null;
  return { id: String(doc._id), username: doc.username, text: snip(doc.text), src: doc.src || "" };
}

// @naam likhne par us user ko notification (block karne walon ko nahi jata)
async function notifyMentions(room, fromName, text, extraLowers = [], skipLower = "") {
  try {
    const set = new Set(extraLowers);
    for (const m of String(text).matchAll(/@([A-Za-z0-9_]{3,20})/g)) { set.add(m[1].toLowerCase()); if (set.size >= 5) break; }
    set.delete(skipLower);
    for (const l of set) {
      const socks = await io.in(`user:${l}`).fetchSockets();
      if (!socks.length || (skipLower && socks.some((s) => s.data.blocked.has(skipLower)))) continue;
      io.to(`user:${l}`).emit("mention", { room, roomName: ROOMS.find((r) => r.id === room)?.name || room, from: fromName, text: snip(text, 100) });
    }
  } catch (e) { console.error("mention:", e.message); }
}

bus.on("discord_message", async ({ channelId, discordId, userId, username, text, reply: ref }) => {
  try {
    const room = CHANNEL_TO_ROOM.get(channelId);
    if (!room || !bridgeActive(room)) return;
    // spam rok: ek Discord user 10 second me 5 se zyada message nahi
    const n = Date.now(), uid = String(userId || "");
    const hits = (discordHits.get(uid) || []).filter((t) => n - t < 10000);
    if (hits.length >= 5) { discordHits.set(uid, hits); return; }
    hits.push(n); discordHits.set(uid, hits);

    let t = String(text || "").slice(0, MAX_MSG_LEN * 2);
    if (LINK_MODE !== "off") t = maskLinks(t);
    const clean = cleanMessage(t.slice(0, MAX_MSG_LEN));
    if (!clean) return;
    const name = String(username || "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, "").trim().slice(0, 32) || "Discord user";

    let replyTo = null, snap = null;
    if (ref) {
      snap = await replySnapshot(room, { discordId: ref.discordId });
      if (snap) replyTo = { rid: snap.id, username: snap.username, text: snap.text };
      else if (ref.username) replyTo = { rid: "", username: String(ref.username).slice(0, 32), text: snip(maskLinks(ref.text || "")) };
    }
    const m = await Message.create({ room, username: name, text: moderate(clean).slice(0, MAX_MSG_LEN), src: "discord", discordId, replyTo });
    roomMsgCount++;
    adminApi.bump("roomMsgs");

    let dm = discordSeen.get(room);
    if (!dm) discordSeen.set(room, (dm = new Map()));
    const prev = dm.get(uid);
    const isNew = !prev || prev.name !== name || n - prev.at > DISCORD_ACTIVE_MS;
    dm.set(uid, { name, at: n });

    io.to(`room:${room}`).emit("message", msgView(m.toObject()));
    if (isNew) broadcastRoom(room);
    notifyMentions(room, name, clean, snap && snap.src !== "discord" ? [snap.username.toLowerCase()] : []);
  } catch (e) { console.error("discord_message:", e.message); }
});

// Discord me message edit hua -> site par bhi badlo (sirf Discord users ke apne messages)
bus.on("discord_edit", async ({ channelId, discordId, text }) => {
  try {
    const room = CHANNEL_TO_ROOM.get(channelId);
    if (!room || !bridgeActive(room)) return;
    const doc = await Message.findOne({ discordId: String(discordId) }).select("room src").lean();
    if (!doc || doc.src !== "discord") return;
    let t = String(text || "").slice(0, MAX_MSG_LEN * 2);
    if (LINK_MODE !== "off") t = maskLinks(t);
    const clean = cleanMessage(t.slice(0, MAX_MSG_LEN));
    if (!clean) return;
    const finalText = moderate(clean).slice(0, MAX_MSG_LEN);
    await Message.updateOne({ _id: doc._id }, { text: finalText, edited: true });
    io.to(`room:${doc.room}`).emit("message_edited", { id: String(doc._id), room: doc.room, text: finalText });
  } catch (e) { console.error("discord_edit:", e.message); }
});

// Discord me message delete hua -> site se bhi hatao (bridge off ho tab bhi, moderation ke liye)
bus.on("discord_delete", async ({ channelId, ids }) => {
  try {
    if (!BRIDGE_ENABLED || !CHANNEL_TO_ROOM.has(channelId)) return;
    for (const did of ids || []) {
      const doc = await Message.findOne({ discordId: String(did) }).select("room").lean();
      if (!doc) continue;
      await Message.deleteOne({ _id: doc._id });
      io.to(`room:${doc.room}`).emit("message_deleted", { id: String(doc._id), room: doc.room });
    }
  } catch (e) { console.error("discord_delete:", e.message); }
});

bus.on("discord_reaction", async ({ channelId, discordId, emoji, userId, add }) => {
  try {
    const rm = CHANNEL_TO_ROOM.get(channelId);
    if (!rm || !bridgeActive(rm) || !discordId || !emoji || String(emoji).length > 16) return;
    const doc = await Message.findOne({ discordId: String(discordId) }).select("_id").lean();
    if (doc) await applyReaction(doc._id, canonEmoji(emoji), `d:${userId}`, !!add);
  } catch (e) { console.error("discord_reaction:", e.message); }
});

/* ---- helpers for sockets ---- */
function allow(s) {
  const n = Date.now();
  s.data.hits = s.data.hits.filter((t) => n - t < 5000);
  if (s.data.hits.length >= 5) return false;
  s.data.hits.push(n);
  return true;
}

// Maintenance / read-only / mute: in me se koi bhi ho to message nahi ja sakta (in-chat ADMIN_USERS ko chhodkar)
function sendGate(s) {
  if (ADMINS.has(s.data.lower)) return null;
  if (site.maintenance) return "Site maintenance me hai.";
  if (site.readOnly) return "Site abhi read-only mode me hai. Message bhejna band hai.";
  if (s.data.mutedUntil && new Date(s.data.mutedUntil) > new Date()) return `Tum mute ho (${new Date(s.data.mutedUntil).toISOString().slice(0, 16).replace("T", " ")} UTC tak). Padh sakte ho par likh nahi sakte.`;
  return null;
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
  const now = Date.now(), dm = discordSeen.get(id);
  const discord = dm ? [...dm.values()].filter((u) => now - u.at < DISCORD_ACTIVE_MS).map((u) => u.name) : [];
  io.to(`room:${id}`).emit("room_users", { room: id, users: [...seen.values()], discord, bots: botsApi.visible(id) });
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
  const convo = { log: [], at: Date.now() };
  adminApi.bump("randomMatches");
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
  const cv = s.data.convo;
  if (cv && cv.at && !cv.done) { cv.done = true; adminApi.bump("randomSecs", Math.round((Date.now() - cv.at) / 1000)); }
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
    if (site.closedRooms.includes(roomId) && !ADMINS.has(lower)) return reply(ack, { error: "🔒 Ye room abhi band hai." });
    try {
      leaveRoom(socket);
      socket.join(`room:${roomId}`);
      socket.data.room = roomId;
      const rows = await Message.find({ room: roomId, createdAt: { $gte: roomCutoff() } }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).lean();
      reply(ack, { ok: true, slow: slowFor(roomId), history: rows.reverse().map(msgView) });
      broadcastRoom(roomId); broadcastCounts();
      botsApi.onJoin({ room: roomId, username, lower });
    } catch (e) { console.error("join_room:", e.message); reply(ack, { error: "Room load nahi hua." }); }
  });

  socket.on("message", async (payload, ack) => {
    const room = socket.data.room;
    if (!room) return reply(ack, { error: "Pehle room join karo." });
    const gate = sendGate(socket);
    if (gate) return reply(ack, { error: gate });
    if (site.closedRooms.includes(room) && !ADMINS.has(lower)) return reply(ack, { error: "🔒 Ye room abhi band hai." });
    const raw = typeof payload === "string" ? payload : payload?.text;
    const replyId = payload && typeof payload === "object" ? String(payload.replyTo || "") : "";
    const isAdminUser = ADMINS.has(lower);
    const slow = slowFor(room);
    if (slow && !isAdminUser) {
      const wait = Math.ceil(((socket.data.lastRoomMsg?.[room] || 0) + slow * 1000 - Date.now()) / 1000);
      if (wait > 0) return reply(ack, { error: `Slowmode: ${wait} second baad bhejo.` });
    }
    const p = prepare(socket, raw);
    if (p.error) return reply(ack, p);
    try {
      let text = p.text;
      if (LINK_MODE === "all" && !isAdminUser) text = maskLinks(text).slice(0, MAX_MSG_LEN);
      let replyTo = null, snap = null;
      if (replyId) {
        snap = await replySnapshot(room, { id: replyId });
        if (snap) replyTo = { rid: snap.id, username: snap.username, text: snap.text };
      }
      const m = await Message.create({ room, username, text, replyTo });
      socket.data.lastRoomMsg = { ...(socket.data.lastRoomMsg || {}), [room]: Date.now() };
      roomMsgCount++;
      adminApi.bump("roomMsgs");
      io.to(`room:${room}`).emit("message", msgView(m.toObject()));
      if (bridgeActive(room)) bus.emit("site_message", { id: String(m._id), channelId: ROOM_TO_CHANNEL.get(room), username, text, replyTo: replyTo ? { username: replyTo.username, text: replyTo.text } : null });
      notifyMentions(room, username, text, snap && snap.src !== "discord" ? [snap.username.toLowerCase()] : [], lower);
      botsApi.onMessage({ room, username, lower, text });
      reply(ack, { ok: true });
    } catch (e) { console.error("message:", e.message); reply(ack, { error: "Message send nahi hua." }); }
  });

  /* admin: site se kisi bhi room message ko delete (Discord copy bhi hatega) */
  socket.on("admin_delete", async (id, ack) => {
    try {
      if (!ADMINS.has(lower)) return reply(ack, { error: "Allowed nahi hai." });
      id = String(id || "");
      if (!mongoose.isValidObjectId(id)) return reply(ack, { error: "Message galat hai." });
      if (!(await deleteRoomMessage(id))) return reply(ack, { error: "Message pehle hi delete ho chuka hai." });
      reply(ack, { ok: true });
    } catch (e) { console.error("admin_delete:", e.message); reply(ack, { error: "Delete nahi hua." }); }
  });

  /* reactions (site -> site + Discord) */
  socket.on("react", async (d, ack) => {
    try {
      const n = Date.now();
      socket.data.rHits = (socket.data.rHits || []).filter((t) => n - t < 5000);
      if (socket.data.rHits.length >= 6) return reply(ack, { error: "Thoda dheere." });
      socket.data.rHits.push(n);
      const id = String(d?.id || ""), emoji = canonEmoji(d?.emoji || "");
      if (!mongoose.isValidObjectId(id) || !emoji || emoji.length > 16) return reply(ack, { error: "Reaction galat hai." });
      const doc = await Message.findById(id).select("room reactions").lean();
      if (!doc || doc.room !== socket.data.room) return reply(ack, { error: "Message nahi mila." });
      if (!REACTIONS.includes(emoji) && !(doc.reactions || []).some((r) => r.e === emoji)) return reply(ack, { error: "Ye reaction allowed nahi hai." });
      await applyReaction(id, emoji, `s:${lower}`, null);
      reply(ack, { ok: true });
    } catch (e) { console.error("react:", e.message); reply(ack, { error: "Reaction nahi laga." }); }
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
      const gate = sendGate(socket);
      if (gate) return reply(ack, { error: gate });
      const toLower = String(d?.to || "").trim().toLowerCase();
      if (!toLower || toLower === lower) return reply(ack, { error: "Is user ko message nahi bhej sakte." });
      const target = await User.findOne({ usernameLower: toLower }).select("username blocked banned").lean();
      if (!target || target.banned || target.blocked.includes(lower) || socket.data.blocked.has(toLower)) {
        return reply(ack, { error: "Is user ko message nahi bhej sakte." });
      }
      const p = prepare(socket, d.text);
      if (p.error) return reply(ack, p);
      const m = await DM.create({ fromLower: lower, toLower, from: username, to: target.username, text: p.text });
      adminApi.bump("dmMsgs");
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
    const gate = sendGate(socket);
    if (gate) return reply(ack, { error: gate });
    const p = prepare(socket, text);
    if (p.error) return reply(ack, p);
    const log = socket.data.convo.log;
    log.push({ from: username, text: p.text });
    if (log.length > 30) log.shift();
    adminApi.bump("randomMsgs");
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
      let target = "", context = [], mdoc = null;
      if (where === "random") {
        target = socket.data.partner?.data.username || socket.data.lastPartner || "";
        context = (socket.data.convo?.log || []).slice(-20);
      } else if (where === "room" && mongoose.isValidObjectId(String(d?.msgId || "")) && (mdoc = await Message.findById(String(d.msgId)).select("room username text src").lean())?.src === "discord") {
        // Discord user ka message: site par unka account nahi hota, isliye naam ke saath [Discord] likhte hain
        target = `${mdoc.username} [Discord]`;
        context = [{ from: mdoc.username, text: String(mdoc.text).slice(0, MAX_MSG_LEN) }];
      } else {
        const t = await User.findOne({ usernameLower: String(d?.target || "").trim().toLowerCase() }).select("username").lean();
        target = t?.username || "";
        if (where === "dm" && target) {
          const w = target.toLowerCase();
          const rows = await DM.find({ $or: [{ fromLower: lower, toLower: w }, { fromLower: w, toLower: lower }] }).sort({ createdAt: -1 }).limit(10).lean();
          context = rows.reverse().map((r) => ({ from: r.from, text: r.text }));
        } else if (d?.text) context = [{ from: target, text: String(d.text).slice(0, MAX_MSG_LEN) }];
      }
      if (!target || (!target.endsWith(" [Discord]") && target.toLowerCase() === lower)) return reply(ack, { error: "Report nahi ho paya." });
      socket.data.lastReport = Date.now();
      await Report.create({ reporter: username, target, where, reason, context, room: socket.data.room || "", msgId: mongoose.isValidObjectId(String(d?.msgId || "")) ? String(d.msgId) : "" });
      adminApi.onReport(target, username);
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
    // DM ka purana auto-delete index (agar pehle laga tha) hata do/badal do, warna DM phir bhi delete hote rahenge
    try {
      const idx = (await DM.collection.indexes()).find((i) => i.name === "createdAt_1");
      const want = MESSAGE_TTL_DAYS > 0 ? MESSAGE_TTL_DAYS * 86400 : undefined;
      if (idx && idx.expireAfterSeconds !== want) { await DM.collection.dropIndex("createdAt_1"); console.log("ℹ️  DM ka purana auto-delete index hata diya"); }
    } catch (e) { if (e.code !== 26) console.error("dm ttl sync:", e.message); } // 26 = collection abhi bani nahi
    await Promise.all([User.init(), Session.init(), Message.init(), DM.init(), Report.init(), Setting.init(), Appeal.init()]);
    console.log("✅ MongoDB connected");
    try {
      const [off, slow, siteS] = await Promise.all([Setting.findOne({ key: "bridgeOff" }).lean(), Setting.findOne({ key: "slowmode" }).lean(), Setting.findOne({ key: "site" }).lean()]);
      if (siteS?.value && typeof siteS.value === "object") Object.assign(site, siteS.value);
      setExtraWords(site.extraWords);
      bridgeOff = new Set(Array.isArray(off?.value) ? off.value : []);
      slowmode = slow?.value && typeof slow.value === "object" ? slow.value : {};
      if (bridgeOff.size) console.log("ℹ️  Bridge band hai (/bridge on se chalu karo):", [...bridgeOff].join(", "));
    } catch (e) { console.error("settings load:", e.message); }
    // Purane Discord "active" users hatao aur panel update karo
    setInterval(() => {
      const now = Date.now();
      for (const [room, dm] of discordSeen) {
        let changed = false;
        for (const [uid, u] of dm) if (now - u.at >= DISCORD_ACTIVE_MS) { dm.delete(uid); changed = true; }
        if (changed) broadcastRoom(room);
      }
      for (const [uid, arr] of discordHits) if (!arr.some((t) => now - t < 10000)) discordHits.delete(uid);
    }, 60 * 1000);
    // Room messages har minute check karke delete (DM ko haath nahi lagate)
    const purgeRooms = () => Message.deleteMany({ createdAt: { $lt: roomCutoff() } }).catch((e) => console.error("purge:", e.message));
    purgeRooms();
    setInterval(purgeRooms, 60 * 1000);
    console.log(`🧹 Room chat har ${ROOM_CLEAR_MINUTES} minute baad auto-clear hoti hai (DM safe)`);
    await adminApi.init();
    await botsApi.init();
    server.listen(PORT, () => {
      console.log(`🚀 Chatroom v${require("./package.json").version} running: http://localhost:${PORT}`);
      if (!process.env.DISCORD_TOKEN) return console.log("ℹ️  DISCORD_TOKEN set nahi hai, Discord bot band hai.");
      try {
        require("./bot").start({ apiBase: `http://127.0.0.1:${PORT}`, apiKey: BOT_KEY, siteUrl: process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || "" });
      } catch (e) { console.error("❌ Discord bot crash:", e.message); }
    });
  })
  .catch((e) => { console.error("❌ MongoDB connection failed:", e.message); process.exit(1); });

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
