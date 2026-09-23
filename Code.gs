/**
 * HERZOG DISPATCH — scores backend
 * Paste this into Extensions > Apps Script on your Google Sheet.
 *
 * Sheet tabs required:
 *   Scores   A:Timestamp  B:Name  C:School  D:Score  E:Delivered
 *   Schools  A:School name  (one per row, no header needed after row 1)
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Copy the /exec URL into API_URL in both HTML files.
 */

var SCORES_TAB  = 'Scores';
var SCHOOLS_TAB = 'Schools';
var MAX_NAME    = 14;

// Anything containing these is rejected. Add to it freely.
var BLOCKED = ['fuck','shit','bitch','cunt','nigg','fag','rape','penis','dick','cock','hitler','nazi','slut','whore','anus','tits','porn'];

function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var action = p.action || 'board';
  try {
    if (action === 'config') return json({ ok: true, schools: getSchools() });
    if (action === 'submit') return json(submitScore(p));
    if (action === 'board')  return json({ ok: true, board: getBoard(), schools: getSchools() });
    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// POST works too, in case you'd rather use it.
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    return json(submitScore(body));
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (name === SCORES_TAB) sh.appendRow(['Timestamp', 'Name', 'School', 'Score', 'Delivered']);
    if (name === SCHOOLS_TAB) sh.appendRow(['School']);
  }
  return sh;
}

function getSchools() {
  var sh = sheet(SCHOOLS_TAB);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (v) { return v.length > 0; });
}

function cleanName(raw) {
  var n = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  n = n.replace(/[^A-Za-z0-9 .'\-]/g, '');
  var flat = n.toLowerCase().replace(/[^a-z]/g, '');
  for (var i = 0; i < BLOCKED.length; i++) {
    if (flat.indexOf(BLOCKED[i]) !== -1) return null;
  }
  return n.length ? n : null;
}

function submitScore(p) {
  var name = cleanName(p.name);
  if (!name) return { ok: false, error: 'bad_name' };

  var school = String(p.school || '').trim().slice(0, 60);
  if (!school) school = 'Unlisted';

  var score = Math.max(0, Math.min(999999, parseInt(p.score, 10) || 0));
  var delivered = Math.max(0, Math.min(9999, parseInt(p.delivered, 10) || 0));

  // A new school typed into "Other" gets added to the list automatically.
  var schools = getSchools();
  var known = schools.some(function (s) { return s.toLowerCase() === school.toLowerCase(); });
  if (!known && school !== 'Unlisted') sheet(SCHOOLS_TAB).appendRow([school]);

  sheet(SCORES_TAB).appendRow([new Date(), name, school, score, delivered]);

  var all = readScores();
  var overall = all.filter(function (r) { return r.score > score; }).length + 1;
  var inSchool = all.filter(function (r) {
    return r.school.toLowerCase() === school.toLowerCase() && r.score > score;
  }).length + 1;

  return { ok: true, rank: overall, schoolRank: inSchool, total: all.length, school: school };
}

function readScores() {
  var sh = sheet(SCORES_TAB);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 5).getValues()
    .filter(function (r) { return r[1]; })
    .map(function (r) {
      return {
        name: String(r[1]),
        school: String(r[2] || 'Unlisted'),
        score: parseInt(r[3], 10) || 0,
        delivered: parseInt(r[4], 10) || 0
      };
    });
}

function getBoard() {
  var all = readScores();
  all.sort(function (a, b) { return b.score - a.score; });

  var bySchool = {};
  all.forEach(function (r) {
    if (!bySchool[r.school]) bySchool[r.school] = [];
    if (bySchool[r.school].length < 5) bySchool[r.school].push(r);
  });

  var schools = Object.keys(bySchool).map(function (name) {
    var rows = all.filter(function (r) { return r.school === name; });
    return {
      school: name,
      top: bySchool[name],
      players: rows.length,
      best: rows.length ? rows[0].score : 0
    };
  }).sort(function (a, b) { return b.best - a.best; });

  return { overall: all.slice(0, 10), schools: schools, players: all.length };
}
