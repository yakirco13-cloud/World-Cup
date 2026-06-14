// hevre-bot — pulls the "5 חבר'ה" prediction-pool standings from
// hevre.sport5.co.il and pushes hevre.json to GitHub on a schedule.
//
// Why a service (not a GitHub Action): Sport5 ROTATES + INVALIDATES the refresh
// token on every refresh, so the updater must persist the new token each run.
// This process keeps that token on a Railway volume (/data) so it survives
// restarts and never reuses a dead token.
//
// Node 18+ (global fetch). No npm dependencies.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API = 'https://hevre.sport5.co.il/server/data.php?type=';

const EMAIL          = process.env.HEVRE_EMAIL;
const GROUP_ID       = process.env.HEVRE_GROUP_ID;            // optional; else first group
const INTERVAL_MIN   = Number(process.env.UPDATE_INTERVAL_MIN || 120);
const STATE_DIR      = process.env.STATE_DIR || '/data';      // Railway volume mount
const STATE_FILE     = `${STATE_DIR}/hevre-state.json`;

const GH_TOKEN  = process.env.GH_TOKEN;                       // fine-grained PAT, Contents: write
const GH_REPO   = process.env.GH_REPO || 'yakirco13-cloud/World-Cup';
const GH_FILE   = process.env.GH_FILE || 'hevre.json';
const GH_BRANCH = process.env.GH_BRANCH || 'main';

// ── rotating refresh-token persistence ──────────────────────────────────────
function loadRefreshToken() {
  try {
    if (existsSync(STATE_FILE)) {
      const t = JSON.parse(readFileSync(STATE_FILE, 'utf8')).refreshToken;
      if (t) return t;
    }
  } catch (e) { console.warn('state read failed:', e.message); }
  return process.env.HEVRE_REFRESH_TOKEN; // initial seed (first run only)
}
function saveRefreshToken(token) {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  writeFileSync(STATE_FILE, JSON.stringify({ refreshToken: token, savedAt: new Date().toISOString() }, null, 2));
}

// ── hevre API ───────────────────────────────────────────────────────────────
async function api(type, body, token) {
  const r = await fetch(API + type, {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${type} -> ${r.status}: ${String(text).slice(0, 200)}`);
  return json;
}

async function refresh() {
  const rt = loadRefreshToken();
  if (!rt) throw new Error('No refresh token — set HEVRE_REFRESH_TOKEN once to seed it.');
  const res = await api('requestNewActive', { refreshToken: rt, email: EMAIL });
  if (!res || !res.token) throw new Error('Refresh returned no token: ' + JSON.stringify(res).slice(0, 200));
  if (res.refreshToken) saveRefreshToken(res.refreshToken); // persist the ROTATED token
  return res.token;
}

// ── build the leaderboard table ─────────────────────────────────────────────
function buildTable(group, statsById) {
  const rows = (group.members || []).map(m => {
    const s = statsById[m._id] || {};
    return {
      name: m.name,
      points: m.points ?? 0,
      exact:     s.numberOfExactGuessed   ?? null,
      direction: s.numberOfInExactGuessed ?? null,
      misses:    s.numberOfMissedGuessed  ?? null,
      guessed:   s.numberOfGamesGuessed   ?? null,
      champion: m.champion?.name || '',
      scorer:   m.scorer?.name   || '',
    };
  });
  rows.sort((a, b) => (b.points - a.points) || String(a.name).localeCompare(String(b.name), 'he'));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// ── publish to GitHub (site reads hevre.json from raw GitHub) ────────────────
async function pushToGitHub(json) {
  if (!GH_TOKEN) { console.log('GH_TOKEN not set — skipping GitHub push.'); return; }
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hevre-bot',
  };
  let sha;
  const get = await fetch(`${url}?ref=${GH_BRANCH}`, { headers });
  if (get.ok) sha = (await get.json()).sha; // file exists → need its sha to update

  const content = Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8').toString('base64');
  const put = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message: 'chore: update hevre standings', content, sha, branch: GH_BRANCH }),
  });
  if (!put.ok) throw new Error('GitHub push failed: ' + put.status + ' ' + (await put.text()).slice(0, 200));
  console.log('Pushed', GH_FILE, 'to GitHub.');
}

// ── one update cycle ─────────────────────────────────────────────────────────
async function runOnce() {
  const token = await refresh();

  let groupId = GROUP_ID;
  if (!groupId) {
    const groups = await api('getMyGroups', {}, token);
    groupId = Array.isArray(groups) && groups[0] && groups[0]._id;
    if (!groupId) throw new Error('No group found and HEVRE_GROUP_ID not set.');
  }

  const group = await api('getGroup', { membersGroup: groupId }, token);
  const members = group.members || [];

  const statsById = {};
  for (const m of members) {
    try { statsById[m._id] = await api('getAppUserStats', { userId: m._id }, token); }
    catch (e) { console.warn('stats failed for', m.name, '-', e.message); }
  }

  const out = {
    updated: new Date().toISOString(),
    groupName: group.name || '',
    membersCount: group.membersCount ?? members.length,
    table: buildTable(group, statsById),
  };
  await pushToGitHub(out);
  console.log(`Updated ${out.table.length} members at ${out.updated}`);
}

// ── always-on loop ────────────────────────────────────────────────────────────
async function loop() {
  try { await runOnce(); }
  catch (e) { console.error('Run failed:', e.message); }
  setTimeout(loop, INTERVAL_MIN * 60 * 1000);
}

export { runOnce, buildTable, refresh, saveRefreshToken, loadRefreshToken };

if (process.env.HEVRE_BOT_TEST !== '1') {
  console.log(`hevre-bot starting — updating every ${INTERVAL_MIN} min, group ${GROUP_ID || '(first)'}.`);
  loop();
}
