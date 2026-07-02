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

// Best single bet = the game where the player earned the most points.
function computeBestBet(rounds) {
  let best = null;
  for (const round of (rounds || [])) {
    for (const gme of (round.games || [])) {
      const g1 = gme.team1?.team1Guessed, g2 = gme.team2?.team2Guessed;
      if (g1 == null || g1 === '' || g2 == null || g2 === '') continue; // no guess made
      const pts = Number(gme.gamepoints) || 0;
      if (!best || pts > best.points) {
        best = {
          points: pts,
          home: gme.team1?.name || '',
          away: gme.team2?.name || '',
          guess: `${g1}-${g2}`,
          result: (gme.result1 != null && gme.result1 !== '') ? `${gme.result1}-${gme.result2}` : null,
        };
      }
    }
  }
  return best;
}

// Momentum = current hot streak: consecutive most-recent PLAYED games where the
// player earned points (no history snapshots needed; games carry timestamps).
function computeMomentum(rounds) {
  const games = [];
  for (const round of (rounds || [])) {
    for (const gme of (round.games || [])) {
      const played = gme.result1 != null && gme.result1 !== '';
      if (!played) continue;
      games.push({ when: Number(gme.beggining) || 0, pts: Number(gme.gamepoints) || 0 });
    }
  }
  games.sort((a, b) => a.when - b.when);
  let streak = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    if (games[i].pts > 0) streak++;
    else break;
  }
  return streak;
}

// Risk = average point-value of the outcome each player backed, over FINISHED
// games they guessed. ratio1 = home win, ratio2 = draw, ratio3 = away win.
// Favorites pay few points (low risk); underdogs/draws pay a lot (high risk).
function computeRisk(rounds) {
  let sum = 0, count = 0;
  for (const round of (rounds || [])) {
    for (const g of (round.games || [])) {
      const played = g.result1 != null && g.result1 !== '';
      if (!played) continue;
      const g1 = g.team1?.team1Guessed, g2 = g.team2?.team2Guessed;
      if (g1 == null || g1 === '' || g2 == null || g2 === '') continue; // no pick
      const n1 = Number(g1), n2 = Number(g2);
      const ratio = n1 > n2 ? Number(g.ratio1) : n1 === n2 ? Number(g.ratio2) : Number(g.ratio3);
      if (!isFinite(ratio)) continue;
      sum += ratio; count++;
    }
  }
  return count ? { avg: Math.round(sum / count * 10) / 10, count } : null;
}

// Goal-gap: total goals a player's scoreline predictions were off, over finished
// games. e.g. guessed 2-0, actual 2-1 -> +1; guessed 1-0, actual 5-0 -> +4.
// Computed per game from the player's own guess+result (immune to simultaneous
// games that share a kickoff timestamp).
function computeGoalGap(rounds) {
  let sum = 0, count = 0;
  for (const round of (rounds || [])) {
    for (const g of (round.games || [])) {
      if (g.result1 == null || g.result1 === '') continue; // finished only
      const g1 = g.team1?.team1Guessed, g2 = g.team2?.team2Guessed;
      if (g1 == null || g1 === '' || g2 == null || g2 === '') continue; // no pick
      const gh = Number(g1), ga = Number(g2), rh = Number(g.result1), ra = Number(g.result2);
      if (![gh, ga, rh, ra].every(Number.isFinite)) continue;
      sum += Math.abs(gh - rh) + Math.abs(ga - ra);
      count++;
    }
  }
  return count ? { sum, count } : null;
}

// Collect every friend's pick + points per FINISHED game, keyed by kickoff
// timestamp (ms) — which matches the site's match datetime exactly. Also record
// the match teams + result once per game (in matchesByTs) so consumers like the
// bar-chart race can label each frame with the fixture that just played.
function collectPicks(gamesByTs, matchesByTs, name, rounds) {
  for (const rd of (rounds || [])) {
    for (const g of (rd.games || [])) {
      if (g.result1 == null || g.result1 === '') continue; // finished only
      const g1 = g.team1?.team1Guessed, g2 = g.team2?.team2Guessed;
      const ts = Number(g.beggining) || 0;
      if (!ts) continue;
      if (!matchesByTs[ts]) {
        matchesByTs[ts] = {
          home: g.team1?.name || '',
          away: g.team2?.name || '',
          result: `${g.result1}-${g.result2}`,
        };
      }
      if (g1 == null || g1 === '' || g2 == null || g2 === '') continue; // no pick
      (gamesByTs[ts] ||= []).push({ name, guess: `${g1}-${g2}`, points: Number(g.gamepoints) || 0 });
    }
  }
}

