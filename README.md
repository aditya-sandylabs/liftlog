# LiftLog

A phone-first workout tracker for the **Built With Science Upper/Lower** routine,
modelled on the Strong app. Static site, no backend. Training data lives on the
device it was entered on; backing it up to your own Google Drive is **optional
and off by default** — connect it from Settings if you want it.

Built for two people: Aditya and his dad, each on their own Android phone, with
completely separate data.

## What's here

| File | What it is |
|---|---|
| `index.html` | App shell |
| `app.js` | The whole application (ES module) |
| `sync.js` | Optional Google Drive backup (lazy-loaded; inert until connected) |
| `features.js` | Pure logic: exercise search, heatmap, body-weight chart, merges |
| `strong.js` | Strong CSV import parser |
| `styles.css` | All styling; light + dark, manual override |
| `data.json` | **Generated, read-only.** The routine, exercise guides and video links |
| `quotes.json` | 20 Stoic passages with their sources |
| `sw.js` | Service worker — offline caching |
| `manifest.webmanifest` | PWA manifest |
| `icon-*.png`, `marcus.png` | Home-screen and tab icons |
| `deploy.sh` | Publishes to the GitHub Pages repo |
| `build/` | Data-generation and test scripts (not shipped to the site) |
| `HANDOFF.md` | Project context for a future session — decisions, constraints, gotchas |
| `RESUME-PROMPT.md` | Paste-ready prompt to continue this work in a new session |

## `data.json` is generated — don't hand-edit it

It was extracted from `Built With Science Upper-Lower Workout Routine (2024).pdf`
and contains:

- **4 templates** — Upper 1, Lower 1, Upper 2, Lower 2 (67 prescribed sets total)
- **21 exercises** with the full step-by-step guide text from the PDF
- **78 alternative exercises**, grouped under the lift they substitute for
- **73 unique YouTube video ids**

Every video id came from a link annotation in the PDF, mapped to its table row by
vertical position — never typed from memory. 11 of the 21 main lifts were
independently cross-checked against the alternatives tables, which list the same
exercises with the same ids on different pages. The build scripts live in
[`build/`](build/) — run `parse_guides.py` → `build_data.py` → `build_alts.py` →
`assemble.py`.

If the routine ever changes, regenerate the file rather than editing it by hand.
Never hand-edit it, and never have a model rewrite it: a fabricated video id is
indistinguishable from a correct one until someone taps it in a gym.

## Deploying to GitHub Pages

The source lives here inside the Sandy Labs workspace so it inherits the
workspace's git checkpointing. GitHub Pages needs its own small public repo with
the app at the root, so `deploy.sh` copies the shipping files there and pushes —
rather than nesting a second git repo inside this one.

It is already set up. The site is live at
**https://aditya-sandylabs.github.io/liftlog/** and publishing is one command:

```bash
cd "/d/Sandy Labs/_Personal/liftlog" && ./deploy.sh
```

Run it from Git Bash. It stamps a new service-worker cache version each time, so
phones pick up the new build instead of serving the old one from cache.

Setting it up from scratch elsewhere would be
`./deploy.sh https://github.com/<owner>/<repo>.git` once, then **Settings → Pages
→ Deploy from a branch → `main` / `(root)` → Save** on github.com.

> **Two traps, both hit once already.** The repo must stay **public** — making it
> private disables Pages, and making it public again does *not* switch Pages back
> on. And re-enabling Pages does *not* rebuild the site: it 404s until you push a
> commit, so run `./deploy.sh` after re-enabling.
>
> No training data is ever committed — only the app itself.

## Setting it up on a phone (the one-time bit)

1. Open the Pages URL in **Chrome** on the phone.
2. Menu (⋮) → **Add to Home screen** → **Install**.
3. Open it from the home-screen icon from then on.

That's the whole setup. It works offline afterwards, and tapping a "Watch on
YouTube" button hands off to the YouTube app.

## Backups

Training history lives in the phone's IndexedDB. That survives normal use, but
it does **not** survive "clear browsing data" or uninstalling the browser.

### Google Drive backup (recommended)

**Settings → Connect Google Drive.** After that it backs itself up automatically
after every workout, to *your own* Drive:

- `liftlog-backup.json` in Drive's hidden **appDataFolder** — the restore file.
  It does not appear in your Drive listing, so it cannot be deleted by accident.
- `LiftLog Workout History.csv` in your normal Drive — one row per set, openable
  in Sheets for analysis.

The app requests only `drive.appdata` and `drive.file`, so it can touch **only
files it created** — it cannot read anything else in your Drive.

Sync is a mirror, never the source of truth. IndexedDB stays authoritative, the
merge is a **union by workout id**, and a sync can never delete a workout. If
Drive is unreachable or was never connected, the app behaves exactly as before.

On a new phone: install, connect the same Google account, and the history pulls
back down.

### Coming from Strong

**Settings → Import from Strong (CSV).** Export from Strong (Settings → Export
Data) and pick the file. You get a preview of exactly what will be added before
anything is written.

Every exercise in the export becomes a real exercise in this app — they are not
auto-matched to the Built With Science ones, because a wrong match would
silently merge two exercises' histories with no undo.

Rest-timer rows in the export are skipped (they are not sets), exercise notes
are preserved, and re-importing the same file does nothing, so it is safe to
run twice.

### Manual backup

**Settings → Backup (JSON)** writes a full snapshot to the phone's Downloads.
Do that occasionally — monthly is plenty — and keep a copy somewhere off the
phone. **Import backup** merges by workout id, so restoring never wipes what is
already there.

`Export CSV` / `Markdown` / `TXT` are for reading and analysis elsewhere; the
JSON backup is the one that can actually restore the app.

## A note on the program

The routine prescribes taking some sets to failure with lengthened partials. The
app shows those cues verbatim from the PDF. That intensity is aggressive for a
beginner or an older lifter — treat the "to failure" column as optional until the
movement is well grooved.

Nothing here is medical or coaching advice; it is a logbook.

## Credit

The routine, the exercise instructions and the tutorial videos are the work of
**Jeremy Ethier / Built With Science**, taken from the freely distributed
*Upper/Lower Workout Routine (2024)* PDF. This repo is a personal logging tool
built around that programme — it is not affiliated with or endorsed by Built
With Science, and the training content remains theirs.

- Original PDF and other free routines: <https://builtwithscience.com/freeworkouts/>
- Video tutorials: <https://youtube.com/jeremyethier>

If you want the programme itself, get it from the source above rather than from
here.
