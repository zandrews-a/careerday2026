/**
 * HERZOG DISPATCH — scores backend
 * Paste this into Extensions > Apps Script on your Google Sheet.
 *
 * Sheet tabs (run setup() once from the editor to create/format them):
 *   Scores   A:Timestamp  B:Name  C:School  D:Score  E:Delivered  F:Hidden  G:Id
 *   Schools  A:School  B:Approved
 *
 * Script properties (Project Settings > Script properties):
 *   ADMIN_CODE   6 digits. Unlocks End event / Reopen on the TV board.
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Copy the /exec URL into API_URL in both HTML files.
 *
 * API
 *   GET  ?action=config   approved schools + open/closed
 *   GET  ?action=status   open/closed only (cheap, cached)
 *   GET  ?action=board    leaderboard + open/closed (cached ~10s)
 *   POST {action:'start'}   checks name/school before a run
 *   POST {action:'submit'}  records a score (idempotent on id)
 *   POST {action:'admin'}   close / reopen the event (needs ADMIN_CODE)
 *
 * Errors carry retry:true when the client should back off and try again
 * (busy, server error). Anything else is final.
 */

// Must match EVENT_ID in index.html. Change it for the next event so stale
// phones from this one can't post into that one's board.
var EVENT_ID    = 'dispatch-2026';

var SCORES_TAB  = 'Scores';
var SCHOOLS_TAB = 'Schools';
var MAX_NAME    = 14;
var MAX_SCHOOL  = 60;

var GRACE_MS          = 2 * 60 * 1000; // scores still accepted this long after End event
var LOCK_WAIT_MS      = 5000;          // past this, answer "busy" instead of piling up
var BOARD_TTL_S       = 10;
var RANKS_TTL_S       = 60;            // Hidden ticks drop out of ranks within this
var SCHOOLS_TTL_S     = 30;            // Approved ticks show in the dropdown within this
var SUBMIT_TTL_S      = 21600;         // how long a submission id is remembered (cache max)
var ADMIN_MAX_FAILS   = 10;
var ADMIN_LOCKOUT_S   = 15 * 60;

/* ============================================================
   Moderation lists. Edit freely; see SETUP.md.
   ============================================================ */

// Blocked anywhere inside a word. Only terms that don't turn up inside
// real names belong here.
var BLOCK_ANYWHERE = [
  'fuck','shit','cunt','nigger','nigga','faggot','whore','bitch','pussy','asshole',
  'cocksucker','dildo','vagina','penis','blowjob','handjob','jizz','orgasm',
  'masturbat','molest','hitler','wetback','twat','porno','pornhub','testicle'
];

// Blocked only as a whole word (plurals too). These show up inside real
// names — Draper, Hancock, Dickinson, Essex, Nazir, Spicer, Janus...
var BLOCK_WORD = [
  'ass','arse','dick','cock','cum','tit','tits','titty','titties','boob','boobs',
  'anal','anus','rape','raped','rapist','sex','sexy','porn','horny','boner','clit',
  'nazi','spic','chink','gook','coon','jap','wop','kike','fag','homo','tranny',
  'retard','pedo','piss','thot','milf','kys'
];

// Blocked as a standalone number.
var BLOCK_NUMBER = ['69','420','6969','42069','69420','80085','58008','8008'];

// Real names that would otherwise trip the lists above.
var ALLOW = [
  'scunthorpe','penistone','slutsky','coon rapids',
  'matsushita','yamashita','kinoshita','morishita','takeshita','kishita','hashita','oshita'
];

/* ============================================================
   Routing
   ============================================================ */

