"use strict";
// Discord bot: website ke saath usi process me chalta hai (server.js isko start() se chalata hai).
const fs = require("fs");
const path = require("path");
const {
  Client, GatewayIntentBits, Events, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ActivityType, MessageFlags, Partials,
} = require("discord.js");
const { setupBridge } = require("./bridge");
const { parseBridges } = require("./config");
const { commands } = require("./commands");
const bus = require("./bus");

function start({ apiBase, apiKey, siteUrl }) {
  const env = process.env;
  const must = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "REPORT_CHANNEL_ID"];
  const missing = must.filter((k) => !env[k]);
  if (missing.length) { console.error("⚠️  Discord bot start nahi hua. Env me missing:", missing.join(", ")); return; }
  const ADMIN_IDS = new Set((env.ADMIN_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (!env.ADMIN_ROLE_ID && !ADMIN_IDS.size) { console.error("⚠️  Discord bot start nahi hua. ADMIN_ROLE_ID ya ADMIN_DISCORD_IDS set karo."); return; }

  const BASE = apiBase;                                   // website ka andar ka address (127.0.0.1)
  const SITE = String(siteUrl || "").replace(/\/+$/, ""); // public URL (health check + keep-alive)
  const ALERT_CHANNEL = env.ALERT_CHANNEL_ID || env.REPORT_CHANNEL_ID;
  const STATE_FILE = path.join(__dirname, "state.json");
  // Bridge set ho tabhi extra intents maangte hain (Message Content intent Developer Portal me on hona chahiye)
  const BRIDGE_CHANNELS = parseBridges(env, "general").map((b) => b.channelId);
  const intents = [GatewayIntentBits.Guilds];
  if (BRIDGE_CHANNELS.length) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions);
  const client = new Client({ intents, partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User] });
  if (BRIDGE_CHANNELS.length) setupBridge(client, BRIDGE_CHANNELS);

