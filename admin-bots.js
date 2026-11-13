"use strict";
// Admin panel ke Bots + Automations ke endpoints. admin.js se `api` router milta hai (login, CSRF, 2FA pehle ho chuke hote hain).
module.exports = function botRoutes({ api, ctx, helpers: H }) {
  const { need, audit, alert, clean, AuditLog } = H;
  const { site, ROOM_IDS, wrap, saveSetting } = ctx;
  const { User } = ctx.models;
  const eng = () => ctx.bots();
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
  const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  const multi = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, "").trim().slice(0, n);

  const view = (b) => ({
    id: String(b._id), name: b.name, prompt: b.prompt, rooms: b.rooms, enabled: b.enabled, hidden: b.hidden, replyMode: b.replyMode,
    greet: b.greet, moderator: b.moderator, rules: b.rules || [], schedule: b.schedule || [], createdBy: b.createdBy, createdAt: b.createdAt,
  });

  function parse(body) {
    const d = {};
    d.rooms = Array.isArray(body.rooms) ? [...new Set(body.rooms.filter((r) => ROOM_IDS.has(r)))] : [];
    d.prompt = multi(body.prompt, 4000);
    if (!["off", "mention", "active"].includes(body.replyMode)) return { error: "Reply mode galat hai." };
    d.replyMode = body.replyMode;
    d.greet = clean(body.greet, 200);
    d.moderator = !!body.moderator;
    const rules = Array.isArray(body.rules) ? body.rules : [];
    if (rules.length > 20) return { error: "Max 20 rules." };
    d.rules = [];
    for (const r of rules) {
      const keywords = (Array.isArray(r.keywords) ? r.keywords : []).map((k) => clean(k, 30).toLowerCase()).filter(Boolean).slice(0, 10);
      const reply = clean(r.reply, 300);
      if (!keywords.length || !reply) return { error: "Har rule me keywords aur reply dono chahiye." };
      d.rules.push({ keywords, reply, cooldown: int(r.cooldown, 5, 3600) || 30 });
    }
    const sched = Array.isArray(body.schedule) ? body.schedule : [];
    if (sched.length > 10) return { error: "Max 10 scheduled messages." };
    d.schedule = [];
    for (const s of sched) {
      const everyMin = int(s.everyMin, 5, 1440), content = clean(s.content, 300);
      if (everyMin === null) return { error: "Schedule: har kitne minute (5 se 1440) sahi likho." };
      if (!content || !["text", "ai"].includes(s.mode)) return { error: "Schedule me message/instruction aur type chahiye." };
      d.schedule.push({ everyMin, mode: s.mode, content });
    }
    return { data: d };
  }

  /* ───────── Bots ───────── */
  api.get("/bots", need("bots.manage"), wrap(async (req, res) => {
    const e = eng();
    res.json({ bots: (await e.Bot.find().sort({ createdAt: 1 }).lean()).map(view), ai: e.aiStatus(), max: e.MAX_BOTS });
  }));

  api.post("/bots", need("bots.manage", { reauth: true }), wrap(async (req, res) => {
    const e = eng(), name = String(req.body?.name || "").trim(), lower = name.toLowerCase();
    if (!e.NAME_RE.test(name)) return bad(res, "Bot ka naam 3-20 characters (letters, numbers, _) ka hona chahiye. Space nahi.");
    if (ctx.RESERVED.includes(lower)) return bad(res, "Ye naam allowed nahi hai.");
    if ((await e.Bot.countDocuments()) >= e.MAX_BOTS) return bad(res, `Max ${e.MAX_BOTS} bots allowed hain.`);
    if (await e.Bot.exists({ nameLower: lower })) return bad(res, "Is naam ka bot pehle se hai.");
    if (await User.exists({ usernameLower: lower })) return bad(res, "Is naam ka koi user pehle se hai. Dusra naam chuno.");
    const p = parse(req.body || {});
    if (p.error) return bad(res, p.error);
    const b = await e.Bot.create({ name, nameLower: lower, ...p.data, createdBy: req.adm.username });
    await e.refresh();
    await audit(req, "bot_create", name, { rooms: p.data.rooms, mode: p.data.replyMode });
    alert("info", "🤖 Naya bot", `**${req.adm.username}** ne bot **${name}** banaya.`);
    res.json({ ok: true, bot: view(b) });
  }));

  const getBot = async (req, res) => {
    if (!ctx.mongoose.isValidObjectId(req.params.id)) { bad(res, "Bot galat hai."); return null; }
    const b = await eng().Bot.findById(req.params.id);
    if (!b) { bad(res, "Bot nahi mila.", 404); return null; }
    return b;
  };

  api.post("/bots/:id", need("bots.manage", { reauth: true }), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    const p = parse(req.body || {});
    if (p.error) return bad(res, p.error);
    Object.assign(b, p.data, { updatedAt: new Date() });
    await b.save();
    await eng().refresh();
    await audit(req, "bot_update", b.name, { rooms: p.data.rooms, mode: p.data.replyMode, rules: p.data.rules.length, schedule: p.data.schedule.length, promptChars: p.data.prompt.length });
    res.json({ ok: true });
  }));

  // Hide / unhide aur on / off: turant, bina dobara password ke
  api.post("/bots/:id/hide", need("bots.manage"), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    if (typeof req.body?.hidden !== "boolean") return bad(res, "Galat request.");
    await eng().Bot.updateOne({ _id: b._id }, { hidden: req.body.hidden });
    await eng().refresh();
    await audit(req, req.body.hidden ? "bot_hide" : "bot_unhide", b.name);
    res.json({ ok: true });
  }));

  api.post("/bots/:id/enable", need("bots.manage"), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    if (typeof req.body?.enabled !== "boolean") return bad(res, "Galat request.");
    await eng().Bot.updateOne({ _id: b._id }, { enabled: req.body.enabled });
    await eng().refresh();
    await audit(req, req.body.enabled ? "bot_enable" : "bot_disable", b.name);
    res.json({ ok: true });
  }));

  api.post("/bots/:id/delete", need("bots.manage", { reauth: true }), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    await eng().Bot.deleteOne({ _id: b._id });
    await eng().refresh();
    await audit(req, "bot_delete", b.name);
    alert("info", "🗑 Bot delete hua", `**${req.adm.username}** ne bot **${b.name}** delete kiya.`);
    res.json({ ok: true });
  }));

  // Bot se seedha kuch bulwana
  api.post("/bots/:id/say", need("bots.manage"), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    const room = String(req.body?.room || ""), text = clean(req.body?.text, 400);
    if (!ROOM_IDS.has(room)) return bad(res, "Room galat hai.");
    if (text.length < 1) return bad(res, "Message likho.");
    if (!(await eng().say(b, room, text, { force: true }))) return bad(res, "Message nahi gaya (room band hai, maintenance hai, ya bot bahut zyada bol chuka hai).");
    await audit(req, "bot_say", b.name, { room, text });
    res.json({ ok: true });
  }));

  // Bot ko kaam do: AI instruction se message banata hai (preview). Post karne ke liye /say use hota hai.
  api.post("/bots/:id/do", need("bots.manage"), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    const room = String(req.body?.room || ""), instruction = clean(req.body?.instruction, 500);
    if (!ROOM_IDS.has(room)) return bad(res, "Room galat hai.");
    if (instruction.length < 3) return bad(res, "Bot ko batao kya karna hai.");
    try {
      const text = await eng().generate(b, instruction, room, null);
      if (!text) return bad(res, "Bot ne koi jawab nahi diya. Instruction badal kar try karo.");
      await audit(req, "bot_do_preview", b.name, { room, instruction });
      res.json({ ok: true, text });
    } catch (e) { bad(res, e.message); }
  }));

  api.post("/bots/:id/test", need("bots.manage"), wrap(async (req, res) => {
    const b = await getBot(req, res); if (!b) return;
    const text = clean(req.body?.text, 300), room = ROOM_IDS.has(req.body?.room) ? req.body.room : null;
    if (!text) return bad(res, "Test message likho.");
    try { res.json({ ok: true, text: await eng().generate(b, "", room, { name: "TestUser", text }) }); } catch (e) { bad(res, e.message); }
  }));

  /* ───────── Automations (safety) ───────── */
  api.get("/automod", need("bots.manage"), wrap(async (req, res) => {
    const recent = await AuditLog.find({ admin: "automod" }).sort({ at: -1 }).limit(15).lean();
    res.json({ cfg: eng().automod(), defaults: eng().AUTOMOD_DEFAULT, recent, ai: eng().aiStatus() });
  }));

  api.post("/automod", need("bots.manage", { reauth: true }), wrap(async (req, res) => {
    const b = req.body || {}, cur = eng().automod(), next = { ...cur };
    for (const k of ["enabled", "remind", "digest"]) if (typeof b[k] === "boolean") next[k] = b[k];
    const nums = { heatRemind: [1, 20], heatMute: [2, 40], muteMinutes: [0, 1440], reportMuteAt: [0, 50], reportMuteMinutes: [1, 10080], digestUtcHour: [0, 23] };
    for (const [k, [lo, hi]] of Object.entries(nums)) {
      if (b[k] === undefined) continue;
      const v = int(b[k], lo, hi);
      if (v === null) return bad(res, `${k}: ${lo} se ${hi} ke beech number do.`);
      next[k] = v;
    }
    if (next.heatMute < next.heatRemind) return bad(res, "Mute score, reminder score se chhota nahi ho sakta.");
    site.automod = next;
    await saveSetting("site", site);
    await audit(req, "automod_update", "site", { before: cur, after: next });
    res.json({ ok: true, cfg: next });
  }));
};