function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  try {
    var st = getStatus();
    if (p.action === 'config') return json({ ok: true, event: EVENT_ID, open: st.open, schools: approvedSchools() });
    if (p.action === 'status') return json({ ok: true, event: EVENT_ID, open: st.open });
    if (p.action === 'board')  return json({ ok: true, event: EVENT_ID, open: st.open, board: getBoard() });
    return json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json({ ok: false, error: 'server', retry: true, detail: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'start')  return json(startCheck(body));
    if (body.action === 'submit') return json(submitScore(body));
    if (body.action === 'admin')  return json(admin(body));
    return json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json({ ok: false, error: 'server', retry: true, detail: String(err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function cache() { return CacheService.getScriptCache(); }
function key(k) { return EVENT_ID + ':' + k; }

/* ============================================================
   Sheets
   ============================================================ */

function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    formatSheet(sh, name);
  }
  return sh;
}

function formatSheet(sh, name) {
  var checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  if (name === SCORES_TAB) {
    sh.getRange(1, 1, 1, 7).setValues([['Timestamp', 'Name', 'School', 'Score', 'Delivered', 'Hidden', 'Id']]);
    sh.getRange('F2:F').setDataValidation(checkbox);
  }
  if (name === SCHOOLS_TAB) {
    sh.getRange(1, 1, 1, 2).setValues([['School', 'Approved']]);
    sh.getRange('B2:B').setDataValidation(checkbox);
  }
  sh.setFrozenRows(1);
}

/** Run once from the editor: creates both tabs, or fixes headers/checkboxes on existing ones. */
function setup() {
  formatSheet(sheet(SCORES_TAB), SCORES_TAB);
  formatSheet(sheet(SCHOOLS_TAB), SCHOOLS_TAB);
}

function readScores() {
  var sh = sheet(SCORES_TAB);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 7).getValues()
    .filter(function (r) { return r[1] && r[5] !== true; })
    .map(function (r) {
      return {
        name: String(r[1]),
        school: String(r[2] || 'Unlisted'),
        score: parseInt(r[3], 10) || 0,
        delivered: parseInt(r[4], 10) || 0
      };
    });
}

/** All schools, approved or not, straight from the sheet. */
function readSchools() {
  var sh = sheet(SCHOOLS_TAB);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getValues()
    .map(function (r) { return { name: String(r[0]).trim(), approved: r[1] === true }; })
    .filter(function (s) { return s.name.length > 0; });
}

function cachedSchools() {
  var c = cache().get(key('schools'));
  if (c) return JSON.parse(c);
  var all = readSchools();
  cache().put(key('schools'), JSON.stringify(all), SCHOOLS_TTL_S);
  return all;
}

function approvedSchools() {
  return cachedSchools()
    .filter(function (s) { return s.approved; })
    .map(function (s) { return s.name; });
}

/* ============================================================
   Event status
   ============================================================ */

// Status is read on nearly every request, so it lives in the cache.
// Script properties have a daily read quota; the cache doesn't.
function getStatus() {
  var c = cache().get(key('status'));
  if (c) return JSON.parse(c);
  var props = PropertiesService.getScriptProperties();
  var st = {
    open: props.getProperty(key('STATUS')) !== 'closed',
    closedAt: Number(props.getProperty(key('CLOSED_AT'))) || 0
  };
  cache().put(key('status'), JSON.stringify(st), 21600);
  return st;
}

function setStatus(open) {
  var props = PropertiesService.getScriptProperties();
  var st = { open: open, closedAt: open ? 0 : Date.now() };
  props.setProperty(key('STATUS'), open ? 'open' : 'closed');
  props.setProperty(key('CLOSED_AT'), String(st.closedAt));
  cache().put(key('status'), JSON.stringify(st), 21600);
  cache().remove(key('board'));
  return st;
}

function acceptingScores(st) {
  return st.open || (Date.now() - st.closedAt) <= GRACE_MS;
}

/* ============================================================
   Input cleaning + moderation
   ============================================================ */

function cleanName(raw) {
  var n = String(raw || '').replace(/[^A-Za-z0-9 .'\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return n.length >= 2 ? n : null;
}

function cleanSchool(raw) {
  var s = String(raw || '').replace(/[^A-Za-z0-9 .'&,()\/\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_SCHOOL).trim();
  return s.length >= 2 ? s : null;
}

// Each letter may repeat ("fuuuck"), but a doubled letter in the term must
// stay doubled — n+i+g+g+e+r+ doesn't match "Nigeria".
function letterPattern(term) {
  return term.split('').map(function (ch) { return ch + '+'; }).join('');
}
var ANYWHERE_RE = BLOCK_ANYWHERE.map(function (t) { return new RegExp(letterPattern(t)); });
var WORD_RE = BLOCK_WORD.map(function (t) { return new RegExp('^' + letterPattern(t) + '(e?s+|z+)?$'); });

var LEET_I = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't' };
function deLeet(s, one) {
  return s.replace(/[0134578@$!|+]/g, function (c) { return c === '1' ? one : LEET_I[c]; });
}

// "d i c k" -> "dick"
function joinSingles(words) {
  var out = [], run = '';
  words.forEach(function (w) {
    if (w.length === 1) { run += w; return; }
    if (run) { out.push(run); run = ''; }
    out.push(w);
  });
  if (run) out.push(run);
  return out;
}

function isBlocked(text) {
  var raw = String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); // BigDick -> big dick

  var nums = raw.split(/[^0-9]+/);
  for (var n = 0; n < nums.length; n++) if (BLOCK_NUMBER.indexOf(nums[n]) !== -1) return true;

  var leet = deLeet(raw, 'i');
  var variants = [leet, deLeet(raw, 'l'), leet.replace(/v/g, 'u')]; // "fvck"
  for (var v = 0; v < variants.length; v++) {
    var s = variants[v];
    ALLOW.forEach(function (a) { s = s.split(a).join(' '); });

    // Whole space-separated words with punctuation squeezed out: "f.u.c.k" -> "fuck".
    var spaced = joinSingles(s.split(/\s+/).map(function (w) { return w.replace(/[^a-z]/g, ''); }).filter(Boolean));
    // Words split on punctuation too: "big-dick" -> "big", "dick".
    var split = joinSingles(s.split(/[^a-z]+/).filter(Boolean));

    for (var i = 0; i < spaced.length; i++)
      for (var j = 0; j < ANYWHERE_RE.length; j++)
        if (ANYWHERE_RE[j].test(spaced[i])) return true;

    var words = spaced.concat(split);
    for (var k = 0; k < words.length; k++)
      for (var m = 0; m < WORD_RE.length; m++)
        if (WORD_RE[m].test(words[k])) return true;
  }
  return false;
}

/** Name + school check shared by start and submit. Returns {name, school} or {error}. */
function vet(p) {
  var name = cleanName(p.name);
  if (!name || isBlocked(p.name) || isBlocked(name)) return { error: 'bad_name' };
  var school = cleanSchool(p.school);
  if (!school || isBlocked(p.school) || isBlocked(school)) return { error: 'bad_school' };
  return { name: name, school: school };
}

/* ============================================================
   School matching — keep in sync with schoolKey() in index.html
   ============================================================ */

var SCHOOL_FILLER = { the: 1, high: 1, school: 1, hs: 1, senior: 1, sr: 1 };

function schoolKey(s) {
  var words = String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(function (w) { return w === 'saint' ? 'st' : w === 'mount' ? 'mt' : w; });
  var kept = words.filter(function (w) { return !SCHOOL_FILLER[w]; });
  return (kept.length ? kept : words).join(' ');
}

function matchSchool(list, typed) {
  var k = schoolKey(typed);
  for (var i = 0; i < list.length; i++) if (schoolKey(list[i].name) === k) return list[i];
  return null;
}

/* ============================================================
   Actions
   ============================================================ */

function startCheck(p) {
  if (p.event !== EVENT_ID) return { ok: false, error: 'wrong_event' };
  var st = getStatus();
  if (!st.open) return { ok: false, error: 'closed', open: false };
  var v = vet(p);
  if (v.error) return { ok: false, error: v.error, open: true };
  var hit = matchSchool(cachedSchools(), v.school);
  return { ok: true, open: true, name: v.name, school: hit ? hit.name : v.school };
}

function submitScore(p) {
  if (p.event !== EVENT_ID) return { ok: false, error: 'wrong_event' };

  var id = String(p.id || '');
  if (!/^[A-Za-z0-9\-]{8,64}$/.test(id)) return { ok: false, error: 'bad_input' };

  // A retry of something we already recorded: hand back the first answer.
  var seen = cache().get(key('sub:' + id));
  if (seen) return JSON.parse(seen);

  var st = getStatus();
  if (!acceptingScores(st)) return { ok: false, error: 'closed', open: false };

  var v = vet(p);
  if (v.error) return { ok: false, error: v.error, open: st.open };

  var score = Math.max(0, Math.min(999999, parseInt(p.score, 10) || 0));
  var delivered = Math.max(0, Math.min(9999, parseInt(p.delivered, 10) || 0));

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, error: 'busy', retry: true };

  var school, ranks;
  try {
    // Check again under the lock, and against the sheet in case the cache
    // dropped the id: a retry usually lands within a few rows of its original.
    seen = cache().get(key('sub:' + id));
    if (seen) return JSON.parse(seen);
    var prior = findRecentId(id);
    if (prior) {
      school = prior.school;
      score = prior.score;
      ranks = getRanks();
    } else {
      var schools = readSchools();
      var hit = matchSchool(schools, v.school);
      school = hit ? hit.name : v.school;
      if (!hit) {
        sheet(SCHOOLS_TAB).appendRow([school, false]);
        cache().remove(key('schools'));
      }

      sheet(SCORES_TAB).appendRow([new Date(), v.name, school, score, delivered, false, id]);
      SpreadsheetApp.flush();
      ranks = addToRanks(school, score);
    }
  } finally {
    lock.releaseLock();
  }

  var res = {
    ok: true,
    open: st.open,
    school: school,
    rank: countAbove(ranks.all, score) + 1,
    schoolRank: countAbove(ranks.s[school.toLowerCase()] || [], score) + 1,
    total: ranks.all.length
  };
  cache().put(key('sub:' + id), JSON.stringify(res), SUBMIT_TTL_S);
  return res;
}

function findRecentId(id) {
  var sh = sheet(SCORES_TAB);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var n = Math.min(200, last - 1);
  var rows = sh.getRange(last - n + 1, 1, n, 7).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][6]) === id) return { school: String(rows[i][2]), score: parseInt(rows[i][3], 10) || 0 };
  }
  return null;
}

