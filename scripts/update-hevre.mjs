// Pulls the "5 חבר'ה" prediction-pool standings from hevre.sport5.co.il and
// writes hevre.json. The site reads that file and shows the 5 חבר'ה tab.
//
// No login required: both endpoints used here are PUBLIC.
//   getGroup        {membersGroup: groupId}  -> members + points + picks
//   getAppUserStats {auid: userId}           -> exact / direction / misses
//
// Node 18+ (global fetch). No npm dependencies. Commits via the GitHub Action.

import { writeFileSync, readFileSync } from 'node:fs';
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
// games they guessed. ratio1 = home win, ratio2 = AWAY win, ratio3 = DRAW.
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
      const ratio = n1 > n2 ? Number(g.ratio1) : n1 < n2 ? Number(g.ratio2) : Number(g.ratio3);
      if (!isFinite(ratio)) continue;
      sum += ratio; count++;
    }
  }
  return count ? { avg: Math.round(sum / count * 10) / 10, count } : null;
}

// Points a guess would earn if the final score were sh-sa (hevre scoring:
// ratio1=home, ratio2=away, ratio3=draw; × multiplier; + exact bonus).
function pointsIfScore(gh, ga, sh, sa, g) {
  const go = gh > ga ? 'H' : gh < ga ? 'A' : 'D';
  const so = sh > sa ? 'H' : sh < sa ? 'A' : 'D';
  if (go !== so) return 0;
  const mult = Number(g.fixturedata?.pointsMultplyer) || 1;
  const ratio = so === 'H' ? Number(g.ratio1) : so === 'A' ? Number(g.ratio2) : Number(g.ratio3);
  const exact = gh === sh && ga === sa;
  return (Number.isFinite(ratio) ? ratio * mult : 0) + (exact ? Number(g.fixturedata?.bonusExact || 0) : 0);
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

// Build an ordered timeline of finished games keyed by the UNIQUE game id (gid),
// NOT the kickoff timestamp — two matches that kick off at the same time (the
// simultaneous final-round group games) share a `beggining` and would otherwise
// collapse into one entry, hiding one score. Each entry carries teams + result +
// every friend's pick. The bar-chart race replays this as one frame per game.
function collectTimeline(timelineByGid, name, rounds) {
  for (const rd of (rounds || [])) {
    for (const g of (rd.games || [])) {
      if (g.result1 == null || g.result1 === '') continue; // finished only
      const gid = g.gid; if (!gid) continue;
      const e = (timelineByGid[gid] ||= {
        gid,
        ts: Number(g.beggining) || 0,
        home: g.team1?.name || '',
        away: g.team2?.name || '',
        result: `${g.result1}-${g.result2}`,
        picks: [],
      });
      const g1 = g.team1?.team1Guessed, g2 = g.team2?.team2Guessed;
      if (g1 == null || g1 === '' || g2 == null || g2 === '') continue; // no pick
      e.picks.push({ name, guess: `${g1}-${g2}`, points: Number(g.gamepoints) || 0 });
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

// ── 88th-minute stats (from wc2026_scores_88min.csv) ─────────────────────────
const normEng = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b(?:and|the|of)\b/g, '').replace(/[^a-z]/g, '');
const ENG_ALIAS = { usa: 'unitedstates' };
// hevre's Hebrew spellings that differ from the site's DATA spellings.
const HEVRE_TO_SITE = {
  "צ'כיה": 'צ׳כיה',
  'בוסניה הרצגובינה': 'בוסניה והרצגובינה',
  'פראגוואי': 'פרגוואי',
  'שוויץ': 'שווייץ',
  'קורסאו': 'קוראסאו',
  'שבדיה': 'שוודיה',
  'טוניסיה': 'תוניסיה',
  'קייפ ורדה': 'כף ורדה',
  'נורווגיה': 'נורבגיה',
  "אלג'יריה": 'אלג׳יריה',
  'קונגו הדמוקרטית': 'הרפובליקה הדמוקרטית של קונגו',
};

// Build a lookup of {88', 90'} scores keyed by the site's Hebrew "home|away".
function loadScores88() {
  let engToHe;
  try {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const DATA = JSON.parse(html.match(/const DATA = (\{[\s\S]*?\});\s*\nconst POSITIONS/)[1]);
    engToHe = {};
    for (const [he, sq] of Object.entries(DATA.squads)) if (sq.english) engToHe[normEng(sq.english)] = he;
  } catch (e) { console.warn('scores88: index.html DATA unreadable -', e.message); return {}; }
  const engHe = eng => { const k = normEng(eng); return engToHe[ENG_ALIAS[k] || k]; };
  let raw;
  try { raw = readFileSync(join(ROOT, 'wc2026_scores_88min.csv'), 'utf8'); }
  catch (e) { console.warn('scores88: CSV not found -', e.message); return {}; }
  const parse = s => { const [h, a] = String(s || '').split('-').map(Number); return (Number.isFinite(h) && Number.isFinite(a)) ? [h, a] : null; };
  const byPair = {};
  for (const line of raw.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    const home = engHe(c[2]), away = engHe(c[3]);
    const s88 = parse(c[4]), s90 = parse(c[5]);
    if (home && away && s88 && s90) byPair[`${home}|${away}`] = { s88, s90 };
  }
  return byPair;
}

// Per player, over games with 88' data:
//  - perfect88 : exact predictions vs the 88' score
//  - robbed88  : of those, how many a post-88' goal ruined (score changed by 90')
//  - pointsLost: total POINTS lost to post-88' goals — for each game, the points
//    the guess would have earned at the 88' score minus the points it actually
//    earned (hevre's gamepoints), summed where positive.
function computeMinuteStats(rounds, csvByPair) {
  let perfect88 = 0, robbed88 = 0, covered = 0, pointsLost = 0, pointsLostGames = 0;
  for (const rd of (rounds || [])) {
    for (const g of (rd.games || [])) {
      if (g.result1 == null || g.result1 === '') continue;
      const g1 = g.team1?.team1Guessed, g2 = g.team2?.team2Guessed;
      if (g1 == null || g1 === '' || g2 == null || g2 === '') continue;
      const home = HEVRE_TO_SITE[g.team1?.name] || g.team1?.name;
      const away = HEVRE_TO_SITE[g.team2?.name] || g.team2?.name;
      const cell = csvByPair[`${home}|${away}`];
      if (!cell) continue;
      covered++;
      const gh = Number(g1), ga = Number(g2);
      if (gh === cell.s88[0] && ga === cell.s88[1]) {
        perfect88++;
        if (cell.s88[0] !== cell.s90[0] || cell.s88[1] !== cell.s90[1]) robbed88++;
      }
      const p88 = pointsIfScore(gh, ga, cell.s88[0], cell.s88[1], g);
      const pFinal = Number(g.gamepoints) || 0;
      if (p88 - pFinal > 0) { pointsLost += p88 - pFinal; pointsLostGames++; }
    }
  }
  return { perfect88, robbed88, covered, pointsLost: Math.round(pointsLost * 10) / 10, pointsLostGames };
}

function buildTable(group, statsById, bestBetById, momentumById, riskById, goalGapById, minStatsById) {
  const rows = (group.members || []).map(m => {
    const s = statsById[m._id] || {};
    const gg = goalGapById[m._id];
    const ms = minStatsById[m._id];
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
      perfect88:  ms?.perfect88 ?? null,
      robbed88:   ms?.robbed88  ?? null,
      covered88:  ms?.covered   ?? null,
      pointsLost:      ms?.pointsLost      ?? null,
      pointsLostGames: ms?.pointsLostGames ?? null,
    };
  });
  rows.sort((a, b) => (b.points - a.points) || String(a.name).localeCompare(String(b.name), 'he'));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

const group = await api('getGroup', { membersGroup: GROUP_ID });
const members = group.members || [];
console.log(`Fetched group "${group.name || '(no name)'}" with ${members.length} members.`);

const csvByPair = loadScores88();
console.log(`Loaded 88' scores for ${Object.keys(csvByPair).length} games.`);

const statsById = {}, bestBetById = {}, momentumById = {}, riskById = {}, goalGapById = {}, minStatsById = {};
const gamesByTs = {}, matchesByTs = {}, guessedByTs = {}, timelineByGid = {};
for (const m of members) {
  try { statsById[m._id] = await api('getAppUserStats', { auid: m._id }); }
  catch (e) { console.warn('stats failed for', m.name, '-', e.message); }
  try {
    const guesses = await api('getFriendGuesses', { user: m._id, auid: m._id });
    bestBetById[m._id] = computeBestBet(guesses);
    momentumById[m._id] = computeMomentum(guesses);
    riskById[m._id] = computeRisk(guesses);
    goalGapById[m._id] = computeGoalGap(guesses);
    minStatsById[m._id] = computeMinuteStats(guesses, csvByPair);
    collectPicks(gamesByTs, matchesByTs, m.name, guesses);
    collectTimeline(timelineByGid, m.name, guesses);
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
  table: buildTable(group, statsById, bestBetById, momentumById, riskById, goalGapById, minStatsById),
  games: gamesByTs,
  matches: matchesByTs,
  // ordered, one entry per real game (unique gid) — powers the bar-chart race
  timeline: Object.values(timelineByGid).sort((a, b) => (a.ts - b.ts) || a.gid.localeCompare(b.gid)),
  missingBets,
};
writeFileSync(join(ROOT, 'hevre.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote hevre.json with ${out.table.length} rows.`);
