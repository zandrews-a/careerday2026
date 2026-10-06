# Herzog Dispatch — career day setup

| File | What it is | Where it goes |
|---|---|---|
| `Code.gs` | The scores API | Apps Script, attached to your Google Sheet |
| `index.html` | The game | Public URL, QR points here |
| `leaderboard.html` | The TV board + staff controls | Open fullscreen on the booth laptop |
| `tools/loadtest.mjs` | Burst test for the API | Run from your laptop before the event |

---

## 1. The Sheet

Make a new Google Sheet called **Herzog Dispatch**. You don't need to make the
tabs by hand: step 2 creates them.

When it's set up you'll have:

**`Scores`**: `Timestamp | Name | School | Score | Delivered | Hidden | Id`.
*Hidden* is a checkbox (see Moderation). *Id* is how retries get de-duplicated;
leave it alone.

**`Schools`**: `School | Approved`. Only rows with **Approved** ticked show up
in the game's school list. When you add schools yourself, tick the box. To tick
a lot at once, select the cells and press space.

---

## 2. The API

In the Sheet: **Extensions → Apps Script**. Delete whatever's there, paste in
all of `Code.gs`, save.

**Run `setup` once:** pick `setup` in the function dropdown at the top of the
editor and press **Run**. Authorize it when Google asks. This creates or fixes
both tabs, their headers and their checkboxes. It's safe to run again.

**Set the staff code:** go to **Project Settings (gear icon) → Script
properties → Add script property**:
- Property: `ADMIN_CODE`
- Value: any 6 digits, e.g. `482913`

The code lives only here. It isn't in any file in this repo and isn't in the web
pages, so nobody can find it by viewing page source.

Then go to **Deploy → New deployment**:
- Type: **Web app**
- Execute as: **Me**
- Who has access: **Anyone** ← this one matters, students aren't signed in

You'll get a URL ending in `/exec`. Copy it.

> Any time you edit `Code.gs`, you must go to **Deploy → Manage deployments →
> edit → New version** for the change to go live. Saving alone does nothing.

> If you're on a company Google Workspace account, an admin policy may block
> "Anyone" access. Check this early. A personal Google account avoids it.

---

## 3. Hosting the game

The game is static files, so any static host works. This repo lives in
Bitbucket, so you have two options:

**Bitbucket Cloud (no GitHub needed)**
1. In the `herzog-technologies` workspace, create a repo named exactly
   `herzog-technologies.bitbucket.io`
2. Push `index.html` and `leaderboard.html` to it
3. Live at `https://herzog-technologies.bitbucket.io/` (one of these per workspace)

**GitHub Pages**
1. Create a GitHub repo and push these files to it
2. Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`
3. Live in about a minute at `https://<user>.github.io/<repo>/`
   (the repo must be public unless your org pays for GitHub)

---

## 4. Wire them together

In **`index.html`**, near the bottom:
```js
var API_URL  = "https://script.google.com/macros/s/..../exec";
var EVENT_ID = "dispatch-2026";
```

In **`leaderboard.html`**:
```js
var API_URL  = "https://script.google.com/macros/s/..../exec";
var GAME_URL = "https://herzog-technologies.bitbucket.io/";
```

`EVENT_ID` must match the one at the top of `Code.gs`. **For next year's event,
change it in both places.** Phones keep unsent scores in their browser storage,
and a new ID stops a stale 2026 score from posting to the 2027 board.

The QR code generates itself from `GAME_URL`.

---

## 5. Load test (do this before the event)

Make a **test copy**: File → Make a copy of the Sheet, then repeat step 2 on the
copy to get a separate `/exec` URL. Then, with Node 18+:

```
node tools/loadtest.mjs https://script.google.com/macros/s/..../exec --count 300 --phones 100
```

It fires 300 scores from 100 simulated phones, using the same retry rules as
the game, and re-sends some with the same ID to check nothing doubles. You want
`PASS: every score landed exactly once.` A high retry count is fine; it just
means the backend was busy and phones waited their turn. Lost or doubled scores
are what matters.

Delete the test copy afterward, or at least its `Load 00001...` rows.

---

## How the pieces behave

**Scores are queued on the phone.** A finished run is saved to the phone's
browser storage first, then sent. It's removed only once the server answers. If
the backend is busy or the signal drops, the player sees "still sending" and
the phone retries:
- waits are random and grow each time: 0–2s, then 0–4s, 0–8s, 0–16s
- after 5 failures in a row, it retries once every 1–2 minutes
- a phone never has more than one request in flight