function admin(p) {
  var code = PropertiesService.getScriptProperties().getProperty('ADMIN_CODE');
  if (!code || !/^\d{6}$/.test(code)) return { ok: false, error: 'no_code' };

  var fails = Number(cache().get(key('adminFails'))) || 0;
  if (fails >= ADMIN_MAX_FAILS) return { ok: false, error: 'locked' };
  if (String(p.code || '') !== code) {
    cache().put(key('adminFails'), String(fails + 1), ADMIN_LOCKOUT_S);
    return { ok: false, error: 'bad_code', left: ADMIN_MAX_FAILS - fails - 1 };
  }
  cache().remove(key('adminFails'));

  if (p.op === 'close')  return { ok: true, open: setStatus(false).open };
  if (p.op === 'reopen') return { ok: true, open: setStatus(true).open };
  return { ok: false, error: 'unknown_op' };
}

/* ============================================================
   Ranks — sorted score lists kept in the cache so a submit doesn't
   re-read the whole sheet. Rebuilt from the sheet every RANKS_TTL_S.
   ============================================================ */

function buildRanks() {
  var r = { all: [], s: {} };
  readScores().forEach(function (row) {
    var k = row.school.toLowerCase();
    r.all.push(row.score);
    (r.s[k] = r.s[k] || []).push(row.score);
  });
  var asc = function (a, b) { return a - b; };
  r.all.sort(asc);
  Object.keys(r.s).forEach(function (k) { r.s[k].sort(asc); });
  return r;
}

