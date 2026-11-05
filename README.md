# 💬 Chatroom (Stranger-chat style)

Node.js + Express + Socket.IO + MongoDB. White theme.

## Setup
```
npm install
copy .env.example .env      (Mac/Linux: cp .env.example .env)
npm start
```
`.env` me `MONGO_URI`, `DOB_PEPPER`, `ADMIN_USERS` bharo. Phir http://localhost:3000

## Features
- Username + DOB login (naya username = auto account, DOB hash me save, username unique)
- 8 chat rooms (General, Hindi, Friends, Gaming, Music, Movies, Tech, Study) + live online list
- Private messages (DM) with unread badge
- Random 1-to-1 stranger chat (anonymous), Next/Stop, optional interest match
- Optional profile: gender + country
- Block / Unblock, Report (room, DM, random)
- Bad-word mask, links aur phone numbers auto-remove, spam/rate limit
- Admin panel `/admin.html`: reports dekho, user ban/unban

## Admin kaise banao
1. `.env` me `ADMIN_USERS=tumhara_username`
2. Server chalao aur **pehle khud** us username se login (register) karo
3. Chat me "Admin" button dikhega

## Security
- DOB: HMAC(pepper) + bcrypt. 5 galat DOB par 15 min lock. IP rate limit.
- httpOnly + SameSite=Strict cookie, session token hashed, strict CSP, same-origin check
- XSS-safe rendering, input validation, message rate limit
- Ban account-level hai (IP ban nahi), banned user naye username se aa sakta hai

## Structure
```
server.js, filter.js     backend
public/index.html        login
public/chat.html         chat app
public/admin.html        admin
public/rules.html        rules
public/js, css           frontend
```
