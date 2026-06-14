// Pulls World Cup match results from football-data.org and writes data.json.
// The page (index.html) loads data.json and uses it to fill in scores, which
// makes the group tables (טבלאות) recalculate automatically.
//
// Run:  FOOTBALL_DATA_TOKEN=xxxxx node scripts/update-results.mjs
// Requires Node 18+ (uses global fetch). No npm dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMP = process.env.FOOTBALL_DATA_COMP || 'WC'; // World Cup competition code

if (!TOKEN) {
  console.error('Missing FOOTBALL_DATA_TOKEN environment variable.');
  process.exit(1);
}

// --- Normalisation so "Côte d'Ivoire" === "Ivory Coast" etc. -----------------
const norm = s =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z]/g, '');

// football-data.org name (normalised) -> the English name the site uses.
// Extend this if the log reports an unmatched team.
const ALIASES = {
  korearepublic: 'South Korea',
  iriran: 'Iran',
  turkiye: 'Turkey',
  cotedivoire: 'Ivory Coast',
  caboverde: 'Cape Verde',
  congodr: 'DR Congo',
  drcongo: 'DR Congo',
  usa: 'United States',
  unitedstatesofamerica: 'United States',
  czechia: 'Czech Republic',
};

// --- Read the site's fixture list straight out of index.html -----------------
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const m = html.match(/const DATA = (\{[\s\S]*?\});\s*\nconst POSITIONS/);
if (!m) {
  console.error('Could not locate the DATA object in index.html.');
  process.exit(1);
}
const DATA = JSON.parse(m[1]);

// Build: normalised English name -> Hebrew name used in matches.
const engToHe = {};
for (const [he, sq] of Object.entries(DATA.squads)) {
  if (sq.english) engToHe[norm(sq.english)] = he;
}
const apiNameToHe = name => {
  const n = norm(name);
  if (engToHe[n]) return engToHe[n];
  const alias = ALIASES[n];
  if (alias && engToHe[norm(alias)]) return engToHe[norm(alias)];
  return null;
};

// Index site matches by "homeHe|awayHe" (group stage pairs are unique).
const siteByPair = {};
for (const match of DATA.matches) {
  siteByPair[`${match.home}|${match.away}`] = match;
}

// API "GROUP_A".."GROUP_L" -> the site's Hebrew group key, by position.
const siteGroupKeys = Object.keys(DATA.groups); // ['א','ב',...]
const letterToHeGroup = {};
'ABCDEFGHIJKL'.split('').forEach((letter, i) => {
  if (siteGroupKeys[i]) letterToHeGroup[letter] = siteGroupKeys[i];
});
const apiGroupToHe = g => letterToHeGroup[String(g || '').replace(/[^A-L]/gi, '').toUpperCase()] || null;

// --- Generic fetch helper (tolerates per-endpoint failure) -------------------
async function api(path) {
  const r = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': TOKEN },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

const unmatchedTeams = new Set();
const out = { updated: new Date().toISOString(), source: 'football-data.org' };

// --- 1. Matches: scores + live status ----------------------------------------
{
  const payload = await api(`/competitions/${COMP}/matches`);
  const apiMatches = payload.matches || [];
  console.log(`Fetched ${apiMatches.length} matches.`);

  const scores = {};
  const status = {};
  let matched = 0;

  for (const am of apiMatches) {
    const homeHe = apiNameToHe(am.homeTeam?.name);
    const awayHe = apiNameToHe(am.awayTeam?.name);
    if (!homeHe) unmatchedTeams.add(am.homeTeam?.name);
    if (!awayHe) unmatchedTeams.add(am.awayTeam?.name);
    if (!homeHe || !awayHe) continue;

    const site = siteByPair[`${homeHe}|${awayHe}`] || siteByPair[`${awayHe}|${homeHe}`];
    if (!site) continue;
    const flip = site.home !== homeHe;

    if (am.status) status[site.id] = am.status; // SCHEDULED|TIMED|IN_PLAY|PAUSED|FINISHED

    const ft = am.score?.fullTime;
    if (ft && ft.home != null && ft.away != null) {
      scores[site.id] = {
        h: String(flip ? ft.away : ft.home),
        a: String(flip ? ft.home : ft.away),
      };
      matched++;
    }
  }
  out.scores = scores;
  out.status = status;
  console.log(`Mapped ${matched} results, ${Object.keys(status).length} statuses.`);
}

// --- 2. Standings: recent form per team --------------------------------------
try {
  const payload = await api(`/competitions/${COMP}/standings`);
  const forms = {};
  for (const block of payload.standings || []) {
    for (const row of block.table || []) {
      const he = apiNameToHe(row.team?.name);
      if (he && row.form) forms[he] = row.form; // e.g. "W,D,L"
    }
  }
  out.forms = forms;
  console.log(`Mapped form for ${Object.keys(forms).length} teams.`);
} catch (e) {
  console.warn('Standings skipped:', e.message);
}

// --- 3. Top scorers ----------------------------------------------------------
try {
  const payload = await api(`/competitions/${COMP}/scorers?limit=30`);
  out.scorers = (payload.scorers || []).map(s => ({
    name: s.player?.name || '',
    teamHe: apiNameToHe(s.team?.name) || s.team?.name || '',
    goals: s.goals ?? 0,
    assists: s.assists ?? 0,
    penalties: s.penalties ?? 0,
  }));
  console.log(`Fetched ${out.scorers.length} scorers.`);
} catch (e) {
  console.warn('Scorers skipped:', e.message);
}

// --- 4. Team crests (logos / flags) ------------------------------------------
try {
  const payload = await api(`/competitions/${COMP}/teams`);
  const crests = {};
  for (const t of payload.teams || []) {
    const he = apiNameToHe(t.name);
    if (he && t.crest) crests[he] = t.crest;
  }
  out.crests = crests;
  console.log(`Fetched ${Object.keys(crests).length} crests.`);
} catch (e) {
  console.warn('Teams/crests skipped:', e.message);
}

if (unmatchedTeams.size) {
  console.warn('Unmatched team names (add to ALIASES):', [...unmatchedTeams].filter(Boolean).join(', '));
}

// --- Write data.json ---------------------------------------------------------
writeFileSync(join(ROOT, 'data.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote data.json (${Object.keys(out.scores).length} scores, ${(out.scorers||[]).length} scorers, ${Object.keys(out.crests||{}).length} crests).`);