// Track who HAS submitted a bet per UPCOMING game (for the "you forgot" warning).
function collectUpcoming(guessedByTs, name, rounds) {
  for (const rd of (rounds || [])) {
    for (const g of (rd.games || [])) {
      if (g.result1 != null && g.result1 !== '') continue; // upcoming only
      const ts = Number(g.beggining) || 0;
      if (!ts) continue;
      (guessedByTs[ts] ||= new Set());
      const g1 = g.team1?.team1Guessed, g2 = g.team2?.team2Guessed;
      if (g1 != null && g1 !== '' && g2 != null && g2 !== '') guessedByTs[ts].add(name);
    }
  }
}

function buildTable(group, statsById, bestBetById, momentumById, riskById, goalGapById) {
  const rows = (group.members || []).map(m => {
    const s = statsById[m._id] || {};
    const gg = goalGapById[m._id];
    return {
      name: m.name,
      points: m.points ?? 0,
      exact:     s.numberOfExactGuessed   ?? null,
      direction: s.numberOfInExactGuessed ?? null,
      misses:    s.numberOfMissedGuessed  ?? null,
      guessed:   s.numberOfGamesGuessed   ?? null,
      champion: m.champion?.name || '',
      scorer:   m.scorer?.name   || '',
      pointsFromChampion: s.pointsFromChampion ?? null,
      pointsFromScorer:   s.pointsFromScrorer  ?? null,
      bestBet: bestBetById[m._id] || null,
      momentum: momentumById[m._id] ?? null,
      riskAvg: riskById[m._id]?.avg ?? null,
      riskCount: riskById[m._id]?.count ?? null,
      goalGap:      gg?.sum   ?? null,
      goalGapGames: gg?.count ?? null,
    };
  });
  rows.sort((a, b) => (b.points - a.points) || String(a.name).localeCompare(String(b.name), 'he'));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

const group = await api('getGroup', { membersGroup: GROUP_ID });
const members = group.members || [];
console.log(`Fetched group "${group.name || '(no name)'}" with ${members.length} members.`);

const statsById = {}, bestBetById = {}, momentumById = {}, riskById = {}, goalGapById = {};
const gamesByTs = {}, matchesByTs = {}, guessedByTs = {};
for (const m of members) {
  try { statsById[m._id] = await api('getAppUserStats', { auid: m._id }); }
  catch (e) { console.warn('stats failed for', m.name, '-', e.message); }
  try {
    const guesses = await api('getFriendGuesses', { user: m._id, auid: m._id });
    bestBetById[m._id] = computeBestBet(guesses);
    momentumById[m._id] = computeMomentum(guesses);
    riskById[m._id] = computeRisk(guesses);
    goalGapById[m._id] = computeGoalGap(guesses);
    collectPicks(gamesByTs, matchesByTs, m.name, guesses);
    collectUpcoming(guessedByTs, m.name, guesses);
  } catch (e) { console.warn('guesses failed for', m.name, '-', e.message); }
}
console.log(`Fetched stats for ${Object.keys(statsById).length}/${members.length} members.`);
console.log(`Collected picks for ${Object.keys(gamesByTs).length} finished games.`);

// Who hasn't bet yet, per upcoming game.
const allNames = members.map(m => m.name);
const missingBets = {};
for (const ts of Object.keys(guessedByTs)) {
  const missing = allNames.filter(n => !guessedByTs[ts].has(n));
  if (missing.length) missingBets[ts] = missing;
}
console.log(`${Object.keys(missingBets).length} upcoming games have missing bets.`);

const out = {
  updated: new Date().toISOString(),
  groupName: group.name || '',
  membersCount: group.membersCount ?? members.length,
  table: buildTable(group, statsById, bestBetById, momentumById, riskById, goalGapById),
  games: gamesByTs,
  matches: matchesByTs,
  missingBets,
};
writeFileSync(join(ROOT, 'hevre.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote hevre.json with ${out.table.length} rows.`);
