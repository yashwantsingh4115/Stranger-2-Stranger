# 🤖 Chatroom Discord Bot

Website ko monitor karta hai aur Discord se manage karne deta hai.

## Features
- 🚩 Naya report aate hi Discord channel me embed + **Ban / Dismiss** buttons
- 🚨 Website down hone par alert (3 min lagatar fail), wapas aane par message
- Bot ka status: "N online · N reports"
- Commands: `/status` `/online` `/reports` `/user` `/ban` `/unban` `/kick` `/announce`
- Sirf wahi use kar sakte hain jinke paas `ADMIN_ROLE_ID` wala role ho ya jinki ID `ADMIN_DISCORD_IDS` me ho

## Setup
Pura guide root README ya chat me diya gaya hai. Short me:
1. Discord Developer Portal me bot banao, token + client id lo
2. Website (Render) me `BOT_API_KEY` set karo (24+ random chars)
3. `.env.example` ko `.env` banao aur sab bharo (BOT_API_KEY wahi jo website me)
4. `npm install` then `npm start`
