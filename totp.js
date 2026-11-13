"use strict";
// RFC 6238 TOTP (Google Authenticator / Authy / Microsoft Authenticator jaise apps ke saath chalta hai). Koi external library nahi.
const crypto = require("crypto");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32encode(buf) {
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

function b32decode(str) {
  let bits = "";
  for (const ch of String(str).replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("bad base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

const newSecret = () => b32encode(crypto.randomBytes(20));

const eq = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// Sahi code par us time-step ka number lautata hai (replay rokne ke liye save karo), warna null.
// lastStep: pehle use hua step. Usse purana ya barabar code reject hota hai.
function verify(secretB32, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const key = b32decode(secretB32);
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s <= lastStep) continue;
    if (eq(hotp(key, s), String(code))) return s;
  }
  return null;
}

module.exports = { b32encode, b32decode, hotp, newSecret, verify };