function getRanks() {
  var c = cache().get(key('ranks'));
  if (c) return JSON.parse(c);
  var r = buildRanks();
  putRanks(r);
  return r;
}

function putRanks(r) {
  try { cache().put(key('ranks'), JSON.stringify(r), RANKS_TTL_S); } catch (e) { /* over 100KB: just rebuild next time */ }
}

// Called under the lock, after the row is written.
function addToRanks(school, score) {
  var c = cache().get(key('ranks'));
  if (!c) { var built = buildRanks(); putRanks(built); return built; } // already includes the new row
  var r = JSON.parse(c);
  var k = school.toLowerCase();
  insertSorted(r.all, score);
  insertSorted(r.s[k] = r.s[k] || [], score);
  putRanks(r);
  return r;
}

// First index whose value is > score.
function upperBound(arr, score) {
  var lo = 0, hi = arr.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] <= score) lo = mid + 1; else hi = mid; }
  return lo;
}
function insertSorted(arr, score) { arr.splice(upperBound(arr, score), 0, score); }
function countAbove(arr, score) { return arr.length - upperBound(arr, score); }

/* ============================================================
   Board
   ============================================================ */

function getBoard() {
  var c = cache().get(key('board'));
  if (c) return JSON.parse(c);

  var all = readScores();
  all.sort(function (a, b) { return b.score - a.score; });

  var bySchool = {};
  all.forEach(function (r) {
    var s = bySchool[r.school] = bySchool[r.school] || { school: r.school, top: [], players: 0, best: 0 };
    if (s.top.length < 5) s.top.push(r);
    s.players++;
    if (r.score > s.best) s.best = r.score;
  });
  var schools = Object.keys(bySchool).map(function (k) { return bySchool[k]; })
    .sort(function (a, b) { return b.best - a.best; });

  var board = { overall: all.slice(0, 10), schools: schools, players: all.length };
  try { cache().put(key('board'), JSON.stringify(board), BOARD_TTL_S); } catch (e) { /* too big to cache */ }
  return board;
}
