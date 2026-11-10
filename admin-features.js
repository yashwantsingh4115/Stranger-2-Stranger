"use strict";
// Admin panel ke saare feature endpoints. admin.js se `api` router (login + CSRF + 2FA pehle ho chuka hota hai) milta hai.
module.exports = function features({ api, ctx, helpers: H, models }) {
  const { User, Session, Message, DM, Report, Appeal } = models;
  const { Admin, AdminSession, AuditLog, Note, Stat, need, audit, alert, clean, esc, nameOk, onlineSet, ROLE_PERMS, ring, ipOf } = H;
  const { site, ROOMS, ROOM_IDS, ADMINS, wrap, kickUser, saveSetting, bcrypt, crypto } = ctx;
  const io = ctx.io;

  const lowerOf = (v) => String(v || "").trim().toLowerCase();
  const reportRe = (l) => new RegExp(`^${l}$`, "i");
  const live = (lower, fn) => { for (const [, s] of io().sockets.sockets) if (s.data.lower === lower) fn(s); };
  const toUser = (lower, text) => io().to(`user:${lower}`).emit("announce", { text });
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
  const fmtMin = (m) => (m >= 1440 ? `${Math.round(m / 1440)} din` : m >= 60 ? `${Math.round(m / 60)} ghanta` : `${m} min`);
  const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

  async function findUser(name) {
    const l = lowerOf(name);
    return nameOk(l) ? User.findOne({ usernameLower: l }) : null;
  }

  /* ───────── Moderation actions (bulk me bhi yahi use hote hain) ───────── */
  async function doBan(u, reason, until) {
    const l = u.usernameLower;
    await User.updateOne({ _id: u._id }, until ? { bannedUntil: until, banReason: reason } : { banned: true, banReason: reason, bannedUntil: null });
    await Session.deleteMany({ usernameLower: l });
    kickUser(l, "Tumhara account ban kar diya gaya hai.");
    await Report.updateMany({ target: reportRe(l), status: "open" }, { status: "actioned" });
  }
  const doUnban = (u) => User.updateOne({ _id: u._id }, { banned: false, bannedUntil: null, banReason: "" });
  async function doMute(u, minutes, reason) {
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60000) : null;
    await User.updateOne({ _id: u._id }, { mutedUntil: until, muteReason: until ? reason : "" });
    live(u.usernameLower, (s) => { s.data.mutedUntil = until; });
    if (until) toUser(u.usernameLower, `🔇 Tum ${fmtMin(minutes)} ke liye mute ho. Padh sakte ho par likh nahi sakte.${reason ? " Reason: " + reason : ""}`);
    return until;
  }
  async function doWarn(u, by, reason) {
    await User.updateOne({ _id: u._id }, { $push: { warnings: { at: new Date(), by, reason } } });
    const count = (u.warnings ? u.warnings.length : 0) + 1;
    toUser(u.usernameLower, `⚠️ Admin se warning: ${reason}`);
    let autoBanned = false;
    if (count >= site.autoBanWarnings) {
      await doBan(u, `Auto-ban: ${count} warnings`);
      autoBanned = true;
      alert("warn", "⛔ Auto-ban (warnings)", `**${u.username}** ko ${count} warnings ke baad auto-ban kiya gaya.`);
    }
    return { count, autoBanned };
  }

  const protectedName = (l) => ADMINS.has(l);

  /* ───────── Dashboard ───────── */
  api.get("/stats", need("users.view"), wrap(async (req, res) => {
    const n = new Date(), day = new Date(Date.now() - 86400000), week = new Date(Date.now() - 7 * 86400000);
    const [totalUsers, new24, new7, banned, tempBanned, muted, openReports, openAppeals, lastExport] = await Promise.all([
      User.countDocuments(), User.countDocuments({ createdAt: { $gte: day } }), User.countDocuments({ createdAt: { $gte: week } }),
      User.countDocuments({ banned: true }), User.countDocuments({ bannedUntil: { $gt: n } }), User.countDocuments({ mutedUntil: { $gt: n } }),
      Report.countDocuments({ status: "open" }), Appeal.countDocuments({ status: "open" }),
      AuditLog.findOne({ action: "export_users" }).sort({ at: -1 }).select("at admin").lean(),
    ]);
    res.json({ totalUsers, new24, new7, banned, tempBanned, muted, openReports, openAppeals, online: onlineSet().size, lastExport: lastExport ? lastExport.at : null, flags: { maintenance: site.maintenance, readOnly: site.readOnly, registration: site.registration } });
  }));

  /* ───────── Reports ───────── */
  api.get("/reports", need("reports.view"), wrap(async (req, res) => {
    const status = ["open", "actioned", "dismissed"].includes(req.query.status) ? req.query.status : "open";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1), per = 25;
    const [total, rows] = await Promise.all([Report.countDocuments({ status }), Report.find({ status }).sort({ createdAt: -1 }).skip((page - 1) * per).limit(per).lean()]);
    res.json({ total, page, pages: Math.max(1, Math.ceil(total / per)), reports: rows });
  }));

  api.post("/reports/:id/resolve", need("reports.act"), wrap(async (req, res) => {
    const status = req.body?.status;
    if (!["dismissed", "actioned"].includes(status) || !ctx.mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat request.");
    const r = await Report.findById(req.params.id).select("target").lean();
    if (!r) return bad(res, "Report nahi mila.", 404);
    await Report.updateOne({ _id: req.params.id }, { status });
    await audit(req, `report_${status}`, r.target, { id: req.params.id });
    res.json({ ok: true });
  }));

  /* ───────── Users ───────── */
  api.get("/users", need("users.view"), wrap(async (req, res) => {
    const q = lowerOf(req.query.q).replace(/[^a-z0-9_]/g, "").slice(0, 20), n = new Date();
    const f = q ? { usernameLower: { $regex: `^${q}` } } : {};
    const st = String(req.query.filter || "");
    if (st === "banned") f.$or = [{ banned: true }, { bannedUntil: { $gt: n } }];
    else if (st === "muted") f.mutedUntil = { $gt: n };
    else if (st === "warned") f["warnings.0"] = { $exists: true };
    const page = Math.max(1, parseInt(req.query.page, 10) || 1), per = 25;
    const [total, rows] = await Promise.all([User.countDocuments(f), User.find(f).sort({ createdAt: -1 }).skip((page - 1) * per).limit(per).select("username gender country createdAt lastLoginAt banned bannedUntil mutedUntil warnings").lean()]);
    const on = onlineSet();
    res.json({
      total, page, pages: Math.max(1, Math.ceil(total / per)),
      users: rows.map((u) => ({ username: u.username, gender: u.gender, country: u.country, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, banned: !!u.banned, bannedUntil: u.bannedUntil, mutedUntil: u.mutedUntil, warnings: (u.warnings || []).length, online: on.has(u.username.toLowerCase()) })),
    });
  }));

  api.get("/users/:name", need("users.view"), wrap(async (req, res) => {
    const l = lowerOf(req.params.name);
    if (!nameOk(l)) return bad(res, "Username galat hai.");
    const u = await User.findOne({ usernameLower: l }).lean();
    if (!u) return bad(res, "User nahi mila.", 404);
    const [against, byCount, blockedBy, notes, appeals] = await Promise.all([
      Report.find({ target: reportRe(l) }).sort({ createdAt: -1 }).limit(20).lean(), Report.countDocuments({ reporter: reportRe(l) }),
      User.countDocuments({ blocked: l }), Note.find({ userLower: l }).sort({ at: -1 }).limit(50).lean(), Appeal.find({ usernameLower: l }).sort({ createdAt: -1 }).limit(5).lean(),
    ]);
    const n = new Date();
    res.json({
      user: {
        username: u.username, gender: u.gender, country: u.country, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
        banned: !!u.banned, bannedUntil: u.bannedUntil, banReason: u.banReason, mutedUntil: u.mutedUntil, muteReason: u.muteReason, warnings: u.warnings || [],
        blockedCount: (u.blocked || []).length, blockedBy, locked: !!(u.lockUntil && u.lockUntil > n), failedAttempts: u.failedAttempts,
        online: onlineSet().has(l), isProtected: protectedName(l),
      },
      against, byCount, notes, appeals,
    });
  }));

  // Sab punitive actions ek jaisa guard use karte hain
  const userAction = (perm, opts, fn) => [need(perm, opts), wrap(async (req, res) => {
    const u = await findUser(req.params.name);
    if (!u) return bad(res, "User nahi mila.", 404);
    if (protectedName(u.usernameLower)) return bad(res, "Ye protected user hai (ADMIN_USERS).");
    const out = await fn(req, u);
    if (out && out.error) return bad(res, out.error);
    res.json({ ok: true, ...(out || {}) });
  })];

  api.post("/users/:name/warn", ...userAction("users.warn", {}, async (req, u) => {
    const reason = clean(req.body?.reason, 150);
    if (reason.length < 3) return { error: "Warning ka reason likho." };
    const r = await doWarn(u, req.adm.username, reason);
    await audit(req, "warn", u.username, { reason, count: r.count, autoBanned: r.autoBanned });
    return r;
  }));

  api.post("/users/:name/mute", ...userAction("users.mute", {}, async (req, u) => {
    const minutes = int(req.body?.minutes, 0, 43200);
    if (minutes === null) return { error: "Minutes 0 se 43200 (30 din) ke beech hone chahiye. 0 = unmute." };
    const reason = clean(req.body?.reason, 150);
    const until = await doMute(u, minutes, reason);
    await audit(req, minutes ? "mute" : "unmute", u.username, { minutes, reason });
    return { mutedUntil: until };
  }));

  api.post("/users/:name/tempban", ...userAction("users.tempban", {}, async (req, u) => {
    const hours = int(req.body?.hours, 1, 720);
    if (hours === null) return { error: "Hours 1 se 720 (30 din) ke beech hone chahiye." };
    const reason = clean(req.body?.reason, 150);
    await doBan(u, reason, new Date(Date.now() + hours * 3600000));
    await audit(req, "tempban", u.username, { hours, reason });
    return {};
  }));

  api.post("/users/:name/ban", ...userAction("users.ban", { reauth: true }, async (req, u) => {
    const reason = clean(req.body?.reason, 150);
    await doBan(u, reason);
    await audit(req, "ban", u.username, { reason });
    alert("warn", "⛔ User ban hua", `**${u.username}** ko **${req.adm.username}** ne ban kiya. ${reason}`);
    return {};
  }));

  api.post("/users/:name/unban", ...userAction("users.unban", { reauth: true }, async (req, u) => {
    await doUnban(u);
    await audit(req, "unban", u.username);
    return {};
  }));

  api.post("/users/:name/unlock", ...userAction("users.unlock", {}, async (req, u) => {
    await User.updateOne({ _id: u._id }, { failedAttempts: 0, lockUntil: null });
    await audit(req, "unlock_account", u.username);
    return {};
  }));

  api.post("/users/:name/logout", ...userAction("users.logout", {}, async (req, u) => {
    await Session.deleteMany({ usernameLower: u.usernameLower });
    kickUser(u.usernameLower, "Admin ne tumhe logout kar diya hai. Dobara login kar sakte ho.");
    await audit(req, "force_logout", u.username);
    return {};
  }));

  api.post("/users/:name/note", need("users.notes"), wrap(async (req, res) => {
    const u = await findUser(req.params.name);
    if (!u) return bad(res, "User nahi mila.", 404);
    const text = clean(req.body?.text, 500);
    if (text.length < 2) return bad(res, "Note khali hai.");
    await Note.create({ userLower: u.usernameLower, admin: req.adm.username, text });
    await audit(req, "note_add", u.username);
    res.json({ ok: true });
  }));

  /* ---- Bulk ---- */
  const BULK_PERM = { ban: "users.ban", unban: "users.unban", mute: "users.mute", unmute: "users.mute", tempban: "users.tempban", logout: "users.logout" };
  api.post("/bulk", need("bulk", { reauth: true }), wrap(async (req, res) => {
    const { action, usernames } = req.body || {};
    if (!BULK_PERM[action] || !Array.isArray(usernames)) return bad(res, "Galat request.");
    if (!H.can(req.adm.role, BULK_PERM[action])) return bad(res, "Is action ki permission nahi hai.", 403);
    const names = [...new Set(usernames.map(lowerOf).filter(nameOk))].slice(0, 50);
    if (!names.length) return bad(res, "Koi sahi username nahi mila.");
    const reason = clean(req.body?.reason, 150);
    const minutes = int(req.body?.minutes, 1, 43200) || 60, hours = int(req.body?.hours, 1, 720) || 24;
    const results = [];
    for (const l of names) {
      try {
        const u = await User.findOne({ usernameLower: l });
        if (!u) { results.push({ username: l, error: "nahi mila" }); continue; }
        if (protectedName(l)) { results.push({ username: l, error: "protected" }); continue; }
        if (action === "ban") await doBan(u, reason);
        else if (action === "unban") await doUnban(u);
        else if (action === "mute") await doMute(u, minutes, reason);
        else if (action === "unmute") await doMute(u, 0, "");
        else if (action === "tempban") await doBan(u, reason, new Date(Date.now() + hours * 3600000));
        else if (action === "logout") { await Session.deleteMany({ usernameLower: l }); kickUser(l, "Admin ne tumhe logout kar diya hai."); }
        results.push({ username: u.username, ok: true });
      } catch (e) { results.push({ username: l, error: "fail" }); }
    }
    await audit(req, "bulk_" + action, `${results.filter((r) => r.ok).length}/${names.length} users`, { users: names.join(",").slice(0, 280), reason, minutes, hours });
    alert("warn", "📦 Bulk action", `**${req.adm.username}** ne bulk **${action}** chalaya (${results.filter((r) => r.ok).length}/${names.length} users).`);
    res.json({ results });
  }));

  /* ---- Export (backup) ---- */
  api.get("/export/users.csv", need("users.export", { reauth: true }), async (req, res) => {
    const cell = (v) => { let t = String(v ?? ""); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
    try {
      res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.write("\ufeffusername,gender,country,joined,last_login,banned,banned_until,muted_until,warnings\n");
      let count = 0;
      for await (const u of User.find().sort({ createdAt: 1 }).select("username gender country createdAt lastLoginAt banned bannedUntil mutedUntil warnings").lean().cursor()) {
        count++;
        res.write([u.username, u.gender, u.country, u.createdAt && u.createdAt.toISOString(), u.lastLoginAt && u.lastLoginAt.toISOString(), u.banned ? "yes" : "no",
          u.bannedUntil && u.bannedUntil.toISOString(), u.mutedUntil && u.mutedUntil.toISOString(), (u.warnings || []).length].map(cell).join(",") + "\n");
      }
      res.end();
      await audit(req, "export_users", `${count} users`);
      alert("warn", "⬇️ Users export hue", `**${req.adm.username}** ne ${count} users ka CSV export kiya. IP: ${ipOf(req)}`);
    } catch (e) { console.error("export:", e.message); res.end(); }
  });

  /* ───────── Live monitor (read-only) + message delete ───────── */
  const seen = new Map();
  api.get("/monitor/:room", need("monitor.view"), wrap(async (req, res) => {
    const room = req.params.room;
    if (!ROOM_IDS.has(room)) return bad(res, "Room galat hai.");
    const k = `${req.adm._id}:${room}`;
    if (Date.now() - (seen.get(k) || 0) > 10 * 60000) { await audit(req, "monitor_view", room); }
    seen.set(k, Date.now());
    const rows = await Message.find({ room }).sort({ createdAt: -1 }).limit(100).select("username text src createdAt").lean();
    res.json({ room, closed: site.closedRooms.includes(room), online: io().sockets.adapter.rooms.get(`room:${room}`)?.size || 0, messages: rows.reverse().map((m) => ({ id: String(m._id), username: m.username, text: m.text, src: m.src || "", createdAt: m.createdAt })) });
  }));

  api.post("/messages/:id/delete", need("messages.delete"), wrap(async (req, res) => {
    const id = req.params.id;
    if (!ctx.mongoose.isValidObjectId(id)) return bad(res, "Message galat hai.");
    const doc = await Message.findById(id).select("room username text").lean();
    if (!doc) return bad(res, "Message pehle hi delete ho chuka hai.", 404);
    await ctx.deleteRoomMessage(id);
    await audit(req, "message_delete", doc.username, { room: doc.room, text: String(doc.text).slice(0, 120) });
    res.json({ ok: true });
  }));

  /* ───────── Appeals ───────── */
  api.get("/appeals", need("appeals.view"), wrap(async (req, res) => {
    const status = ["open", "approved", "rejected"].includes(req.query.status) ? req.query.status : "open";
    res.json({ appeals: await Appeal.find({ status }).sort({ createdAt: -1 }).limit(50).lean() });
  }));

  api.post("/appeals/:id/decide", need("appeals.decide"), wrap(async (req, res) => {
    const decision = req.body?.decision, note = clean(req.body?.note, 200);
    if (!["approve", "reject"].includes(decision) || !ctx.mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat request.");
    const a = await Appeal.findOneAndUpdate({ _id: req.params.id, status: "open" }, { status: decision === "approve" ? "approved" : "rejected", decidedBy: req.adm.username, decisionNote: note }).lean();
    if (!a) return bad(res, "Appeal nahi mili ya pehle hi decide ho chuki hai.", 404);
    if (decision === "approve") { const u = await User.findOne({ usernameLower: a.usernameLower }); if (u) await doUnban(u); }
    await audit(req, `appeal_${decision}`, a.username, { note });
    res.json({ ok: true });
  }));

  /* ───────── Bad words ───────── */
  api.get("/words", need("words.edit"), (req, res) => res.json({ words: site.extraWords }));
  api.post("/words", need("words.edit", { reauth: true }), wrap(async (req, res) => {
    const list = Array.isArray(req.body?.words) ? req.body.words : null;
    if (!list) return bad(res, "Galat request.");
    const words = [...new Set(list.map((w) => String(w).toLowerCase().trim()).filter((w) => /^[a-z0-9@$!_ -]{3,30}$/.test(w)))].slice(0, 500);
    site.extraWords = words;
    ctx.applyWords(words);
    await saveSetting("site", site);
    await audit(req, "words_update", `${words.length} words`);
    res.json({ ok: true, count: words.length });
  }));

  /* ───────── Rooms + announcements ───────── */
  api.get("/rooms", need("rooms.manage"), (req, res) => {
    res.json({ rooms: ROOMS.map((r) => ({ id: r.id, name: r.name, customName: site.roomNames[r.id] || "", closed: site.closedRooms.includes(r.id), online: io().sockets.adapter.rooms.get(`room:${r.id}`)?.size || 0, slow: ctx.getSlow(r.id) })) });
  });

  api.post("/rooms/:id", need("rooms.manage"), wrap(async (req, res) => {
    const id = req.params.id;
    if (!ROOM_IDS.has(id)) return bad(res, "Room galat hai.");
    const b = req.body || {}, changes = {};
    if (typeof b.name === "string") {
      const nm = clean(b.name, 24).replace(/[^\p{L}\p{N} &'._-]/gu, "");
      if (nm) site.roomNames[id] = nm; else delete site.roomNames[id];
      changes.name = nm;
    }
    if (typeof b.closed === "boolean") {
      site.closedRooms = site.closedRooms.filter((r) => r !== id);
      if (b.closed) site.closedRooms.push(id);
      changes.closed = b.closed;
      io().to(`room:${id}`).emit("announce", { text: b.closed ? "🔒 Ye room abhi band kar diya gaya hai." : "🔓 Ye room wapas khul gaya hai." });
    }
    if (b.slow !== undefined) {
      const sec = int(b.slow, 0, 300);
      if (sec === null) return bad(res, "Slowmode 0 se 300 second.");
      ctx.setSlow(id, sec);
      changes.slow = sec;
    }
    await saveSetting("site", site);
    ctx.broadcastRooms();
    await audit(req, "room_update", id, changes);
    res.json({ ok: true });
  }));

  api.post("/announce", need("announce"), wrap(async (req, res) => {
    const text = clean(req.body?.text, 200), room = String(req.body?.room || "all");
    if (text.length < 2) return bad(res, "Message likho.");
    if (room !== "all" && !ROOM_IDS.has(room)) return bad(res, "Room galat hai.");
    (room === "all" ? io() : io().to(`room:${room}`)).emit("announce", { text: `📢 ${text}` });
    await audit(req, "announce", room, { text });
    res.json({ ok: true });
  }));

  /* ───────── Site settings (owner) ───────── */
  const settingsView = () => ({ maintenance: site.maintenance, readOnly: site.readOnly, registration: site.registration, minAge: site.minAge, banner: site.banner, autoBanWarnings: site.autoBanWarnings, defaultMinAge: ctx.defaultMinAge });
  api.get("/settings", need("settings.edit"), (req, res) => res.json(settingsView()));
  api.post("/settings", need("settings.edit", { reauth: true }), wrap(async (req, res) => {
    const b = req.body || {}, before = settingsView(), changes = {};
    for (const k of ["maintenance", "readOnly", "registration"]) if (typeof b[k] === "boolean") { site[k] = b[k]; changes[k] = b[k]; }
    if (b.minAge !== undefined) {
      if (b.minAge === null || b.minAge === "") site.minAge = null;
      else { const v = int(b.minAge, 13, 30); if (v === null) return bad(res, "Minimum age 13 se 30 ke beech ho."); site.minAge = v; }
      changes.minAge = site.minAge;
    }
    if (typeof b.banner === "string") { site.banner = clean(b.banner, 200); changes.banner = site.banner; }
    if (b.autoBanWarnings !== undefined) { const v = int(b.autoBanWarnings, 1, 10); if (v === null) return bad(res, "Auto-ban warnings 1 se 10."); site.autoBanWarnings = v; changes.autoBanWarnings = v; }
    await saveSetting("site", site);
    if (changes.banner !== undefined) io().emit("banner", { text: site.banner });
    if (changes.readOnly !== undefined) io().emit("announce", { text: site.readOnly ? "🔒 Site abhi read-only mode me hai. Message bhejna band hai." : "✅ Site wapas normal ho gayi." });
    if (changes.maintenance === true) {
      for (const [, s] of io().sockets.sockets) if (!ADMINS.has(s.data.lower)) { s.emit("kicked", "🛠️ Site maintenance me hai. Thodi der baad aana."); s.disconnect(true); }
    }
    await audit(req, "settings_update", "site", { before, changes });
    if (Object.keys(changes).length) alert(changes.maintenance !== undefined || changes.registration !== undefined ? "warn" : "info", "⚙️ Site settings badli", `**${req.adm.username}** ne badla: ${JSON.stringify(changes)}`);
    res.json(settingsView());
  }));

  /* ───────── Admin accounts (owner) ───────── */
  const adminView = (a) => ({ username: a.username, role: a.role, totpEnabled: a.totpEnabled, disabled: a.disabled, mustChangePassword: a.mustChangePassword, lastLoginAt: a.lastLoginAt, lastLoginIp: a.lastLoginIp, createdBy: a.createdBy, createdAt: a.createdAt, locked: !!(a.lockUntil && a.lockUntil > new Date()) });
  const tempPassword = () => crypto.randomBytes(12).toString("base64url");

  api.get("/admins", need("admins.manage"), wrap(async (req, res) => {
    res.json({ admins: (await Admin.find().sort({ createdAt: 1 }).lean()).map(adminView) });
  }));

  api.post("/admins", need("admins.manage", { reauth: true }), wrap(async (req, res) => {
    const uname = String(req.body?.username || "").trim(), role = req.body?.role;
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(uname)) return bad(res, "Username 3-24 characters (letters, numbers, . _ -).");
    if (!["admin", "moderator"].includes(role)) return bad(res, "Role admin ya moderator hona chahiye.");
    const pw = tempPassword();
    try {
      await Admin.create({ username: uname, usernameLower: uname.toLowerCase(), passHash: await bcrypt.hash(pw, 12), role, mustChangePassword: true, createdBy: req.adm.username });
    } catch (e) { if (e.code === 11000) return bad(res, "Ye username pehle se hai."); throw e; }
    await audit(req, "admin_create", uname, { role });
    alert("warn", "👤 Naya admin account", `**${req.adm.username}** ne **${uname}** (${role}) banaya.`);
    res.json({ ok: true, tempPassword: pw });   // sirf ek baar dikhta hai
  }));

  const adminTarget = (fn) => [need("admins.manage", { reauth: true }), wrap(async (req, res) => {
    const a = await Admin.findOne({ usernameLower: lowerOf(req.params.name) });
    if (!a) return bad(res, "Admin nahi mila.", 404);
    if (a.role === "owner") return bad(res, "Owner account ko is tarah badla nahi ja sakta.");
    if (String(a._id) === String(req.adm._id)) return bad(res, "Apne account par ye nahi kar sakte.");
    const out = await fn(req, a);
    if (out && out.error) return bad(res, out.error);
    res.json({ ok: true, ...(out || {}) });
  })];

  api.post("/admins/:name/disable", ...adminTarget(async (req, a) => {
    await Admin.updateOne({ _id: a._id }, { disabled: true });
    await AdminSession.deleteMany({ adminId: a._id });
    await audit(req, "admin_disable", a.username);
    alert("warn", "🚫 Admin disable hua", `**${a.username}** ko disable kiya gaya.`);
  }));
  api.post("/admins/:name/enable", ...adminTarget(async (req, a) => { await Admin.updateOne({ _id: a._id }, { disabled: false, failedAttempts: 0, lockUntil: null }); await audit(req, "admin_enable", a.username); }));
  api.post("/admins/:name/role", ...adminTarget(async (req, a) => {
    if (!["admin", "moderator"].includes(req.body?.role)) return { error: "Role admin ya moderator hona chahiye." };
    await Admin.updateOne({ _id: a._id }, { role: req.body.role });
    await AdminSession.deleteMany({ adminId: a._id });
    await audit(req, "admin_role", a.username, { role: req.body.role });
  }));
  api.post("/admins/:name/reset", ...adminTarget(async (req, a) => {
    const pw = tempPassword();
    await Admin.updateOne({ _id: a._id }, { passHash: await bcrypt.hash(pw, 12), mustChangePassword: true, totpEnabled: false, totpSecretEnc: "", totpPendingEnc: "", recovery: [], failedAttempts: 0, lockUntil: null, lastTotpStep: 0 });
    await AdminSession.deleteMany({ adminId: a._id });
    await audit(req, "admin_reset", a.username);
    alert("warn", "♻️ Admin reset hua", `**${a.username}** ka password aur 2FA reset kiya gaya.`);
    return { tempPassword: pw };
  }));

  /* ───────── Audit log ───────── */
  api.get("/audit", need("audit.view"), wrap(async (req, res) => {
    const f = {}, who = clean(req.query.admin, 24), act = clean(req.query.action, 30).replace(/[^\w]/g, "");
    if (who) f.admin = who;
    if (act) f.action = act;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1), per = 50;
    const [total, rows] = await Promise.all([AuditLog.countDocuments(f), AuditLog.find(f).sort({ at: -1 }).skip((page - 1) * per).limit(per).lean()]);
    res.json({ total, page, pages: Math.max(1, Math.ceil(total / per)), rows });
  }));

  /* ───────── Analytics ───────── */
  api.get("/analytics", need("analytics.view"), wrap(async (req, res) => {
    const d30 = new Date(Date.now() - 30 * 86400000), d7 = new Date(Date.now() - 7 * 86400000);
    const [newUsers, stats, reports, genders, countries] = await Promise.all([
      User.find({ createdAt: { $gte: d30 } }).select("createdAt").limit(50000).lean(),
      Stat.find({ at: { $gte: d7 } }).lean(),
      Report.find({ createdAt: { $gte: d30 } }).select("reason where room createdAt").limit(20000).lean(),
      User.aggregate([{ $group: { _id: "$gender", n: { $sum: 1 } } }]),
      User.aggregate([{ $group: { _id: "$country", n: { $sum: 1 } } }]),
    ]);
    const day = (d) => new Date(d).toISOString().slice(0, 10);
    const days = (n) => Array.from({ length: n }, (_, i) => day(Date.now() - (n - 1 - i) * 86400000));
    const signupMap = {}; for (const u of newUsers) signupMap[day(u.createdAt)] = (signupMap[day(u.createdAt)] || 0) + 1;
    const hourly = Array.from({ length: 24 }, (_, h) => ({ h, roomMsgs: 0, dmMsgs: 0, logins: 0, peak: 0 }));
    const tot = { roomMsgs: 0, dmMsgs: 0, logins: 0, signups: 0, randomMatches: 0, randomMsgs: 0, randomSecs: 0 };
    for (const s of stats) {
      const h = hourly[Number(String(s._id).slice(11, 13))] || null;
      for (const k of Object.keys(tot)) tot[k] += (s.c && s.c[k]) || 0;
      if (h) { h.roomMsgs += (s.c && s.c.roomMsgs) || 0; h.dmMsgs += (s.c && s.c.dmMsgs) || 0; h.logins += (s.c && s.c.logins) || 0; h.peak = Math.max(h.peak, s.peak || 0); }
    }
    const by = (key) => { const m = {}; for (const r of reports) { const k = r[key] || "-"; m[k] = (m[k] || 0) + 1; } return m; };
    const repMap = {}; for (const r of reports) repMap[day(r.createdAt)] = (repMap[day(r.createdAt)] || 0) + 1;
    const cm = {}; for (const c of countries) { const k = String(c._id || "").trim().toLowerCase() || "(batana nahi)"; cm[k] = (cm[k] || 0) + c.n; }
    res.json({
      signups: days(30).map((d) => ({ d, n: signupMap[d] || 0 })),
      hourly, totals7: tot, randomAvgSec: tot.randomMatches ? Math.round(tot.randomSecs / tot.randomMatches) : 0,
      reports: { total: reports.length, byReason: by("reason"), byWhere: by("where"), byRoom: by("room"), perDay: days(14).map((d) => ({ d, n: repMap[d] || 0 })) },
      gender: Object.fromEntries(genders.map((g) => [g._id || "unset", g.n])),
      countries: Object.entries(cm).sort((a, b) => b[1] - a[1]).slice(0, 10),
    });
  }));

  /* ───────── Health + logs ───────── */
  api.get("/health-info", need("health.view"), wrap(async (req, res) => {
    const m = process.memoryUsage();
    const [users, sessions, messages, dms, reports, audits] = await Promise.all([User.countDocuments(), Session.countDocuments(), Message.countDocuments(), DM.countDocuments(), Report.countDocuments(), AuditLog.countDocuments()]);
    res.json({
      db: ctx.mongoose.connection.readyState === 1 ? "connected" : "problem", uptimeSec: Math.round(process.uptime()), memoryMB: Math.round(m.rss / 1048576), node: process.version,
      sockets: io().engine.clientsCount, onlineUsers: onlineSet().size, randomQueue: ctx.queueLength(), counts: { users, sessions, messages, dms, reports, audit: audits },
      botApi: !!process.env.DISCORD_TOKEN, ipAllowlist: !!process.env.ADMIN_IPS,
    });
  }));
  api.get("/logs", need("logs.view"), (req, res) => res.json({ lines: ring.slice(-200) }));
};
