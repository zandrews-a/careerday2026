#!/usr/bin/env node
/**
 * Burst-tests the scores backend the way a room full of phones would hit it.
 *
 *   node tools/loadtest.mjs <exec-url> [--count 300] [--phones 100] [--dupes 0.1]
 *
 *   --count   scores to submit in total
 *   --phones  simulated phones sending at once (each has one request in flight, like the game)
 *   --dupes   fraction of scores re-sent with the same id afterward, to check nothing doubles
 *
 * Needs Node 18+. Run it against a TEST copy of the Sheet + deployment, never
 * the event one: it writes real rows ("Load 00001", "Load 00002"... at "Load Test HS")
 * and adds "Load Test HS" to the Schools tab. Delete them afterward.
 *
 * Passes when every score is accepted exactly once: the board's player count
 * goes up by --count, and every re-sent duplicate comes back with its
 * original answer.
 */

const EVENT_ID = 'dispatch-2026'; // must match Code.gs

const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http'));
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? def : Number(args[i + 1]);
};
const COUNT = opt('count', 300);
const PHONES = opt('phones', 100);
const DUPES = opt('dupes', 0.1);

if (!url) {
  console.error('usage: node tools/loadtest.mjs <exec-url> [--count 300] [--phones 100] [--dupes 0.1]');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, body, query = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url + query, {
      method,
      body: body && JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

async function players() {
  const d = await call('GET', null, '?action=board&t=' + Date.now());
  if (!d.ok) throw new Error('board failed: ' + JSON.stringify(d));
  return d.board.players;
}

// Same retry rules as the game: full-jitter exponential backoff, slow mode after 5 straight failures.
async function submitWithRetry(item, stats) {
  let fails = 0;
  for (;;) {
    const t0 = Date.now();
    let d = null;
    try { d = await call('POST', item); } catch (e) { d = null; }
    stats.latency.push(Date.now() - t0);
    if (d && !d.retry) return d;
    stats.retries++;
    if (d && d.error === 'busy') stats.busy++;
    fails++;
    await sleep(fails >= 5 ? 60000 + Math.random() * 60000 : 500 + Math.random() * Math.min(60000, 2000 * 2 ** (fails - 1)));
  }
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

(async () => {
  console.log(`Target: ${url}`);
  const status = await call('GET', null, '?action=status&t=' + Date.now());
  if (!status.ok) throw new Error('status failed: ' + JSON.stringify(status));
  if (status.event !== EVENT_ID) throw new Error(`backend EVENT_ID is ${status.event}, this script uses ${EVENT_ID}`);
  if (!status.open) throw new Error('event is closed — reopen it from the TV board first');

  const before = await players();
  console.log(`Players on board before: ${before}`);
  console.log(`Sending ${COUNT} scores from ${PHONES} phones at once...`);

  const runTag = Date.now().toString(36);
  const items = Array.from({ length: COUNT }, (_, i) => ({
    action: 'submit', event: EVENT_ID,
    id: `load-${runTag}-${i}`,
    name: `Load ${String(i + 1).padStart(5, "0")}`, // padded: "Load 69" would trip the number filter
    school: 'Load Test HS',
    score: Math.floor(Math.random() * 5000),
    delivered: Math.floor(Math.random() * 30),
  }));

  const stats = { latency: [], retries: 0, busy: 0, accepted: 0, rejected: [] };
  const results = new Map();
  const queue = items.slice();
  const t0 = Date.now();

  await Promise.all(Array.from({ length: PHONES }, async () => {
    for (let item; (item = queue.shift());) {
      const d = await submitWithRetry(item, stats);
      results.set(item.id, d);
      if (d.ok) stats.accepted++; else stats.rejected.push(d.error);
    }
  }));
  const secs = (Date.now() - t0) / 1000;

  // Re-send some with the same id, as a phone would after a lost reply.
  const dupes = items.filter(() => Math.random() < DUPES);
  let dupeMismatch = 0;
  await Promise.all(dupes.map(async item => {
    const d = await submitWithRetry(item, stats);
    if (JSON.stringify(d) !== JSON.stringify(results.get(item.id))) dupeMismatch++;
  }));

  console.log('Waiting 12s for the board cache to refresh...');
  await sleep(12000);
  const after = await players();
  const added = after - before;

  console.log('\n--- Results ---');
  console.log(`Time to send all:     ${secs.toFixed(1)}s`);
  console.log(`Accepted:             ${stats.accepted}/${COUNT}`);
  if (stats.rejected.length) console.log(`Rejected:             ${stats.rejected.length} (${[...new Set(stats.rejected)].join(', ')})`);
  console.log(`Retries:              ${stats.retries} (${stats.busy} were "busy")`);
  console.log(`Latency p50 / p95:    ${pct(stats.latency, 50)}ms / ${pct(stats.latency, 95)}ms`);
  console.log(`Duplicates re-sent:   ${dupes.length}, answers changed: ${dupeMismatch}`);
  console.log(`Board players added:  ${added} (expected ${stats.accepted})`);

  const pass = stats.accepted === COUNT && added === COUNT && dupeMismatch === 0;
  console.log(pass ? '\nPASS: every score landed exactly once.' : '\nFAIL: see the numbers above.');
  console.log('Clean up: delete the "Load N" rows from Scores and "Load Test HS" from Schools.');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e.message || e); process.exit(1); });
