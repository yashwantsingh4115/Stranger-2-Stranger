"use strict";
// Simple message filter: gaali mask karta hai, links aur phone numbers hata deta hai.
const STRICT = ["dick", "cunt", "slut", "lund", "chut", "gand", "porn", "rape"];            // poora word match
const LOOSE = ["fuck", "shit", "bitch", "asshole", "bastard", "pussy", "whore", "nigger", "nigga", "faggot",
  "madarchod", "behenchod", "bhenchod", "benchod", "chutiya", "chutiye", "gandu", "gaandu", "randi", "bhosdike", "bhosdi", "harami", "lavda", "lauda"];
const MAP = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

const LOOSE_RE = new RegExp(`(?:${LOOSE.join("|")})`, "g");
const STRICT_RE = new RegExp(`(?<![a-z])(?:${STRICT.join("|")})(?![a-z])`, "g");
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|in|io|me|xyz|co|ly|gg|app|link)\b\S*/gi;
const PHONE_RE = /\+?\d(?:[\s().-]?\d){9,}/g;

function moderate(text) {
  const units = text.split("");
  const norm = units.map((u) => { const l = u.toLowerCase(); const c = l.length === 1 ? l : u; return MAP[c] || c; }).join("");
  for (const re of [LOOSE_RE, STRICT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(norm))) {
      for (let i = m.index; i < m.index + m[0].length; i++) units[i] = "*";
      if (!m[0].length) re.lastIndex++;
    }
  }
  return units.join("").replace(URL_RE, "[link removed]").replace(PHONE_RE, "[number removed]");
}

module.exports = { moderate };
