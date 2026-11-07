"use strict";
// Ek Discord channel <-> website ke ek room ka bridge (messages + reactions, dono taraf).
const { Events, escapeMarkdown } = require("discord.js");
const bus = require("./bus");

const strip = (s) => String(s).replace(/️/g, ""); // ❤️ aur ❤ ko same maanne ke liye

function setupBridge(client, channelIds) {
  const NO_PING = { parse: [] };
  const ids = new Set(channelIds);
  const channel = (id) => client.channels.fetch(id);

  /* Site -> Discord: message */
  bus.on("site_message", async ({ id, channelId, username, text }) => {
    try {
      if (!ids.has(channelId)) return;
      const ch = await channel(channelId);
      const sent = await ch.send({ content: `🌐 **${escapeMarkdown(username)}:** ${text}`.slice(0, 2000), allowedMentions: NO_PING });
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

  /* Discord -> Site: message */
  client.on(Events.MessageCreate, (m) => {
    if (!ids.has(m.channelId) || m.author.bot || m.webhookId || m.system) return;
    let text = (m.cleanContent || "").replace(/<a?:(\w+):\d+>/g, ":$1:");
    for (const a of m.attachments.values()) text += `${text ? " " : ""}[📎 ${a.name || "file"}]`;
    text = text.trim();
    if (!text) return;
    bus.emit("discord_message", { channelId: m.channelId, discordId: m.id, username: m.member?.displayName || m.author.globalName || m.author.username, text });
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
