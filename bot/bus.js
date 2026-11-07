"use strict";
// Website aur Discord bot ek hi process me chalte hain, isliye bridge ke events yahin se guzarte hain.
// Events:
//   site_message    (server -> bot)   {id, username, text}        site ka message Discord par bhejo
//   bridged         (bot -> server)   {siteId, discordId}         bheje gaye message ki Discord id save karo
//   site_reaction   (server -> bot)   {discordId, emoji, add}     site ka reaction Discord par lagao/hatao
//   discord_message (bot -> server)   {discordId, username, text} Discord ka message site par dikhao
//   discord_reaction(bot -> server)   {discordId, emoji, userId, add}
module.exports = new (require("events").EventEmitter)();
