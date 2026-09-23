# Herzog Dispatch — career day setup

Three files:

| File | What it is | Where it goes |
|---|---|---|
| `Code.gs` | The scores API | Apps Script, attached to your Google Sheet |
| `index.html` | The game | Public URL, QR points here |
| `leaderboard.html` | The TV board | Open fullscreen on the booth laptop |

---

## 1. The Sheet

Make a new Google Sheet called **Herzog Dispatch**. Two tabs:

**`Scores`** — row 1 headers:
```
Timestamp | Name | School | Score | Delivered
```

**`Schools`** — row 1 header `School`, then one school per row starting at A2.
Leave it empty for now. Add schools as you learn who's coming — the game reads
this tab live, so a school you type in at 8:55am shows up in the dropdown at 8:56.

If a student picks "Other" and types a school, it gets appended to this tab
automatically, so the next student from that school gets it in the dropdown.

---

## 2. The API

In the Sheet: **Extensions → Apps Script**. Delete whatever's there, paste in
all of `Code.gs`, save.

Then **Deploy → New deployment**:
- Type: **Web app**
- Execute as: **Me**
- Who has access: **Anyone** ← this one matters, students aren't signed in

Authorize it when Google asks. You'll get a URL ending in `/exec`. Copy it.

> Any time you edit `Code.gs`, you must **Deploy → Manage deployments → edit →
> New version** for the change to go live. Editing alone does nothing.

---

## 3. Hosting the game

`index.html` needs a public URL. GitHub Pages is the least friction since you
already have an account:

1. New public repo, e.g. `zbenedict/dispatch`
2. Upload `index.html` and `leaderboard.html`
3. Settings → Pages → Source: `main`, folder `/root`
4. Live in about a minute at `https://zbenedict.github.io/dispatch/`

---

## 4. Wire them together

In **`index.html`**, near the bottom:
```js
var API_URL = "https://script.google.com/macros/s/..../exec";
```

In **`leaderboard.html`**:
```js
var API_URL  = "https://script.google.com/macros/s/..../exec";
var GAME_URL = "https://zbenedict.github.io/dispatch/";
```

The QR code generates itself from `GAME_URL` — nothing to make or print
separately, though printing a big one for the table is still worth doing.

---

## Moderation

Names are capped at 14 characters and run through a blocklist in `Code.gs`
(the `BLOCKED` array — add to it). Rejected names get a "try your real one"
message and nothing is written.

Someone will still get something through. When they do: open the Sheet, delete
the row. The TV board picks it up within 8 seconds. Keep the Sheet open on your
phone during the event.

---

## Day-of checklist

- [ ] Add the schools you know to the `Schools` tab
- [ ] Clear old rows from `Scores` so the board starts empty
- [ ] Open `leaderboard.html` fullscreen (F11) on the TV
- [ ] Disable sleep and screensaver on the laptop
- [ ] Test the QR with your own phone on **cell data**, not the venue wifi —
      that's how the students will hit it
- [ ] Print a QR for the table as a backup
- [ ] Keep the Sheet open on your phone for name cleanup

---

## Known limits

- Apps Script takes 1-3 seconds to respond on a cold start. The first score of
  the morning may feel slow; after that it's warm.
- Quotas are generous but not infinite. A few hundred submissions is nothing.
- The board polls every 8 seconds, so it's near-live, not instant.
