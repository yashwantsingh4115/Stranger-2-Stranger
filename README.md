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
Website: rooms, DM, random 1-to-1 chat, profile, block/report, bad-word filter, admin panel (`/admin.html`).
Discord bot: report alerts (Ban/Dismiss buttons), health alerts, `/status /online /reports /user /ban /unban /kick /announce`.

## Auto-clear
Rooms ka chat `ROOM_CLEAR_MINUTES` (default 20) baad server se delete hota hai aur screen se bhi hat jata hai. DM delete nahi hote (`MESSAGE_TTL_DAYS=0`). Report ka context alag save rehta hai, isliye reports me proof bachta hai.

## Admin
`ADMIN_USERS=tumhara_username` set karo aur deploy ke baad **pehle khud us username se login** karo.

## Structure
```
server.js, filter.js     website backend
bot/                     discord bot (server.js isse start karta hai)
public/                  frontend
```
