"use strict";
// Discord channels <-> website rooms ka bridge: messages, reactions, edit/delete, reply.
const { Events, escapeMarkdown } = require("discord.js");
const bus = require("./bus");

const strip = (s) => String(s).replace(/️/g, ""); // ❤️ aur ❤ ko same maanne ke liye
const WEBHOOK_NAME = "Site Bridge";

function setupBridge(client, channelIds) {
  const NO_PING = { parse: [] };
  const ids = new Set(channelIds);
  const channel = (id) => client.channels.fetch(id);
  const useHooks = process.env.BRIDGE_WEBHOOK !== "0";           // BRIDGE_WEBHOOK=0 se webhook band
  const avatarURL = process.env.BRIDGE_AVATAR_URL || undefined;  // optional: site ke users ka common avatar
  const hooks = new Map(), hookFailed = new Set();

  /* Webhook: site ke message ko site user ke naam se dikhata hai. Na bane to normal bot message jata hai. */
  async function getHook(ch) {
    if (!useHooks || hookFailed.has(ch.id) || typeof ch.fetchWebhooks !== "function") return null;
    if (hooks.has(ch.id)) return hooks.get(ch.id);
    try {
      const list = await ch.fetchWebhooks();
      let h = list.find((w) => w.owner?.id === client.user.id && w.name === WEBHOOK_NAME);
      if (!h) h = await ch.createWebhook({ name: WEBHOOK_NAME, reason: "Site <-> Discord bridge" });
      hooks.set(ch.id, h);
      return h;
    } catch (e) {
      hookFailed.add(ch.id);
      console.error(`⚠️  Bridge: channel ${ch.id} me webhook nahi bana, normal bot message use honge. Bot ko Manage Webhooks permission do. (${e.message})`);
      return null;
    }
  }

  /* Site -> Discord: message (reply ho to upar quote line) */
  bus.on("site_message", async ({ id, channelId, username, text, replyTo }) => {
    try {
      if (!ids.has(channelId)) return;
      const ch = await channel(channelId);
      const quote = replyTo ? `> ↪ **${escapeMarkdown(String(replyTo.username))}**: ${escapeMarkdown(String(replyTo.text || "")).slice(0, 100)}\n` : "";
      let sent = null;
      const hook = await getHook(ch);
      if (hook) {
        try {
          sent = await hook.send({ content: `${quote}${text}`.slice(0, 2000), username: `${username} · site`.slice(0, 80), avatarURL, allowedMentions: NO_PING });
        } catch (e) { console.error("bridge webhook send:", e.message, "→ normal message"); }
      }
      if (!sent) sent = await ch.send({ content: `🌐 **${escapeMarkdown(username)}:** ${quote ? "\n" + quote : ""}${text}`.slice(0, 2000), allowedMentions: NO_PING });
      bus.emit("bridged", { siteId: id, discordId: sent.id });
    } catch (e) { console.error("bridge site->discord message:", e.message); }
  });

  /* Site -> Discord: reaction (Discord me bot ka apna reaction lagta hai) */
  bus.on("site_reaction", async ({ channelId, discordId, emoji, add }) => {
    try {
      if (!ids.has(channelId)) return;
      const msg = await (await channel(channelId)).messages.fetch(discordId);
      if (add) await msg.react(emoji);
      else await msg.reactions.cache.find((r) => !r.emoji.id && strip(r.emoji.name) === strip(emoji))?.users.remove(client.user.id);
    } catch (e) { console.error("bridge site->discord reaction:", e.message); }
  });

  /* Site -> Discord: admin ne site se message delete kiya */
  bus.on("site_delete", async ({ channelId, discordId }) => {
    try {
      if (!ids.has(channelId)) return;
      const ch = await channel(channelId);
      const msg = await ch.messages.fetch(discordId);
      try { await msg.delete(); }
      catch (e) {
        const hook = msg.webhookId && hooks.get(channelId);           // bridge ka apna webhook message ho to permission ke bina bhi hat jata hai
        if (hook && hook.id === msg.webhookId) await hook.deleteMessage(msg.id);
        else throw e;
      }
    } catch (e) { console.error("bridge site->discord delete (bot ko Manage Messages permission chahiye):", e.message); }
  });

  /* Discord message ka saaf text: mentions naam ban jate hain, custom emoji :naam:, attachment ka naam */
  const cleanText = (m) => {
    let text = (m.cleanContent || "").replace(/<a?:(\w+):\d+>/g, ":$1:");
    for (const a of m.attachments?.values?.() || []) text += `${text ? " " : ""}[📎 ${a.name || "file"}]`;
    return text.trim();
  };
  const nameOf = (m) => m.member?.displayName || m.author?.globalName || m.author?.username || "Discord user";

  /* Discord -> Site: message (+ reply) */
  client.on(Events.MessageCreate, async (m) => {
    try {
      if (!ids.has(m.channelId) || m.author.bot || m.webhookId || m.system) return;
      const text = cleanText(m);
      if (!text) return;
      let reply = null;
      if (m.reference?.messageId) {
        reply = { discordId: m.reference.messageId };
        try { const r = await m.fetchReference(); reply = { discordId: r.id, username: nameOf(r), text: cleanText(r) }; } catch {}
      }
      bus.emit("discord_message", { channelId: m.channelId, discordId: m.id, userId: m.author.id, username: nameOf(m), text, reply });
    } catch (e) { console.error("bridge discord->site message:", e.message); }
  });

  /* Discord -> Site: edit */
  client.on(Events.MessageUpdate, async (oldM, newM) => {
    try {
      if (!ids.has(newM.channelId)) return;
      if (newM.partial) newM = await newM.fetch();
      if (newM.author?.bot || newM.webhookId) return;
      if (oldM.content != null && oldM.content === newM.content) return; // sirf embed/link preview badla
      const text = cleanText(newM);
      if (text) bus.emit("discord_edit", { channelId: newM.channelId, discordId: newM.id, text });
    } catch (e) { console.error("bridge discord->site edit:", e.message); }
  });

  /* Discord -> Site: delete */
  client.on(Events.MessageDelete, (m) => {
    if (ids.has(m.channelId)) bus.emit("discord_delete", { channelId: m.channelId, ids: [m.id] });
  });
  client.on(Events.MessageBulkDelete, (col, ch) => {
    if (ids.has(ch.id)) bus.emit("discord_delete", { channelId: ch.id, ids: [...col.keys()] });
  });

  /* Discord -> Site: reactions */
  const onReaction = (add) => async (reaction, user) => {
    try {
      if (user.partial) await user.fetch();
      if (user.bot || user.id === client.user.id) return;
      if (reaction.partial) await reaction.fetch();
      if (!ids.has(reaction.message.channelId) || reaction.emoji.id) return; // custom emoji site par nahi dikhte
      bus.emit("discord_reaction", { channelId: reaction.message.channelId, discordId: reaction.message.id, emoji: reaction.emoji.name, userId: user.id, add });
    } catch (e) { console.error("bridge discord->site reaction:", e.message); }
  };
  client.on(Events.MessageReactionAdd, onReaction(true));
  client.on(Events.MessageReactionRemove, onReaction(false));

  console.log(`🔗 Discord bridge on: ${ids.size} channel(s)`);
}

module.exports = { setupBridge };
