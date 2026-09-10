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
| `nutrition.js` | Pure logic: foods, recipes, meal entries, macro targets, merges |
| `body.js` | Pure logic: body measurements, progress-photo metadata, tracking-sheet import |
| `strong.js` | Strong CSV import parser |
| `styles.css` | All styling; light + dark, manual override |
| `data.json` | **Generated, read-only.** The routine, exercise guides and video links |
| `foods.json` | **Generated, read-only.** 13,766-food offline nutrition database |
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

## `foods.json` is generated too — same rule

The offline food database behind meal logging. **13,766 foods, 2.77 MB (0.46 MB
gzipped)**, fetched once the first time you open the Food tab and cached from then
on. Three real sources, none of it typed from memory:

| Tag shown in the app | Source | Foods |
|---|---|---|
| `IFCT` | Indian Food Composition Tables 2017 (ICMR-NIN), via the MIT-licensed `@ifct2017/compositions` package | 542 |
| `Cooked` | USDA FoodData Central — Survey (FNDDS), foods **as consumed** | 5,431 |
| *(none)* | USDA FoodData Central — SR Legacy, generic whole foods | 7,793 |

12,927 foods carry household portion weights ("1 large", "1 cup, cooked"), so you
can usually tap a portion instead of weighing. The 542 IFCT foods carry local-language
names, so searching **sajje** or **kambu** finds **Bajra**.

To regenerate: download the three bundles listed at the top of
[`build/build_foods.py`](build/build_foods.py), unpack them into one directory, then

```bash
python build/build_foods.py <that-directory>
```

The script refuses to write a database that fails its own sanity checks (energy
above 950 kcal/100 g, a macro outside 0–100.5 g, or macros summing above 105 g).
Same rule as `data.json`: **never hand-edit it and never let a model rewrite it.**
A fabricated calorie count is indistinguishable from a correct one until you have
eaten it.

## Food, measurements and photos

- **Food** (its own tab) — four meal slots a day, energy and macros against targets
  you set yourself, a 14-day chart, and "copy a previous day". Search the database,
  or create your own food from a label. Nothing is enforced; the app shows what you
  ate against what you said you wanted, and that is all.
- **Recipes** — no database contains *your* dal. Build a dish once from ingredients,
  say how many servings it makes, then log it in one tap.
- **Measurements** (under Stats) — 7 tape measurements and 17 body-composition
  fields from a bioimpedance scale. Tap any field to chart it. Leave anything you
  did not measure blank; a blank is stored as "not measured", never as zero.
- **Progress photos** (under Stats) — front, side and rear. Same pose, same spot,
  same light is what makes them comparable. Stored on the phone and, if Drive is
  connected, backed up as individual files. A "•" next to a photo means it has not
  been backed up yet.
- **Import tracking sheet** (Settings) — the fortnightly measurements table. Two
  ways in, and they produce identical results:
  - **Paste tracking sheet** — open the sheet, select the table (including the top
    row of dates and the left column of labels), copy, paste. Easiest on a phone,
    because it never touches the file system. A spreadsheet paste is tab-separated
    and the parser detects that automatically.
  - **Import tracking sheet (CSV)** — pick an exported `.csv` file.

  Either way you get a preview before anything is saved. The `Weight` row merges
  into your existing body-weight history rather than starting a second one,
  re-importing the same sheet updates rows instead of duplicating them, and any row
  it does not recognise is listed in the dialog rather than silently dropped.

**You only import once.** After that the app owns the measurements and keeps the
spreadsheet up to date for you — see below.

**Whose data is whose.** There is no shared account: each phone has its own storage
and backs up to its own Google Drive. An import only ever affects the phone you do
it on, and the app holds no data until you put some in. If two people use LiftLog,
neither one's measurements, photos or food are visible to the other.

## The spreadsheet keeps itself now

Once your measurements are in the app, you stop maintaining the sheet by hand. The
app writes **`LiftLog Body Measurements.csv`** to your Google Drive on every backup,
in the same layout as before — dates across the top, measurements down the side.
Open it in Sheets whenever you want; it is regenerated from the app, so the two can
never drift apart.

Settings → **Export measurements sheet** downloads the same file to the phone if you
have not connected Drive.

Because it is written in the same format the importer reads, the file is also a way
back in: edit it in Sheets and paste it back, or use it to set the app up on a new
phone. Nothing is lost in the round trip.

Two details worth knowing:

- **Columns are the dates you took measurements**, not every day you weighed
  yourself — otherwise the sheet would grow a column a day. Your weight on those
  dates is included. The complete daily weight history is in the JSON backup.
- **The photo rows stay in the file but are always empty**, because a spreadsheet
  cannot hold pictures. The photos themselves are in the app and backed up
  separately.

**Body weight is still logged in one place only** — Stats → Log body weight. The
measurement screen deliberately has no weight field, so there is only ever one
weight history.

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
- `LiftLog Body Measurements.csv` in your normal Drive — your measurement history
  as a spreadsheet, rewritten from the app on every backup. See "The spreadsheet
  keeps itself now" above.
- **Progress photos, one hidden file per image**, also in appDataFolder. They are
  kept out of the backup JSON on purpose: that file is rewritten after every
  workout, so an image inside it would be re-uploaded every single time. Each photo
  instead moves once and the backup records only its id.

The app requests only `drive.appdata` and `drive.file`, so it can touch **only
files it created** — it cannot read anything else in your Drive.

Sync is a mirror, never the source of truth. IndexedDB stays authoritative, the
merge is a **union by workout id**, and a sync can never delete a workout. If
Drive is unreachable or was never connected, the app behaves exactly as before.

Food entries, measurements and photos work slightly differently: deleting one
**does** propagate to your other devices. Workouts are deleted almost never, but a
mis-logged meal gets deleted often, and a breakfast that reappeared every time you
opened the app on another phone would be maddening. Nothing is ever silently
dropped — a deletion is recorded as a deletion.

**A JSON backup does not contain your photos**, only their details and where they
are stored in Drive. The images come back from Drive, not from that file.

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
