# Auto-updating data — setup

The page pulls live data from **football-data.org** (free tier) on a schedule.
Each run makes ~4 API calls and refreshes:

- **Match results** → group tables (טבלאות) recalculate automatically
- **Live status** → "משחק חי" badges + a live banner at the top of the page
- **Recent form** → last-5 (W/D/L) column in the standings
- **Top scorers** → the מבקיעים section
- **Team crests/flags** → logos on cards, tables and the scorers list

(Squads, injuries and detailed match stats are *not* on this free tier — those
would need API-Football.)

Here's how it fits together:

```
football-data.org  ──►  scripts/update-results.mjs  ──►  data.json  ──►  index.html
                        (runs in GitHub Actions, hourly-ish)        (loads on page open)
```

Nothing in the page calls the API directly — that avoids CORS problems and keeps
your API key secret. A scheduled job does the fetch and commits `data.json`.

## One-time setup

1. **Get a free token** — sign up at https://www.football-data.org/client/register
   and copy your API token from the dashboard.

2. **Put the site on GitHub** (if it isn't already):
   ```bash
   git add -A && git commit -m "Add auto-updating results"
   gh repo create worldcup-2026 --public --source=. --push
   ```

3. **Add the token as a repo secret:**
   - GitHub → your repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `FOOTBALL_DATA_TOKEN`  Value: *(your token)*

4. **Run it once** to confirm — repo → Actions → "Update results" → Run workflow.
   It should commit an updated `data.json`.

The workflow then runs every 2 hours on its own (`.github/workflows/update-data.yml`).
Adjust the `cron:` line there if you want it more/less often.

## Test locally

`fetch('data.json')` won't work from `file://`, so serve over http:
```bash
python3 -m http.server 8000     # then open http://localhost:8000
```
To test the fetch script itself:
```bash
FOOTBALL_DATA_TOKEN=your_token node scripts/update-results.mjs
```

## Notes

- **Team-name mapping:** the script maps English API names to your Hebrew names
  automatically. If a team can't be matched it's logged as
  `Unmatched team names (add to ALIASES)` — add it to the `ALIASES` table near the
  top of `scripts/update-results.mjs`.
- **Free-tier limits:** football-data.org allows ~10 requests/min. The job makes
  ~4 requests per run (matches, standings, scorers, teams), so you're far under it.
- **Graceful by design:** if any single endpoint fails, the others still update.
  Logos/scorers simply don't show until the first successful run.
- **FIFA rankings** (דירוג נבחרות) are *not* updated by this — football-data.org
  doesn't expose them, and they change only a few times a year. Keep editing them
  by hand, or switch to API-Football later if you want them automated too.
- **Competition code:** defaults to `WC`. If football-data.org uses a different
  code for 2026, set `FOOTBALL_DATA_COMP` in the workflow's `env:`.
