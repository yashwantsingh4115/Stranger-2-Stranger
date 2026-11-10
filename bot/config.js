"use strict";
// BRIDGES=channelId:roomId,channelId:roomId,...  (jitne chahiye utne)
// Purana tarika bhi chalta hai: BRIDGE_CHANNEL_ID (+ BRIDGE_ROOM) = sirf ek channel.
// Har Discord channel ek site room se juda hota hai, aur ek room ek hi channel se.
function parseBridges(env, defaultRoom) {
  const clean = (s) => String(s || "").replace(/["'\s]/g, "");
  const out = [], seenCh = new Set(), seenRoom = new Set();
  const add = (channelId, room) => {
    if (!/^\d{5,25}$/.test(channelId)) return console.error(`⚠️  Bridge: "${channelId}" sahi channel ID nahi hai, skip kiya.`);
    if (seenCh.has(channelId)) return console.error(`⚠️  Bridge: channel ${channelId} do baar likha hai, skip kiya.`);
    if (seenRoom.has(room)) return console.error(`⚠️  Bridge: room "${room}" ek hi channel se jud sakta hai, ${channelId} skip kiya.`);
    seenCh.add(channelId); seenRoom.add(room); out.push({ channelId, room });
  };
  for (const part of clean(env.BRIDGES).split(",").filter(Boolean)) {
    const [ch, room] = part.split(":");
    add(ch, room || defaultRoom);
  }
  if (!out.length && clean(env.BRIDGE_CHANNEL_ID)) add(clean(env.BRIDGE_CHANNEL_ID), clean(env.BRIDGE_ROOM) || defaultRoom);
  return out;
}
module.exports = { parseBridges };