/* ───────── Website API ───────── */
async function api(p, { method = "GET", body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000); // Render free plan ko uthne me time lagta hai
  try {
    const r = await fetch(`${BASE}/api/bot${p}`, {
      method, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Website ne HTTP ${r.status} diya`);
    return d;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Website ne time par jawab nahi diya." : e.message);
  } finally { clearTimeout(t); }
}

/* ───────── Helpers ───────── */
const isAdmin = (i) => ADMIN_IDS.has(i.user.id) || (env.ADMIN_ROLE_ID && i.member?.roles?.cache?.has(env.ADMIN_ROLE_ID));
const NO_PING = { parse: [] };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const fmtUp = (sec) => { const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return `${d ? d + "d " : ""}${h}h ${m}m`; };
const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;

async function sendTo(channelId, payload) {
  const ch = await client.channels.fetch(channelId);
  return ch.send({ allowedMentions: NO_PING, ...payload });
}

/* ───────── Slash commands ───────── */
async function handleCommand(i) {
  const name = i.commandName;
  const eph = ["online", "reports", "user"].includes(name);
  await i.deferReply(eph ? { flags: MessageFlags.Ephemeral } : {});
  const username = i.options.getString("username");

  if (name === "status") {
    const s = await api("/stats");
    const e = new EmbedBuilder().setColor(0x16a34a).setTitle("🟢 Website online").setURL(SITE || null)
      .addFields(
        { name: "👥 Online abhi", value: String(s.online), inline: true },
        { name: "🎲 Random queue", value: String(s.randomQueue), inline: true },
        { name: "⏱️ Uptime", value: fmtUp(s.uptimeSec), inline: true },
        { name: "👤 Total users", value: String(s.totalUsers), inline: true },
        { name: "🆕 Naye (24h)", value: String(s.newUsers24h), inline: true },
        { name: "💬 Messages", value: `${s.roomMessages} room (restart ke baad) · ${s.dms24h} DM (24h)`, inline: true },
        { name: "🚩 Open reports", value: String(s.openReports), inline: true },
        { name: "⛔ Banned", value: String(s.banned), inline: true },
        { name: "Rooms", value: Object.entries(s.rooms).map(([n, c]) => `${n}: **${c}**`).join(" · ") || "-" },
      ).setTimestamp();
    return i.editReply({ embeds: [e] });
  }

  if (name === "online") {
    const { users } = await api("/online");
    const text = users.length ? users.slice(0, 60).map((u) => `• ${u.username}${u.room ? ` (${u.room})` : ""}`).join("\n") : "Abhi koi online nahi hai.";
    return i.editReply({ content: `**👥 Online (${users.length})**\n${clip(text, 1800)}`, allowedMentions: NO_PING });
  }

  if (name === "reports") {
    const { reports } = await api("/reports");
    if (!reports.length) return i.editReply("Koi open report nahi hai. 🎉");
    const text = reports.map((r) => `• **${r.target}** ← ${r.reporter} · ${r.reason} · ${r.where} · ${ts(r.createdAt)}`).join("\n");
    return i.editReply({ content: `**🚩 Open reports (${reports.length})**\n${clip(text, 1800)}`, allowedMentions: NO_PING });
  }

  if (name === "user") {
    const u = await api(`/user/${encodeURIComponent(username)}`);
    const e = new EmbedBuilder().setColor(u.banned ? 0xdc2626 : 0x4f46e5).setTitle(`👤 ${u.username}`)
      .addFields(
        { name: "Status", value: u.banned ? `⛔ Banned${u.banReason ? ` (${clip(u.banReason, 100)})` : ""}` : u.online ? "🟢 Online" : "⚪ Offline", inline: true },
        { name: "Gender / Country", value: `${u.gender || "-"} / ${u.country || "-"}`, inline: true },
        { name: "Joined", value: ts(u.createdAt), inline: true },
        { name: "Last login", value: ts(u.lastLoginAt), inline: true },
        { name: "Reports against", value: String(u.reportsAgainst), inline: true },
        { name: "Reports filed", value: String(u.reportsBy), inline: true },
      );
    return i.editReply({ embeds: [e] });
  }

  if (name === "ban") {
    const reason = i.options.getString("reason") || "Discord se ban";
    await api("/ban", { method: "POST", body: { username, reason: `${reason} (by ${i.user.tag})` } });
    return i.editReply({ content: `⛔ **${username}** ban ho gaya. Reason: ${reason}`, allowedMentions: NO_PING });
  }
  if (name === "unban") {
    await api("/unban", { method: "POST", body: { username } });
    return i.editReply({ content: `✅ **${username}** unban ho gaya.`, allowedMentions: NO_PING });
  }
  if (name === "kick") {
    await api("/kick", { method: "POST", body: { username } });
    return i.editReply({ content: `👢 **${username}** logout kar diya gaya.`, allowedMentions: NO_PING });
  }
  if (name === "bridge") {
    const act = i.options.getString("action"), room = i.options.getString("room") || "";
    const info = act === "status" ? await api("/bridge") : await api("/bridge", { method: "POST", body: { action: act, room } });
    const lines = info.channels.map((c) => `${c.active ? "✅" : "⛔"} **${c.room}** ↔ <#${c.channelId}>`).join("\n") || "Koi bridge set nahi hai.";
    const head = act === "status" ? "🔗 **Bridge status**" : act === "off" ? "⛔ **Bridge band kiya**" : "✅ **Bridge chalu kiya**";
    return i.editReply({ content: `${head}\n${lines}`, allowedMentions: NO_PING });
  }
  if (name === "slowmode") {
    const seconds = i.options.getInteger("seconds"), room = i.options.getString("room") || "";
    await api("/slowmode", { method: "POST", body: { seconds, room } });
    return i.editReply({ content: seconds ? `🐢 Slowmode ${seconds}s (${room || "saare rooms"})` : `🐇 Slowmode band (${room || "saare rooms"})`, allowedMentions: NO_PING });
  }
  if (name === "announce") {
    const text = i.options.getString("text"), room = i.options.getString("room") || "all";
    await api("/announce", { method: "POST", body: { text, room } });
    return i.editReply({ content: `📢 Bhej diya (${room}): ${text}`, allowedMentions: NO_PING });
  }
}

/* ───────── Report buttons ───────── */
async function handleButton(i) {
  const [action, id, target] = i.customId.split("|");
  await i.deferUpdate();
  let footer;
  if (action === "ban") {
    await api("/ban", { method: "POST", body: { username: target, reason: `Report action (by ${i.user.tag})` } });
    footer = `⛔ ${target} ko ${i.user.tag} ne ban kiya`;
  } else if (action === "dismiss") {
    await api("/dismiss", { method: "POST", body: { id } });
    footer = `✅ ${i.user.tag} ne dismiss kiya`;
  } else return;
  const emb = EmbedBuilder.from(i.message.embeds[0]).setColor(action === "ban" ? 0xdc2626 : 0x6b7280).setFooter({ text: footer });
  await i.editReply({ embeds: [emb], components: [] });
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.guildId !== env.DISCORD_GUILD_ID) return;
    if (!i.isChatInputCommand() && !i.isButton()) return;
    if (!isAdmin(i)) return i.reply({ content: "⛔ Tumhe ye use karne ki permission nahi hai.", flags: MessageFlags.Ephemeral });
    if (i.isChatInputCommand()) await handleCommand(i); else await handleButton(i);
  } catch (e) {
    console.error("interaction error:", e.message);
    const msg = `❌ ${clip(e.message, 300)}`;
    if (i.deferred || i.replied) i.editReply({ content: msg }).catch(() => {});
    else i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

/* ───────── New report alerts (har 30 sec) ───────── */
let state = { lastReportAt: new Date().toISOString() };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };

let polling = false;
async function pollReports() {
  if (polling) return;
  polling = true;
  try {
    const { reports } = await api(`/reports?since=${encodeURIComponent(state.lastReportAt)}`);
    for (const r of reports) {
      const ctx = (r.context || []).slice(-8).map((c) => `${c.from}: ${c.text}`).join("\n").replace(/```/g, "'''") || "(no context)";
      const e = new EmbedBuilder().setColor(0xf59e0b).setTitle("🚩 Naya report")
        .addFields(
          { name: "Reported user", value: clip(r.target, 40), inline: true },
          { name: "Reported by", value: clip(r.reporter, 40), inline: true },
          { name: "Reason", value: `${r.reason} · ${r.where}`, inline: true },
          { name: "Context", value: "```\n" + clip(ctx, 900) + "\n```" },
        ).setTimestamp(new Date(r.createdAt));
      const fromDiscord = String(r.target).endsWith(" [Discord]"); // Discord user ka site par account nahi, isliye sirf Dismiss
      const row = new ActionRowBuilder();
      if (!fromDiscord) row.addComponents(new ButtonBuilder().setCustomId(`ban|${r._id}|${r.target}`).setLabel("Ban user").setStyle(ButtonStyle.Danger));
      row.addComponents(new ButtonBuilder().setCustomId(`dismiss|${r._id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary));
      if (fromDiscord) e.addFields({ name: "Note", value: "Ye Discord user hai. Mute/ban Discord me hi karo, aur message ko Discord se delete karoge to site se bhi hat jayega." });
      await sendTo(env.REPORT_CHANNEL_ID, { embeds: [e], components: [row] });
      state.lastReportAt = new Date(r.createdAt).toISOString();
      saveState();
    }
  } catch (e) { console.error("report poll:", e.message); }
  polling = false;
}

/* ───────── Uptime monitor (har 60 sec) ───────── */
let fails = 0, down = false, downSince = 0;
async function checkSite() {
  let ok = false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try { ok = (await fetch(`${SITE}/health`, { signal: ctrl.signal })).ok; } catch {}
  clearTimeout(t);
  const ping = env.ADMIN_ROLE_ID ? `<@&${env.ADMIN_ROLE_ID}> ` : "";
  const allowed = env.ADMIN_ROLE_ID ? { roles: [env.ADMIN_ROLE_ID] } : NO_PING;
  if (ok) {
    if (down) {
      down = false;
      sendTo(ALERT_CHANNEL, { content: `✅ Website health check wapas theek hai. (~${Math.round((Date.now() - downSince) / 60000)} min problem thi)` }).catch(() => {});
    }
    fails = 0;
  } else if (++fails >= 3 && !down) {
    down = true; downSince = Date.now();
    sendTo(ALERT_CHANNEL, { content: `${ping}🚨 **Website health check fail ho raha hai!** ${SITE} 3 baar se theek jawab nahi de rahi (DB ya server problem ho sakti hai).`, allowedMentions: allowed }).catch(() => {});
  }
}

/* ───────── Bot status (kitne online) ───────── */
async function updatePresence() {
  try {
    const s = await api("/stats");
    client.user.setActivity(`${s.online} online · ${s.openReports} reports`, { type: ActivityType.Watching });
  } catch { client.user.setActivity("website check kar raha hoon…", { type: ActivityType.Watching }); }
}

  /* ───────── Start ───────── */
  client.once(Events.ClientReady, async () => {
    console.log(`✅ Discord bot login: ${client.user.tag}`);
    try {
      await new REST({ version: "10" }).setToken(env.DISCORD_TOKEN)
        .put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body: commands });
      console.log("✅ Slash commands register ho gaye");
    } catch (e) { console.error("❌ Commands register nahi hue:", e.message); }
    setInterval(pollReports, 30 * 1000);
    setInterval(updatePresence, 60 * 1000);
    updatePresence(); pollReports();
    if (SITE) { setInterval(checkSite, 60 * 1000); checkSite(); } // ye Render ko jagaye bhi rakhta hai
  });

  // Website ke admin panel ke security alerts (naya login, galat password, ban, export, settings...)
  bus.on("admin_alert", ({ level, title, text }) => {
    const color = { danger: 0xdc2626, warn: 0xf59e0b, info: 0x4f46e5 }[level] || 0x4f46e5;
    const e = new EmbedBuilder().setColor(color).setTitle(String(title).slice(0, 200)).setDescription(String(text).slice(0, 1800)).setTimestamp();
    const ping = level === "danger" && ROLE_ID ? `<@&${ROLE_ID}> ` : "";
    sendTo(ALERT_CHANNEL, { content: ping || undefined, embeds: [e], allowedMentions: ping ? { roles: [ROLE_ID] } : NO_PING }).catch((err) => console.error("admin alert:", err.message));
  });

  client.on(Events.Error, (e) => console.error("discord client error:", e.message));
  client.login(env.DISCORD_TOKEN).catch((e) => console.error("❌ Discord login fail (token check karo):", e.message));
}

module.exports = { start };
