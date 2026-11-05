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

/* ───────────────────────── Config ───────────────────────── */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const MONGO_URI = process.env.MONGO_URI;
const PEPPER = process.env.DOB_PEPPER || "";
const MIN_AGE = Number(process.env.MIN_AGE) || 13;
const MESSAGE_TTL_DAYS = Number(process.env.MESSAGE_TTL_DAYS ?? 30);

const SESSION_DAYS = 7;
const COOKIE_NAME = "sid";
const MAX_FAILED = 5;                 // itni galat DOB ke baad lock
const LOCK_MINUTES = 15;
const MAX_MSG_LEN = 500;
const HISTORY_LIMIT = 50;
const RESERVED = ["admin", "administrator", "moderator", "mod", "system", "support", "root", "owner", "staff", "everyone", "null", "undefined"];

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing hai. .env file banao (.env.example dekho).");
  process.exit(1);
}
if (IS_PROD && PEPPER.length < 16) {
  console.error("❌ Production me DOB_PEPPER (kam se kam 16 characters) set karna zaroori hai.");
  process.exit(1);
}

/* ───────────────────────── Models ───────────────────────── */
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },                       // jaisa user ne likha
  usernameLower: { type: String, required: true, unique: true },    // uniqueness yahan se enforce hoti hai
  dobHash: { type: String, required: true },                        // DOB kabhi plain save nahi hoti
  failedAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
});

const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },        // token ka sirf hash store hota hai
  usernameLower: { type: String, required: true, index: true },
  username: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // Mongo khud expire karke delete kar dega
});

const messageSchema = new mongoose.Schema({
  username: { type: String, required: true },
  text: { type: String, required: true, maxlength: MAX_MSG_LEN },
  createdAt: { type: Date, default: Date.now },
});
if (MESSAGE_TTL_DAYS > 0) messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: MESSAGE_TTL_DAYS * 86400 });
else messageSchema.index({ createdAt: 1 });

const User = mongoose.model("User", userSchema);
const Session = mongoose.model("Session", sessionSchema);
const Message = mongoose.model("Message", messageSchema);

/* ───────────────────────── Helpers ───────────────────────── */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// DOB + username ko pepper ke saath HMAC karke phir bcrypt (slow hash) lagate hain
function dobSecret(usernameLower, dob) {
  return crypto.createHmac("sha256", PEPPER).update(`${usernameLower}|${dob}`).digest("hex");
}

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
  // control characters hatao, extra blank lines kam karo
  const t = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();
  if (!t || t.length > MAX_MSG_LEN) return null;
  return t;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET / non-browser clients
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
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
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", "ws:", "wss:"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "upgrade-insecure-requests": IS_PROD ? [] : null,
    },
  },
}));
app.use(express.json({ limit: "2kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: IS_PROD ? "1h" : 0 }));

// Cross-site POST requests block
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && !sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Bahut zyada koshish ho gayi. Thodi der baad try karo." },
});

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "strict", secure: IS_PROD, path: "/", maxAge: SESSION_DAYS * 86400 * 1000,
  });
}

async function getSession(token) {
  if (!token || typeof token !== "string" || token.length > 128) return null;
  return Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
}

/* ───────────────────────── Auth routes ───────────────────────── */
app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const { username, dob } = req.body || {};
    const err = validateUsername(username) || validateDob(dob);
    if (err) return res.status(400).json({ error: err });

    const name = username.trim();
    const lower = name.toLowerCase();
    const TAKEN = "Ye username pehle se kisi aur ka hai ya DOB galat hai.";
    let user = await User.findOne({ usernameLower: lower });

    if (!user) {
      // Naya user: account banao
      try {
        const dobHash = await bcrypt.hash(dobSecret(lower, dob), 12);
        user = await User.create({ username: name, usernameLower: lower, dobHash });
      } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: TAKEN }); // race: kisi aur ne abhi liya
        throw e;
      }
    } else {
      // Purana user: lock check + DOB verify
      if (user.lockUntil && user.lockUntil > new Date()) {
        const mins = Math.ceil((user.lockUntil - new Date()) / 60000);
        return res.status(429).json({ error: `Bahut galat koshish. ${mins} minute baad try karo.` });
      }
      const ok = await bcrypt.compare(dobSecret(lower, dob), user.dobHash);
      if (!ok) {
        const failed = user.failedAttempts + 1;
        const update = failed >= MAX_FAILED
          ? { failedAttempts: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) }
          : { failedAttempts: failed };
        await User.updateOne({ _id: user._id }, update);
        return res.status(401).json({ error: TAKEN });
      }
      await User.updateOne({ _id: user._id }, { failedAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
    }

    // Ek username = ek active session: purane sessions/sockets hata do
    await Session.deleteMany({ usernameLower: lower });
    io.in(`user:${lower}`).emit("kicked", "Tumne dusri jagah se login kiya hai.");
    io.in(`user:${lower}`).disconnectSockets(true);

    const token = crypto.randomBytes(32).toString("hex");
    await Session.create({
      tokenHash: sha256(token), usernameLower: lower, username: user.username,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400 * 1000),
    });
    setSessionCookie(res, token);
    res.json({ ok: true, username: user.username });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ error: "Server error. Dobara try karo." });
  }
});

