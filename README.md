# 💬 Simple Chatroom

Ek simple realtime chatroom: **username + DOB** se login, data MongoDB me, Socket.IO se live chat.

## Setup
1. Node.js 18+ install karo
2. `npm install`
3. `.env.example` ko copy karke `.env` banao aur `MONGO_URI` + `DOB_PEPPER` bharo
4. `npm start` → http://localhost:3000

## Login kaise kaam karta hai
- Naya username → account ban jata hai (username + DOB save hota hai)
- Username already le liya gaya ho → sahi DOB ke bina login nahi hoga (dusra user wahi username use nahi kar sakta)
- Ek username ka ek hi active session: dusri jagah login karne par purana session logout ho jata hai

## Security
- DOB plain save nahi hoti: HMAC (pepper) + bcrypt hash
- Username case-insensitive unique (MongoDB unique index): `Rahul` aur `rahul` same maane jayenge
- 5 galat DOB ke baad account 15 min ke liye lock + IP rate limit
- Session token random hota hai, DB me sirf uska hash; cookie `httpOnly` + `SameSite=Strict` (+ `Secure` production me)
- Strict CSP (helmet), same-origin check, input validation, message rate limit, XSS-safe rendering
- Messages 30 din baad auto-delete (`MESSAGE_TTL_DAYS`)

## Dhyan rakho
DOB ke sirf ~30,000 combinations hote hain, isliye ye password jitna strong nahi hai. Lockout aur rate limit isi wajah se lagaye hain. Baad me asli login chahiye ho to password/OTP add kar dena.
`DOB_PEPPER` deploy ke baad badalna mat, warna sab users ka login band ho jayega.

## Structure
```
server.js          backend (auth, mongo, socket)
public/index.html  login page
public/chat.html   chat page
public/js, css     frontend files
```
