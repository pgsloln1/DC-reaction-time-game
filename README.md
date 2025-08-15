# Discord Reaction-Time Game Bot

This bot lets people in a Discord channel play a small reaction-time clicking game in their browser and automatically updates a **leaderboard** for that channel when a run finishes (50 clicks).

## What you get
- `/play` — bot gives you a personal game link (valid ~15 minutes).
- `/leaderboard` — posts or refreshes the channel leaderboard.
- Static web game (HTML/JS) hosted by the bot's small Express server.
- SQLite storage (file: `data.db`). Sorts by **lowest average reaction time**.

## Quick start (local, with ngrok)
1. **Install Node 18+**.
2. `npm install`
3. Copy `.env.example` to `.env` and set:
   - `DISCORD_TOKEN` — bot token
   - `DISCORD_CLIENT_ID` — application client id
   - `PUBLIC_URL` — public base URL to your server (e.g., your ngrok URL)
   - `PORT` — default `3000`
4. Run a tunnel (choose one):
   - **ngrok**: `ngrok http 3000` → copy the `https://...ngrok...` URL to `PUBLIC_URL`
   - **Cloudflared**: `cloudflared tunnel --url http://localhost:3000`
   - Or deploy to **Railway/Render/Replit/Glitch** and use their public URL.
5. `npm start`

## Slash commands setup
- In Discord Developer Portal, create a bot; enable **MESSAGE CONTENT INTENT** optional (not required here).
- Invite the bot with `applications.commands` scope.
- First launch will auto-register the two slash commands in all guilds where the bot is present.

## How it works
- `/play` generates a one-time token, stores `(token → channelId, userId, username)` for 15 minutes, and replies with a private game link like:  
  `${PUBLIC_URL}/?t=<token>`
- The in-browser game plays 50 clicks and then POSTs results to `/score` with that token.
- The server validates the token, writes the score to SQLite, and updates a pinned leaderboard message for that channel if present, or posts a new one.

## Notes
- Score = always 50 when finished; ranking is by **average reaction time (ms)** ascending.
- If a user submits multiple runs, best (lowest) average is kept, and `bestTime` is also tracked.
- Data file `data.db` is created alongside `index.js`.
- If you don't want a pinned leaderboard, remove the `pin: true` flag in code and the pin logic.

## Commands
- `/play` — get your link
- `/leaderboard` — post/refresh the leaderboard message manually

