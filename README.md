# LiftLog

A phone-first workout tracker for the **Built With Science Upper/Lower** routine,
modelled on the Strong app. Static site, no backend, no accounts. All training
data stays on the device it was entered on.

Built for two people: Aditya and his dad, each on their own Android phone.

## What's here

| File | What it is |
|---|---|
| `index.html` | App shell |
| `app.js` | The whole application (single ES module) |
| `styles.css` | All styling; light + dark, manual override |
| `data.json` | **Generated, read-only.** The routine, exercise guides and video links |
| `sw.js` | Service worker — offline caching |
| `manifest.webmanifest` | PWA manifest |
| `icon-*.png` | Home-screen icons |

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
exercises with the same ids on different pages. The build scripts live in the
session scratchpad (`parse_guides.py`, `build_data.py`, `build_alts.py`,
`assemble.py`).

If the routine ever changes, regenerate the file rather than editing it by hand.

## Deploying to GitHub Pages

The source lives here inside the Sandy Labs workspace so it inherits the
workspace's git checkpointing. GitHub Pages needs its own small public repo with
the app at the root, so `deploy.sh` copies the shipping files there and pushes —
rather than nesting a second git repo inside this one.

One time: create an empty **public** repo on github.com named `liftlog`, then:

```bash
cd "D:/Sandy Labs/_Personal/liftlog" && bash deploy.sh <your-github-username>
```

Then on github.com: **Settings → Pages → Source: Deploy from a branch →
`main` / `(root)` → Save.** After a minute the app is live at
`https://<your-username>.github.io/liftlog/`.

Every time after that, just:

```bash
cd "D:/Sandy Labs/_Personal/liftlog" && bash deploy.sh
```

The script bumps the service-worker cache name on each publish, so phones pick up
the new build instead of serving the old one from cache forever.

> The repo must be **public** for Pages on a free account. Nothing sensitive is in
> it — no training data is ever committed, only the app itself.

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
