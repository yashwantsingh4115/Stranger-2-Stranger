"use strict";
const { SlashCommandBuilder } = require("discord.js");

const user = (name, desc) => new SlashCommandBuilder().setName(name).setDescription(desc)
  .addStringOption((o) => o.setName("username").setDescription("Website ka username").setRequired(true));

const commands = [
  new SlashCommandBuilder().setName("status").setDescription("Website ka status aur stats"),
  new SlashCommandBuilder().setName("online").setDescription("Abhi kaun online hai"),
  new SlashCommandBuilder().setName("reports").setDescription("Saare open reports"),
  user("user", "User ki details dekho"),
  user("ban", "User ko ban karo").addStringOption((o) => o.setName("reason").setDescription("Reason").setMaxLength(150)),
  user("unban", "User ko unban karo"),
  user("kick", "User ko logout karo (ban nahi)"),
  new SlashCommandBuilder().setName("bridge").setDescription("Discord <-> website bridge on/off")
    .addStringOption((o) => o.setName("action").setDescription("Kya karna hai").setRequired(true).addChoices(
      { name: "Band karo (off)", value: "off" }, { name: "Chalu karo (on)", value: "on" }, { name: "Status dekho", value: "status" }))
    .addStringOption((o) => o.setName("room").setDescription("Room id, jaise general (khali = saare rooms)")),
  new SlashCommandBuilder().setName("slowmode").setDescription("Website room me slowmode lagao")
    .addIntegerOption((o) => o.setName("seconds").setDescription("Kitne second (0 = band)").setRequired(true).setMinValue(0).setMaxValue(300))
    .addStringOption((o) => o.setName("room").setDescription("Room id, jaise general (khali = saare rooms)")),
  new SlashCommandBuilder().setName("announce").setDescription("Website par announcement bhejo")
    .addStringOption((o) => o.setName("text").setDescription("Message (max 200 chars)").setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName("room").setDescription("Kis room me (default: sab)").addChoices(
      { name: "Sab rooms", value: "all" },
      { name: "General", value: "general" },
      { name: "International", value: "international" },
      { name: "Indo-Pak Dosti", value: "indopak" },
      { name: "Make Friends", value: "friends" },
      // { name: "Hindi Chat", value: "hindi" },
      // { name: "Gaming", value: "gaming" },
      // { name: "Music", value: "music" },
      // { name: "Movies & Series", value: "movies" },
      // { name: "Tech", value: "tech" },
      // { name: "Study", value: "study" },
    )),
].map((c) => c.toJSON());

module.exports = { commands };
