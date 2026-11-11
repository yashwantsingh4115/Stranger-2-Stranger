# 💬 Chatroom + Discord bot (ek hi service)

Node.js + Express + Socket.IO + MongoDB + discord.js. Website aur Discord bot ek hi process me chalte hain.

## Chalana
```
npm install
copy .env.example .env     (Mac/Linux: cp .env.example .env)
npm start
```

## Render par (ek service)
- Build Command: `npm install`
- Start Command: `node server.js`
- Environment me `.env.example` ke variables daalo (Add from .env se paste kar sakte ho)
- `DISCORD_TOKEN` na ho to sirf website chalegi

## Features
Website: rooms, DM, random 1-to-1 chat, profile, block/report, bad-word filter, ban appeal, secure admin panel (neeche).
Discord bot: report alerts (Ban/Dismiss buttons), health alerts, `/status /online /reports /user /ban /unban /kick /announce`.

## Auto-clear
Rooms ka chat `ROOM_CLEAR_MINUTES` (default 20) baad server se delete hota hai aur screen se bhi hat jata hai. DM delete nahi hote (`MESSAGE_TTL_DAYS=0`). Report ka context alag save rehta hai, isliye reports me proof bachta hai.

## 🛡️ Admin panel (alag password + 2FA)

Admin panel normal users ke username+DOB login se **bilkul alag** hai. Admin ka apna password (bcrypt) aur authenticator-app 2FA hota hai.

### Pehli baar setup
1. Render Environment me ye daalo: `ADMIN_SETUP_KEY` (30+ random characters) aur chaho to `ADMIN_PATH=/panel-koi-secret-naam`.
2. Deploy karo, phir `https://tumhari-site/ADMIN_PATH` kholo (default `/admin`). Setup form dikhega.
3. Setup key + owner username + password (12+ characters, letters+numbers) daalo.
4. Authenticator app (Google Authenticator / Authy) me QR scan karo, code daalo, aur **8 recovery codes save karo** (dobara nahi dikhte).
5. Ab `ADMIN_SETUP_KEY` Render se hata do (owner banne ke baad setup waise bhi band ho jata hai).

### Roles
| | Moderator | Admin | Owner |
|---|---|---|---|
| Reports, users dekhna, warn, mute, temp-ban, ban, notes, message delete, live monitor, appeals dekhna | ✅ | ✅ | ✅ |
| Unban, unlock, force logout, bulk, export CSV, analytics, announce, rooms, bad words, appeals decide, audit log, health | ❌ | ✅ | ✅ |
| Site settings (maintenance, read-only, registration, banner, min age), admin accounts, server logs | ❌ | ❌ | ✅ |

### Security
- Alag admin password + **2FA zaroori** (bina 2FA ke panel ke features khulte hi nahi). 2FA secret database me encrypted.
- Session cookie `HttpOnly`, `SameSite=Strict`, sirf panel ke path par bheji jati hai. Idle **30 min** me logout, max 8 ghante. Ek admin = ek active session.
- Ban, unban, export, settings, admin accounts, bulk, bad-words par **dobara password** (5 min tak valid).
- 5 galat koshish par 15 min lock + IP rate limit. Galat/naye IP se login par **Discord alert**.
- Login ke bina panel ke saare routes **404** dete hain, `noindex` header lagta hai. `ADMIN_IPS` se IP allowlist laga sakte ho.
- Har admin kaam **audit log** me (kisne, kab, kya, kis IP se). Audit log code se badla/hataya nahi ja sakta. Discord bot ke ban/unban bhi isme aate hain.
- Har request par CSRF token + same-origin check.

### Moderation
Warn (3 warnings par auto-ban, number settings me), mute (padh sakta hai, likh nahi), temp-ban (1 ghanta se 30 din), permanent ban, private notes, user detail, bulk actions, live room monitor (read-only, kholna audit hota hai), reported message delete, 3+ alag logon ki report par auto-flag alert, ban appeal (banned user login page se appeal bhejta hai).

### Users kabhi delete nahi hote
Users par TTL nahi hai aur code se delete bhi block hai (ban sirf flag lagata hai). Admin panel me **Export CSV (backup)** hai. Dashboard 7 din se purane backup par yaad dilata hai. `MONGO_URI` ka database naam kabhi mat badalna.

### Note
`ADMIN_USERS` ab sirf chat me message-delete button aur "ye user ban nahi ho sakta" protection ke liye hai. Admin panel ka access isse nahi milta.

## Structure
```
server.js, filter.js     website backend
admin.js, admin-features.js, totp.js   admin panel backend (auth, 2FA, features)
admin/                   admin panel frontend (ADMIN_PATH par serve hota hai)
bot/                     discord bot (server.js isse start karta hai)
public/                  frontend
```

## Discord bridge (channels <-> site rooms)
1. Discord Developer Portal -> Bot -> **Message Content Intent** ON karo.
2. Bot ko bridge wale channels me ye permissions do: View Channel, Send Messages, Read Message History, Add Reactions, **Manage Webhooks** (site ke naam se message dikhane ke liye), **Manage Messages** (site se delete sync ke liye).
3. Render env: `BRIDGES=channelId:roomId,channelId:roomId,...` (jitne chahiye).
4. Redeploy. Bridge wale rooms sidebar me 🔗 se dikhte hain.

Kya sync hota hai: messages, reactions, reply, Discord me edit/delete, site par admin delete.

Discord commands (admin only): `/bridge on|off|status [room]`, `/slowmode seconds [room]`.

Env (optional): `BLOCK_LINKS=discord|all|off`, `BRIDGE_WEBHOOK=0` (webhook band), `BRIDGE_AVATAR_URL`.