Unsent scores survive a page reload and are dropped after 12 hours.

**Retries can't double a score.** Every run gets a random ID, and the server
records each ID only once.

**Busy means "come back shortly."** Writes take turns behind a lock. If a
request can't get the lock within 5 seconds, the server answers "busy" right
away instead of holding one of Apps Script's ~30 execution slots.

**Name and school are checked when the student presses Start**, not after the
run, so nobody loses a good run to a name that won't post. If that check can't
reach the server, they play anyway and the score is checked again when it posts.

---

## Moderation

**Filter.** Names and schools both go through the lists at the top of `Code.gs`:
- `BLOCK_ANYWHERE`: blocked even inside a word. Only for terms that never turn up in real names.
- `BLOCK_WORD`: blocked only as a whole word, plurals included. Use this for
  anything that hides inside real names (Draper, Hancock, Dickinson, Essex, Nazir, Spicer).
- `BLOCK_NUMBER`: blocked as a standalone number (69, 420, ...).
- `ALLOW`: real names that would otherwise trip the lists (Scunthorpe, Matsushita, Coon Rapids).

Before checking, the filter undoes number-for-letter swaps (`sh1t`), repeated
letters (`fuuuck`), spaced or dotted letters (`f.u.c.k`), and joined-up words
(`BigDick`). A standalone "Dick" is blocked, a tradeoff of the whole-word rule.
Innuendo built from innocent words isn't caught; that's what Hidden is for.

After editing the lists, deploy a new version (see step 2).

**Hide a score.** Tick **Hidden** on its row in `Scores`. It drops off the
board within about 10 seconds and out of ranks within a minute. The row stays,
so un-ticking brings it back. This beats deleting rows.

**New schools.** A school typed in by a student counts for their score right
away. It's added to `Schools` unticked, so other students don't see it in the
list until you tick **Approved**. Fix the spelling first if it needs it. Close
variations ("lincoln hs", "Lincoln High") are matched to the existing school
automatically and don't create new rows.

Keep the Sheet open on your phone during the event.

---

## Ending the event

On the TV board, **tap the HERZOG logo 5 times** to open the staff panel. Enter
the 6-digit code and press **End event**, then press it again to confirm.

- The board switches to a FINAL RESULTS banner.
- Phones switch to a "That's a wrap" screen with the final scores within about
  a minute. Phones check when the page loads, after every score, when the student
  comes back to the tab, and once every 1–2 minutes in the background.
- Anyone mid-run can finish: scores are still accepted for 2 minutes after you
  end the event, and then their phone offers "See final scores".
- **Reopen** in the same panel undoes it.
- After 10 wrong codes the panel locks for 15 minutes. If that happens to you,
  wait it out, or change `ADMIN_CODE` in Script properties.

### Taking it down afterward

1. End the event from the TV board (above). Leave the backend running for about
   a week. Students with the page still open get "closed" back, so their phones
   clear any unsent scores and stop retrying.
2. Then go to **Deploy → Manage deployments → Archive**. Any tab still open
   after that gets an error, backs off to one try every couple of minutes, and
   gives up when its scores expire (12 hours). That traffic goes to Google,
   not to anything you run.
3. Take down the static site whenever you like.

---

## Day-of checklist

- [ ] `ADMIN_CODE` set; test End event → Reopen once on the TV board
- [ ] Schools you know are in `Schools` with **Approved** ticked
- [ ] Clear old rows from `Scores` so the board starts empty
- [ ] Load test passed against the test copy (step 5)
- [ ] Open `leaderboard.html` fullscreen (F11) on the TV
- [ ] Disable sleep and screensaver on the laptop
- [ ] Test the QR with your own phone on **cell data**, not the venue wifi;
      that's how the students will hit it
- [ ] Print a QR for the table as a backup
- [ ] Keep the Sheet open on your phone for hiding entries and approving schools

---

## Known limits

- Apps Script takes 1–3 seconds to respond on a cold start, so the first
  Start of the morning may feel slow.
- About 30 requests can run at once. Bursts beyond that are absorbed by the
  "busy" answer and the phones' retries; scores arrive a few seconds late, not lost.
- Scores come from the browser, so a technical student could post a fake one.
  Hide it.
- The TV board polls every 8 seconds, so it's near-live, not instant.