app.get("/api/me", async (req, res) => {
  const token = cookie.parse(req.headers.cookie || "")[COOKIE_NAME];
  const s = await getSession(token).catch(() => null);
  if (!s) return res.status(401).json({ error: "Not logged in" });
  res.set("Cache-Control", "no-store").json({ username: s.username });
});

app.post("/api/logout", async (req, res) => {
  const token = cookie.parse(req.headers.cookie || "")[COOKIE_NAME];
  if (token) {
    const h = sha256(token);
    await Session.deleteOne({ tokenHash: h }).catch(() => {});
    for (const [, s] of io.sockets.sockets) if (s.data.tokenHash === h) s.disconnect(true);
  }
  res.clearCookie(COOKIE_NAME, { path: "/" }).json({ ok: true });
});

/* ───────────────────────── Socket.IO ───────────────────────── */
const io = new Server(server, {
  maxHttpBufferSize: 4 * 1024,
  cors: { origin: false }, // sirf same-origin
});

const online = new Map(); // usernameLower -> { username, count }
const onlineList = () => [...online.values()].map((u) => u.username).sort((a, b) => a.localeCompare(b));

io.use(async (socket, next) => {
  try {
    const origin = socket.handshake.headers.origin;
    if (origin && new URL(origin).host !== socket.handshake.headers.host) return next(new Error("forbidden"));
    const token = cookie.parse(socket.handshake.headers.cookie || "")[COOKIE_NAME];
    const s = await getSession(token);
    if (!s) return next(new Error("unauthorized"));
    socket.data = { username: s.username, lower: s.usernameLower, tokenHash: sha256(token), hits: [] };
    next();
  } catch { next(new Error("unauthorized")); }
});

io.on("connection", async (socket) => {
  const { username, lower } = socket.data;
  socket.join(`user:${lower}`);

  const entry = online.get(lower) || { username, count: 0 };
  entry.count++;
  online.set(lower, entry);
  io.emit("online", onlineList());

  try {
    const rows = await Message.find().sort({ createdAt: -1 }).limit(HISTORY_LIMIT).lean();
    socket.emit("history", rows.reverse().map((m) => ({ id: String(m._id), username: m.username, text: m.text, createdAt: m.createdAt })));
  } catch (e) { console.error("history error:", e.message); }

  socket.on("message", async (text, ack) => {
    // rate limit: 5 seconds me max 5 messages
    const now = Date.now();
    socket.data.hits = socket.data.hits.filter((t) => now - t < 5000);
    if (socket.data.hits.length >= 5) return typeof ack === "function" && ack({ error: "Thoda dheere bhejo." });
    socket.data.hits.push(now);

    const clean = cleanMessage(text);
    if (!clean) return typeof ack === "function" && ack({ error: `Message khali ya ${MAX_MSG_LEN} characters se zyada hai.` });
    try {
      const m = await Message.create({ username, text: clean });
      io.emit("message", { id: String(m._id), username, text: clean, createdAt: m.createdAt });
      if (typeof ack === "function") ack({ ok: true });
    } catch (e) {
      console.error("message error:", e.message);
      if (typeof ack === "function") ack({ error: "Message send nahi hua." });
    }
  });

  let lastTyping = 0;
  socket.on("typing", () => {
    const now = Date.now();
    if (now - lastTyping < 1500) return;
    lastTyping = now;
    socket.broadcast.emit("typing", username);
  });

  socket.on("disconnect", () => {
    const e = online.get(lower);
    if (e && --e.count <= 0) online.delete(lower);
    io.emit("online", onlineList());
  });
});

/* ───────────────────────── Start ───────────────────────── */
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(async () => {
    await Promise.all([User.init(), Session.init(), Message.init()]); // indexes ready (unique username ke liye zaroori)
    console.log("✅ MongoDB connected");
    server.listen(PORT, () => console.log(`🚀 Chatroom running: http://localhost:${PORT}`));
  })
  .catch((e) => { console.error("❌ MongoDB connection failed:", e.message); process.exit(1); });

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
