// Pulls the "5 חבר'ה" prediction-pool standings from hevre.sport5.co.il and
// writes hevre.json. The site reads that file and shows the 5 חבר'ה tab.
//
// No login required: both endpoints used here are PUBLIC.
//   getGroup        {membersGroup: groupId}  -> members + points + picks
//   getAppUserStats {auid: userId}           -> exact / direction / misses
//
// Node 18+ (global fetch). No npm dependencies. Commits via the GitHub Action.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://hevre.sport5.co.il/server/data.php?type=';
const GROUP_ID = process.env.HEVRE_GROUP_ID || '6a16d76ce85283f0260c97e2'; // 15-member group

async function api(type, body) {
  const r = await fetch(API + type, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  if (/DOCTYPE html/i.test(text)) throw new Error(`${type}: got HTML (endpoint error)`);
  let json; try { json = JSON.parse(text); } catch { throw new Error(`${type}: non-JSON response`); }
  if (json && json.error) throw new Error(`${type}: ${json.error}`);
  return json;
}

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

const group = await api('getGroup', { membersGroup: GROUP_ID });
const members = group.members || [];
console.log(`Fetched group "${group.name || '(no name)'}" with ${members.length} members.`);

const statsById = {};
for (const m of members) {
  try { statsById[m._id] = await api('getAppUserStats', { auid: m._id }); }
  catch (e) { console.warn('stats failed for', m.name, '-', e.message); }
}
console.log(`Fetched stats for ${Object.keys(statsById).length}/${members.length} members.`);

const out = {
  updated: new Date().toISOString(),
  groupName: group.name || '',
  membersCount: group.membersCount ?? members.length,
  table: buildTable(group, statsById),
};
writeFileSync(join(ROOT, 'hevre.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote hevre.json with ${out.table.length} rows.`);
