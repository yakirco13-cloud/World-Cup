# 5-חבר'ה auto-updater (Railway) — setup

This service logs into hevre.sport5.co.il on a schedule, pulls your group's
leaderboard + everyone's stats, and pushes `hevre.json` to your GitHub repo.
Your site reads that file, so the **5 חבר'ה** tab updates on its own.

```
Railway service (every 2h)
  reads refresh token from /data volume → refresh (gets + saves a NEW token)
  → getGroup + getAppUserStats for each member
  → pushes hevre.json to GitHub → your site shows it
```

## Step 1 — Get a DEDICATED login token for the bot
Use a **private/incognito window** so the bot's session doesn't clash with your
normal browsing (the token rotates on every use).

1. Open an **incognito window**, go to hevre.sport5.co.il and **log in**.
2. Open the console (Cmd+Option+J) and run:
   ```js
   (() => {
     let email=''; try{email=(JSON.parse(localStorage.getItem('loginData'))||{}).email||''}catch{}
     console.log('HEVRE_REFRESH_TOKEN =', localStorage.getItem('refreshToken'));
     console.log('HEVRE_EMAIL =', email);
   })();
   ```
3. Copy both values somewhere safe. **Then close the incognito window** (don't
   keep using it — the bot now owns that session).

## Step 2 — Create a GitHub token (so the bot can write hevre.json)
1. https://github.com/settings/tokens → **Fine-grained tokens** → **Generate new token**
2. Repository access: **Only select repositories → World-Cup**
3. Permissions → **Repository permissions → Contents → Read and write**
4. Generate and copy the token (this is `GH_TOKEN`).

## Step 3 — Put this folder on GitHub
Upload the `hevre-bot/` folder (these files) to your **World-Cup** repo
(Add file → Upload files → drag the folder).

## Step 4 — Deploy on Railway
1. https://railway.app → **New Project → Deploy from GitHub repo → World-Cup**
2. In the service **Settings**:
   - **Root Directory:** `hevre-bot`
   - **Add a Volume**, mount path: `/data`  (stores the rotating token)
3. **Variables** tab — add:
   | Name | Value |
   |------|-------|
   | `HEVRE_REFRESH_TOKEN` | (from step 1 — first run only; after that the volume takes over) |
   | `HEVRE_EMAIL` | (from step 1) |
   | `HEVRE_GROUP_ID` | `6a16d76ce85283f0260c97e2` (your 15-member group) |
   | `GH_TOKEN` | (from step 2) |
   | `GH_REPO` | `yakirco13-cloud/World-Cup` |
   | `UPDATE_INTERVAL_MIN` | `120` (optional) |
4. Deploy. Watch the **Deploy logs** — you want:
   `Pushed hevre.json to GitHub.` and `Updated 15 members…`

## Step 5 — Show the tab on your site
Re-deploy `index.html` to Netlify (drag it over, like before) so the new
**5 חבר'ה** tab appears. It reads `hevre.json` from GitHub automatically.

## Notes
- **Token rotation is handled:** after the first run the bot stores the rotated
  token on the `/data` volume, so it never reuses a dead one. Just don't reuse
  that incognito session.
- If the bot ever gets logged out (e.g. you logged into the same session
  elsewhere), redo **Step 1** and update `HEVRE_REFRESH_TOKEN`, then redeploy /
  clear the volume so it re-seeds.
- Privacy: this publishes group members' **names + picks** on your public site.
  Tell me if you want first-names-only or to hide the champion/scorer columns.
