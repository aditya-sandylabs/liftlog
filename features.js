/*
 * LiftLog — features.js
 *
 * Pure logic module: no DOM, no storage, no network.
 * Data in → data / SVG strings out. The host app does all wiring.
 *
 * Canonical shapes (do NOT invent variants):
 *   workout.sets is FLAT on the workout (no workout.exercises level).
 *   built-in exercises use `id` (not exerciseId) and live in data.exercises.
 */

const DAY_MS = 86400000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Escape user-supplied text for safe interpolation into SVG/XML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lowercase + strip diacritics so matching is case/accent-insensitive. */
function normText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Local-calendar-day key (YYYY-MM-DD) — heatmap/day-bucketing uses local days. */
function dayKeyLocal(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ------------------------------------------------------------------ */
/* Exercises                                                           */
/* ------------------------------------------------------------------ */

export function slugify(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Flat, searchable index of everything the user can pick.
 * Tolerates null/undefined/malformed inputs — returns [] rather than throwing.
 */
export function buildExerciseIndex({ data, custom, workouts, library } = {}) {
  // Usage stats: distinct workouts + total non-warm-up sets per exercise id.
  const usage = new Map();
  if (Array.isArray(workouts)) {
    for (const w of workouts) {
      if (!w || typeof w !== 'object') continue;
      const st = Number.isFinite(w.startTime) ? w.startTime : null;
      const seen = new Set(); // one workout counts once per exercise
      const sets = Array.isArray(w.sets) ? w.sets : [];
      for (const s of sets) {
        if (!s || typeof s !== 'object' || s.isWarmup) continue;
        const eid = s.exerciseId;
        if (!eid) continue;
        let u = usage.get(eid);
        if (!u) { u = { setsLogged: 0, timesLogged: 0, lastLoggedTs: null }; usage.set(eid, u); }
        u.setsLogged++;
        if (!seen.has(eid)) {
          seen.add(eid);
          u.timesLogged++;
          if (st != null && (u.lastLoggedTs == null || st > u.lastLoggedTs)) u.lastLoggedTs = st;
        }
      }
    }
  }

  const out = [];
  const byId = new Map();
  const push = (item) => {
    if (item && item.id && !byId.has(item.id)) { byId.set(item.id, true); out.push(item); }
  };

  // Built-ins: data.exercises is keyed by id (object) but tolerate arrays too.
  let builtins = [];
  if (data && typeof data === 'object' && data.exercises) {
    builtins = Array.isArray(data.exercises) ? data.exercises : Object.values(data.exercises);
  }

  // Alternatives exist only inside parents' arrays; dedupe by slugified id,
  // first parent wins.
  const seenAlt = new Set();
  for (const ex of builtins) {
    if (!ex || typeof ex !== 'object' || !ex.id) continue;
    push({
      id: ex.id,
      name: ex.name,
      muscle: ex.muscle != null ? ex.muscle : null,
      video: ex.video != null ? ex.video : null,
      bodyweight: !!ex.bodyweight,
      custom: false,
      isAlternative: false,
      timesLogged: 0, setsLogged: 0, lastLoggedTs: null,
    });
    if (Array.isArray(ex.alternatives)) {
      for (const alt of ex.alternatives) {
        if (!alt || typeof alt !== 'object' || !alt.name) continue;
        const aid = slugify(alt.name);
        if (!aid || seenAlt.has(aid)) continue;
        seenAlt.add(aid);
        push({
          id: aid,
          name: alt.name,
          muscle: ex.muscle != null ? ex.muscle : null,
          video: alt.video != null ? alt.video : null,
          bodyweight: false,
          custom: false,
          isAlternative: true,
          timesLogged: 0, setsLogged: 0, lastLoggedTs: null,
        });
      }
    }
  }

  // Cardio built-ins. They live here rather than in data.json because
  // data.json is generated from the Built With Science PDF and is rebuilt by
  // the scripts in build/ -- anything hand-added there would be wiped.
  for (const c of CARDIO_EXERCISES) {
    push({
      id: c.id,
      name: c.name,
      muscle: 'Cardio',
      video: null,
      bodyweight: true,
      cardio: true,
      mode: c.mode,
      met: c.met,
      custom: false,
      isAlternative: false,
      timesLogged: 0, setsLogged: 0, lastLoggedTs: null,
    });
  }

  // The guided library (guides.json): every exercise that has instructions, a
  // key tip and a muscle map ships as a built-in, so a lift someone once added
  // by hand (or imported from Strong) is in the main list for every user, not
  // labelled "custom" on one phone. Cardio is skipped — time-based logging
  // needs a mode/MET, which only CARDIO_EXERCISES and custom records carry.
  // When the user also has a custom record with the same id, its bodyweight
  // flag is kept so the set row does not suddenly grow a weight column.
  const customById = new Map();
  if (Array.isArray(custom)) for (const c of custom) if (c && c.id) customById.set(c.id, c);
  // guides.json keys on slugify(name), but 16 of the 21 PDF main lifts use a
  // shorter id ('pull-up' for "Pull-Ups") and several alternatives repeat a main
  // lift's name — so a library row whose NAME is already listed is the same
  // exercise under its guide slug and must not become a second row.
  const namesSeen = new Set(out.map(x => slugify(x.name)));
  if (Array.isArray(library)) {
    for (const g of library) {
      if (!g || !g.id || !g.name || byId.has(g.id)) continue;
      if (namesSeen.has(slugify(g.name))) continue;
      if (g.muscle === 'Cardio') continue;
      const own = customById.get(g.id);
      if (own && isCardio(own)) continue;
      push({
        id: g.id,
        name: g.name,
        muscle: g.muscle != null ? g.muscle : null,
        video: null,
        bodyweight: !!g.bodyweight || !!(own && own.bodyweight),
        custom: false,
        isAlternative: false,
        timesLogged: 0, setsLogged: 0, lastLoggedTs: null,
      });
    }
  }

  if (Array.isArray(custom)) {
    for (const c of custom) {
      if (!c || typeof c !== 'object' || !c.id) continue;
      const cardio = isCardio(c);
      push({
        id: c.id,
        name: c.name,
        muscle: c.muscle != null ? c.muscle : null,
        video: null,
        // A cardio exercise has no weight column by definition.
        bodyweight: cardio ? true : !!c.bodyweight,
        cardio: cardio,
        mode: cardio ? cardioMode(c) : null,
        met: typeof c.met === 'number' && isFinite(c.met) ? c.met : null,
        custom: true,
        isAlternative: false,
        timesLogged: 0, setsLogged: 0, lastLoggedTs: null,
      });
    }
  }

  for (const it of out) {
    const u = usage.get(it.id);
    if (u) {
      it.timesLogged = u.timesLogged;
      it.setsLogged = u.setsLogged;
      it.lastLoggedTs = u.lastLoggedTs;
    }
  }
  return out;
}

/**
 * Ranking rule (lower rank wins):
 *   0 = blank query (everything, default sort)
 *   1 = exact name match
 *   2 = name starts with query
 *   3 = name contains query
 *   4 = muscle contains query
 *   5 = multi-token query where every token hits name or muscle
 * Within a rank: timesLogged desc, then alphabetical by name.
 */
export function searchExercises(index, query, opts = {}) {
  if (!Array.isArray(index)) return [];
  const q = normText(query).trim();
  const muscleFilter = opts.muscle != null ? normText(opts.muscle) : null;
  const tokens = q.split(/\s+/).filter(Boolean);

  const scored = [];
  for (const it of index) {
    if (!it || typeof it !== 'object') continue;
    if (muscleFilter != null && normText(it.muscle) !== muscleFilter) continue;
    const nName = normText(it.name);
    const nMuscle = normText(it.muscle);
    let rank;
    if (!q) rank = 0;
    else if (nName === q) rank = 1;
    else if (nName.startsWith(q)) rank = 2;
    else if (nName.includes(q)) rank = 3;
    else if (nMuscle && nMuscle.includes(q)) rank = 4;
    else if (tokens.length > 1 && tokens.every((t) => nName.includes(t) || (nMuscle && nMuscle.includes(t)))) rank = 5;
    else continue;
    scored.push([rank, it]);
  }

  scored.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    const ta = a[1].timesLogged || 0;
    const tb = b[1].timesLogged || 0;
    if (tb !== ta) return tb - ta;
    return String(a[1].name == null ? '' : a[1].name)
      .localeCompare(String(b[1].name == null ? '' : b[1].name), undefined, { sensitivity: 'base' });
  });

  let res = scored.map((p) => p[1]);
  if (Number.isFinite(opts.limit) && opts.limit >= 0) res = res.slice(0, Math.floor(opts.limit));
  return res;
}

/**
 * Alphabetical sections for the Exercises browser, Strong-style.
 * Sorts A→Z by name (case/accent-insensitive) and groups by first letter.
 * Anything that does not start with a letter lands in a trailing '#' group, so
 * "3-Point Dumbbell Row" is findable instead of inventing a "3" heading between
 * the letters. Returns [] for junk input rather than throwing.
 */
export function groupExercisesAlpha(list) {
  if (!Array.isArray(list)) return [];
  const items = list.filter((it) => it && typeof it === 'object');
  items.sort((a, b) => String(a.name == null ? '' : a.name)
    .localeCompare(String(b.name == null ? '' : b.name), undefined, { sensitivity: 'base' }));
  const groups = [];
  const byLetter = new Map();
  for (const it of items) {
    const first = String(it.name == null ? '' : it.name).trim().charAt(0).toUpperCase();
    const letter = /^[A-Z]$/.test(first) ? first : '#';
    let g = byLetter.get(letter);
    if (!g) { g = { letter, items: [] }; byLetter.set(letter, g); groups.push(g); }
    g.items.push(it);
  }
  // Letters in order, '#' last — it is a catch-all, not a letter.
  groups.sort((a, b) => {
    if (a.letter === '#') return 1;
    if (b.letter === '#') return -1;
    return a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0;
  });
  return groups;
}

export function makeCustomExercise(name, muscle, opts = {}) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new Error('Exercise name is required.');
  const m = String(muscle == null ? '' : muscle).trim();
  // Cardio is implied by the muscle group as well as by the explicit flag, so
  // an exercise filed under "Cardio" logs as time even if the box was missed.
  const cardio = opts.cardio === true || normText(m) === 'cardio';
  const rec = {
    id: slugify(trimmed),
    name: trimmed,
    muscle: m,
    custom: true,
    bodyweight: cardio ? true : !!opts.bodyweight,
    createdAt: Number.isFinite(opts.now) ? opts.now : Date.now(),
  };
  if (cardio) {
    rec.cardio = true;
    rec.mode = (opts.mode === 'walk' || opts.mode === 'run') ? opts.mode : 'other';
    rec.met = Number.isFinite(opts.met) && opts.met > 0 ? opts.met : 6;
  }
  return rec;
}

/* ------------------------------------------------------------------ */
/* Body weight                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sort by ts asc, drop invalid rows, collapse to one point per calendar day
 * (latest wins — safe because the array is already sorted ascending).
 */
export function bodyWeightSeries(entries, opts = {}) {
  const valid = [];
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      if (!Number.isFinite(e.ts) || !Number.isFinite(e.kg)) continue;
      valid.push({ ts: e.ts, kg: e.kg });
    }
  }
  valid.sort((a, b) => a.ts - b.ts);

  const perDay = new Map();
  for (const p of valid) perDay.set(dayKeyLocal(p.ts), p); // later ts overwrites
  const points = Array.from(perDay.values()).sort((a, b) => a.ts - b.ts);

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.kg < min) min = p.kg;
    if (p.kg > max) max = p.kg;
  }
  const first = points.length ? points[0] : null;
  const last = points.length ? points[points.length - 1] : null;
  const change = points.length >= 2 ? Math.round((last.kg - first.kg) * 100) / 100 : null;

  return {
    points,
    first,
    last,
    min: points.length ? min : null,
    max: points.length ? max : null,
    change,
  };
}

/* ------------------------------------------------------------------ */
/* Sync merges — UNION, NEVER DELETE                                   */
/* ------------------------------------------------------------------ */

/** Accept a bare array or a {key: [...]} wrapper; anything else → []. */
function arrOf(v, key) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray(v[key])) return v[key];
  return [];
}

/**
 * Union by `ts`; on collision the LOCAL entry wins. Remote is inserted first
 * so local overwrites it. Inputs are never mutated.
 */
export function mergeBodyWeights(local, remote) {
  const byTs = new Map();
  const sources = [arrOf(remote, 'bodyWeights'), arrOf(local, 'bodyWeights')];
  for (const src of sources) {
    for (const e of src) {
      if (!e || typeof e !== 'object' || !Number.isFinite(e.ts)) continue;
      byTs.set(e.ts, { ts: e.ts, kg: e.kg });
    }
  }
  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

/** Union by `id`; local wins collisions; result sorted by name. */
export function mergeCustomExercises(local, remote) {
  const byId = new Map();
  const sources = [arrOf(remote, 'customExercises'), arrOf(local, 'customExercises')];
  for (const src of sources) {
    for (const e of src) {
      if (!e || typeof e !== 'object' || !e.id) continue;
      byId.set(e.id, Object.assign({}, e));
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const c = String(a.name == null ? '' : a.name)
      .localeCompare(String(b.name == null ? '' : b.name), undefined, { sensitivity: 'base' });
    return c !== 0 ? c : String(a.id).localeCompare(String(b.id));
  });
}

/* ------------------------------------------------------------------ */
/* Heatmap                                                             */
/* ------------------------------------------------------------------ */

/**
 * GitHub-style contribution grid as an SVG string.
 *
 * The grid starts at the Monday of the week containing the EARLIEST workout
 * and ends at the week containing endTs, capped at 53 weeks. With no workouts
 * at all it falls back to a short 8-week window rather than 53 empty columns.
 *
 * Bucketing: a day's level comes from total durationSec that day, scaled
 * against the busiest day in the visible range:
 *     level = min(4, 1 + floor(4 * dur / maxDur)), 0 when dur === 0.
 * The host stylesheet maps .hm-l0…​.hm-l4 onto a single-hue LUMINANCE ramp
 * (colourblind-safe); no colours are emitted here.
 */
export function heatmapSVG(workouts, opts = {}) {
  const endTs = Number.isFinite(opts.endTs) ? opts.endTs : Date.now();

  // Aggregate per local calendar day: total duration + set count.
  const perDay = new Map();
  if (Array.isArray(workouts)) {
    for (const w of workouts) {
      if (!w || typeof w !== 'object' || !Number.isFinite(w.startTime)) continue;
      const k = dayKeyLocal(w.startTime);
      let rec = perDay.get(k);
      if (!rec) { rec = { dur: 0, sets: 0 }; perDay.set(k, rec); }
      rec.dur += Number.isFinite(w.durationSec) ? w.durationSec : 0;
      rec.sets += Number.isFinite(w.setCount) ? w.setCount : (Array.isArray(w.sets) ? w.sets.length : 0);
    }
  }

  // Grid geometry: N columns (weeks) x 7 rows (Mon top … Sun bottom),
  // ending on the Sunday of the week containing endTs and starting on the
  // Monday of the week containing the earliest workout (capped at 53 weeks).
  const CELL = 13;
  const GAP = 2;
  const PITCH = CELL + GAP;
  const PAD_L = 34;
  const PAD_T = 20;
  const PAD_R = 6;
  const PAD_B = 6;
  const MAX_COLS = 53;
  const DEFAULT_COLS = 8; // no workouts at all: a short window, not 53 empties
  const ROWS = 7;

  const end = new Date(endTs);
  end.setHours(0, 0, 0, 0);
  const dow = (end.getDay() + 6) % 7; // 0 = Monday
  const endMonday = new Date(end);
  endMonday.setDate(endMonday.getDate() - dow); // Monday of the last column

  // Earliest workout (ignoring anything after endTs, which cannot be shown).
  let firstTs = Infinity;
  if (Array.isArray(workouts)) {
    for (const w of workouts) {
      if (!w || typeof w !== 'object' || !Number.isFinite(w.startTime)) continue;
      if (w.startTime > endTs) continue;
      if (w.startTime < firstTs) firstTs = w.startTime;
    }
  }

  let COLS;
  if (!Number.isFinite(firstTs)) {
    COLS = DEFAULT_COLS;
  } else {
    const fd = new Date(firstTs);
    fd.setHours(0, 0, 0, 0);
    fd.setDate(fd.getDate() - ((fd.getDay() + 6) % 7)); // Monday of that week
    // Round the day difference: DST makes some weeks 167 or 169 hours long.
    const weeks = Math.round((endMonday.getTime() - fd.getTime()) / (7 * 864e5));
    COLS = Math.max(1, Math.min(MAX_COLS, weeks + 1));
  }

  const width = PAD_L + COLS * PITCH - GAP + PAD_R;
  const height = PAD_T + ROWS * PITCH - GAP + PAD_B;

  const start = new Date(endMonday);
  start.setDate(start.getDate() - (COLS - 1) * 7); // Monday of the first column

  // Step with setDate (+1 day) rather than adding ms, so DST shifts cannot
  // skew a cell off its weekday.
  const cells = [];
  const cur = new Date(start);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const ts = cur.getTime();
      const agg = perDay.get(dayKeyLocal(ts));
      cells.push({ ts, c, r, dur: agg ? agg.dur : 0, sets: agg ? agg.sets : 0 });
      cur.setDate(cur.getDate() + 1);
    }
  }

  let maxDur = 0;
  for (const cell of cells) {
    if (cell.ts <= endTs && cell.dur > maxDur) maxDur = cell.dur;
  }
  const levelOf = (dur) => {
    if (dur <= 0 || maxDur <= 0) return 0;
    return Math.min(4, 1 + Math.floor((4 * dur) / maxDur));
  };

  const rangeStr = (ts) => {
    const d = new Date(ts);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
  };
  const hmLabel = 'Workout activity heatmap, ' + COLS + (COLS === 1 ? ' week' : ' weeks')
    + ' from ' + rangeStr(start.getTime()) + ' to ' + rangeStr(endTs);

  const out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(hmLabel) + '">');

  // Month labels: label a column when its Monday begins a new month,
  // suppressing labels that would collide with the previous one.
  let lastLabelX = -Infinity;
  let prevMonth = -1;
  for (let c = 0; c < COLS; c++) {
    const monday = cells[c * ROWS];
    const d = new Date(monday.ts);
    if (d.getMonth() !== prevMonth) {
      prevMonth = d.getMonth();
      const x = PAD_L + c * PITCH;
      if (lastLabelX === -Infinity || x - lastLabelX >= 38) {
        out.push('<text class="hm-ax" x="' + x + '" y="12">' + MONTHS[prevMonth] + '</text>');
        lastLabelX = x;
      }
    }
  }

  // Weekday labels: Mon / Wed / Fri down the left edge.
  for (const r of [0, 2, 4]) {
    const y = PAD_T + r * PITCH + CELL / 2 + 3.5;
    out.push('<text class="hm-ax" x="' + (PAD_L - 6) + '" y="' + y + '" text-anchor="end">' + WDAYS[r] + '</text>');
  }

  for (const cell of cells) {
    if (cell.ts > endTs) continue; // future days in the trailing week stay blank
    const lvl = levelOf(cell.dur);
    const d = new Date(cell.ts);
    const when = WDAYS[cell.r] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
    const summary = cell.dur > 0
      ? Math.round(cell.dur / 60) + ' min · ' + cell.sets + (cell.sets === 1 ? ' set' : ' sets')
      : 'No workout';
    const x = PAD_L + cell.c * PITCH;
    const y = PAD_T + cell.r * PITCH;
    out.push('<rect class="hm-l' + lvl + '" x="' + x + '" y="' + y + '" width="' + CELL + '" height="' + CELL + '" rx="2"><title>' + esc(when + ' — ' + summary) + '</title></rect>');
  }

  out.push('</svg>');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Body-weight line chart                                              */
/* ------------------------------------------------------------------ */

/**
 * Line chart of body weight over time as an SVG string.
 * All colouring is delegated to host CSS classes (.bw-line/.bw-dot/.bw-goal/
 * .bw-ax). The goal line is dashed so it is distinguishable without colour.
 */
export function bodyWeightSVG(entries, opts = {}) {
  const { points } = bodyWeightSeries(entries);
  const unit = opts.unit === 'lbs' ? 'lbs' : 'kg';
  const conv = typeof opts.convert === 'function' ? opts.convert : (x) => x;
  const fmt = (n) => String(Math.round(conv(n) * 10) / 10);

  if (points.length === 0) return '';

  const dateStr = (ts) => {
    const d = new Date(ts);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  };

  // Single measurement: small badge-style SVG.
  if (points.length === 1) {
    const p = points[0];
    const label = 'Body weight on ' + dateStr(p.ts) + ': ' + fmt(p.kg) + ' ' + unit;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="64" viewBox="0 0 220 64" role="img" aria-label="' + esc(label) + '">'
      + '<circle class="bw-dot" cx="26" cy="32" r="5"></circle>'
      + '<text class="bw-ax" x="44" y="37">' + esc(fmt(p.kg) + ' ' + unit) + '</text>'
      + '</svg>';
  }

  // Responsive: the SVG scales to its container via width="100%" + viewBox.
  // The viewBox width defaults to something that fits a 375px phone without
  // horizontal scrolling; callers may override with opts.width.
  const W = Number.isFinite(opts.width) && opts.width > 120 ? Math.round(opts.width) : 343;
  const H = 236;
  const PL = 40;
  const PR = 12;
  const PT = 26; // room for the value label above the highest dot
  const PB = 52; // room for rotated date labels

  let rawLo = Infinity;
  let rawHi = -Infinity;
  for (const p of points) {
    if (p.kg < rawLo) rawLo = p.kg;
    if (p.kg > rawHi) rawHi = p.kg;
  }
  const goal = Number.isFinite(opts.goalKg) ? opts.goalKg : null;
  if (goal != null) {
    if (goal < rawLo) rawLo = goal;
    if (goal > rawHi) rawHi = goal;
  }
  const span = rawHi - rawLo || 1;
  const lo = rawLo - span * 0.08;
  const hi = rawHi + span * 0.08;

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const n = points.length;

  // CATEGORICAL x: every reading is equidistant, whatever the date gaps, so a
  // fortnight's break never squashes a run of daily weigh-ins into one blob.
  const plotW = W - PL - PR;
  const gapX = n > 1 ? plotW / (n - 1) : 0;
  const xOf = (i) => PL + i * gapX;
  const yOf = (kg) => PT + (1 - (kg - lo) / (hi - lo)) * (H - PT - PB);
  const r1 = (v) => Math.round(v * 10) / 10;

  // Short axis dates: "12 Mar" normally, "12 Mar 26" when the series spans
  // more than one calendar year and the year is therefore load-bearing.
  const multiYear = new Date(t0).getFullYear() !== new Date(t1).getFullYear();
  const shortDate = (ts) => {
    const d = new Date(ts);
    return d.getDate() + ' ' + MONTHS[d.getMonth()]
      + (multiYear ? ' ' + String(d.getFullYear() % 100).padStart(2, '0') : '');
  };

  // Rough advance width at font-size 9px; only used to decide how many labels
  // fit, so an approximation is fine and keeps this DOM-free.
  const textW = (s) => s.length * 5.2;

  // Greedy label picker: `must` indices always survive; the rest are added in
  // order only where their box clears everything already placed by `minGap`.
  const pick = (must, minGap, widthOf) => {
    const chosen = [];
    const clears = (i) => chosen.every((j) =>
      Math.abs(xOf(i) - xOf(j)) >= (widthOf(i) + widthOf(j)) / 2 + minGap);
    const uniq = Array.from(new Set(must)).filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
    for (const i of uniq) chosen.push(i);
    for (let i = 0; i < n; i++) {
      if (chosen.indexOf(i) !== -1) continue;
      if (clears(i)) chosen.push(i);
    }
    return chosen.sort((a, b) => a - b);
  };

  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 1; i < n; i++) {
    if (points[i].kg < points[minIdx].kg) minIdx = i;
    if (points[i].kg > points[maxIdx].kg) maxIdx = i;
  }

  const valTxt = (i) => fmt(points[i].kg);
  const dateTxt = (i) => shortDate(points[i].ts);

  // First, last, min and max are always labelled; everything else fills in
  // wherever it does not collide.
  const valIdx = pick([0, n - 1, minIdx, maxIdx], 4, (i) => textW(valTxt(i)));
  // Dates render rotated -38°, so their horizontal footprint is ~cos(38°).
  const dateIdx = pick([0, n - 1], 4, (i) => textW(dateTxt(i)) * 0.79);

  const ptsAttr = points.map((p, i) => r1(xOf(i)) + ',' + r1(yOf(p.kg))).join(' ');

  const ariaLabel = 'Body weight line chart: ' + n + ' measurements, equally spaced, from '
    + dateStr(t0) + ' (' + fmt(points[0].kg) + ' ' + unit + ') to '
    + dateStr(t1) + ' (' + fmt(points[n - 1].kg) + ' ' + unit + ')'
    + (goal != null ? ', goal ' + fmt(goal) + ' ' + unit : '');

  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(ariaLabel) + '">');

  // Baseline
  parts.push('<line class="bw-ax" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '"></line>');

  // Y axis: min and max data values
  parts.push('<text class="bw-ax" x="' + (PL - 6) + '" y="' + r1(yOf(rawHi) + 4) + '" text-anchor="end">' + esc(fmt(rawHi)) + '</text>');
  parts.push('<text class="bw-ax" x="' + (PL - 6) + '" y="' + r1(yOf(rawLo) + 4) + '" text-anchor="end">' + esc(fmt(rawLo)) + '</text>');
  parts.push('<text class="bw-ax" x="' + (PL - 6) + '" y="' + (PT - 14) + '" text-anchor="end">' + esc(unit) + '</text>');

  // Goal line — dashed so it reads as "target", not data, without colour.
  if (goal != null) {
    const gy = r1(yOf(goal));
    parts.push('<line class="bw-goal" x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke-dasharray="7 5"></line>');
    parts.push('<text class="bw-goal-lbl" x="' + (W - PR) + '" y="' + r1(gy - 5) + '" text-anchor="end">' + esc('Goal ' + fmt(goal) + ' ' + unit) + '</text>');
  }

  parts.push('<polyline class="bw-line" fill="none" points="' + ptsAttr + '"></polyline>');
  for (let i = 0; i < n; i++) {
    const p = points[i];
    parts.push('<circle class="bw-dot" cx="' + r1(xOf(i)) + '" cy="' + r1(yOf(p.kg)) + '" r="2.5"><title>' + esc(dateStr(p.ts) + ' — ' + fmt(p.kg) + ' ' + unit) + '</title></circle>');
  }

  // Exact value beside every labelled point. Sits above the dot, and flips
  // below when the dot is close to the top edge.
  for (const i of valIdx) {
    const txt = valTxt(i);
    const half = textW(txt) / 2;
    let x = xOf(i);
    let anchor = 'middle';
    if (x - half < PL) { x = PL; anchor = 'start'; }
    else if (x + half > W - 2) { x = W - 2; anchor = 'end'; }
    const dotY = yOf(points[i].kg);
    const y = dotY - 8 < 9 ? dotY + 14 : dotY - 8;
    parts.push('<text class="bw-val" x="' + r1(x) + '" y="' + r1(y) + '" text-anchor="' + anchor + '">' + esc(txt) + '</text>');
  }

  // Dates on the x axis, rotated so they stay legible at phone width.
  const dy = H - PB + 12;
  for (const i of dateIdx) {
    const x = r1(xOf(i));
    parts.push('<text class="bw-ax" x="' + x + '" y="' + dy + '" text-anchor="end" transform="rotate(-38 ' + x + ' ' + dy + ')">' + esc(dateTxt(i)) + '</text>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}


/* ------------------------------------------------------------------ */
/* Cardio                                                              */
/* ------------------------------------------------------------------ */
/*
 * Cardio is modelled as an exercise like any other, so it flows through the
 * picker, templates, history, sync and export untouched. What differs is the
 * SET: a cardio set carries durationSec / speedKmh / inclinePct / kcal instead
 * of weightKg / reps, and contributes zero to training volume.
 *
 * `mode` decides which fields are worth asking for:
 *   'walk' / 'run' — treadmill-shaped: speed and incline both meaningful, and
 *                    calories can be derived from the ACSM equations.
 *   'other'        — machine or activity with a flat MET estimate only.
 */

export const CARDIO_EXERCISES = [
  { id: 'cardio-incline-walk',   name: 'Incline Walking',   mode: 'walk',  met: 4.3 },
  { id: 'cardio-walk',           name: 'Walking',           mode: 'walk',  met: 3.5 },
  { id: 'cardio-treadmill-run',  name: 'Treadmill Running', mode: 'run',   met: 9.8 },
  { id: 'cardio-outdoor-run',    name: 'Outdoor Run',       mode: 'run',   met: 9.8 },
  { id: 'cardio-stair-climber',  name: 'Stair Climber',     mode: 'other', met: 9.0 },
  { id: 'cardio-cycling',        name: 'Cycling',           mode: 'other', met: 7.5 },
  { id: 'cardio-stationary-bike',name: 'Stationary Bike',   mode: 'other', met: 6.8 },
  { id: 'cardio-elliptical',     name: 'Elliptical',        mode: 'other', met: 5.0 },
  { id: 'cardio-rowing',         name: 'Rowing Machine',    mode: 'other', met: 7.0 },
  { id: 'cardio-jump-rope',      name: 'Jump Rope',         mode: 'other', met: 11.0 },
  { id: 'cardio-swimming',       name: 'Swimming',          mode: 'other', met: 7.0 },
  { id: 'cardio-hiit',           name: 'HIIT / Conditioning',mode: 'other', met: 8.0 }
].map(function (c) {
  return {
    id: c.id, name: c.name, muscle: 'Cardio', cardio: true,
    mode: c.mode, met: c.met, bodyweight: true, video: null
  };
});

/** True for anything that should be logged as time rather than weight x reps. */
export function isCardio(ex) {
  if (!ex || typeof ex !== 'object') return false;
  if (ex.cardio === true) return true;
  return normText(ex.muscle) === 'cardio';
}

/** 'walk' | 'run' | 'other'. Unknown/absent modes fall back to 'other'. */
export function cardioMode(ex) {
  if (!ex || typeof ex !== 'object') return 'other';
  const m = normText(ex.mode);
  return (m === 'walk' || m === 'run') ? m : 'other';
}

function fin(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

/**
 * Approximate energy cost of one cardio set, in kcal.
 *
 * Treadmill-shaped work uses the ACSM metabolic equations, which take grade
 * into account — that is the whole point for incline walking, where the
 * incline does most of the work and a flat MET number would badly understate
 * it. Everything else falls back to a MET estimate.
 *
 *   walking VO2 (ml/kg/min) = 0.1*S + 1.8*S*G + 3.5      (S in m/min, G as a fraction)
 *   running VO2             = 0.2*S + 0.9*S*G + 3.5
 *   kcal/min                = VO2 * bodyKg / 1000 * 5
 *
 * The ACSM walking equation is validated for roughly 3–6 km/h and the running
 * one from about 8 km/h, so a speed outside its band is routed to the other
 * equation rather than extrapolated. Returns null when there is not enough
 * input to say anything honest — never a made-up number.
 */
export function estimateKcal(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const durationSec = fin(o.durationSec);
  if (durationSec == null || durationSec <= 0) return null;
  const minutes = durationSec / 60;

  const bodyKg = fin(o.bodyKg);
  const kg = (bodyKg != null && bodyKg > 20 && bodyKg < 400) ? bodyKg : 75; // documented fallback

  const speed = fin(o.speedKmh);
  const mode = (o.mode === 'walk' || o.mode === 'run') ? o.mode : 'other';

  if (mode !== 'other' && speed != null && speed > 0) {
    const S = speed * (1000 / 60);                 // km/h -> m/min
    const grade = Math.max(0, Math.min(0.4, (fin(o.inclinePct) || 0) / 100));
    // Below ~7 km/h the walking equation is the right one whatever the exercise
    // is called, and above it the running one is. Picking by speed rather than
    // by label keeps a "run" logged as a 5 km/h uphill trudge honest.
    const walking = speed < 7;
    const vo2 = walking ? (0.1 * S + 1.8 * S * grade + 3.5)
                        : (0.2 * S + 0.9 * S * grade + 3.5);
    const kcal = vo2 * kg / 1000 * 5 * minutes;
    return Math.round(kcal);
  }

  const met = fin(o.met);
  if (met == null || met <= 0) return null;
  // MET definition: 1 MET = 3.5 ml/kg/min of O2 = ~1 kcal/kg/hour.
  return Math.round(met * kg * (minutes / 60));
}

/** Latest body weight in kg from the weights log, or null if there is none. */
export function latestBodyKg(entries) {
  if (!Array.isArray(entries)) return null;
  let best = null;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const ts = fin(e.ts), kg = fin(e.kg);
    if (ts == null || kg == null || kg <= 0) continue;
    if (best == null || ts > best.ts) best = { ts, kg };
  }
  return best ? best.kg : null;
}

/** "32:00 · 5.5 km/h · 12% · 245 kcal" — omits whatever is missing. */
export function fmtCardio(s) {
  if (!s || typeof s !== 'object') return '';
  const bits = [];
  const d = fin(s.durationSec);
  if (d != null && d > 0) {
    const m = Math.floor(d / 60), sec = Math.round(d % 60);
    bits.push(m + ':' + String(sec).padStart(2, '0'));
  }
  const sp = fin(s.speedKmh);
  if (sp != null && sp > 0) bits.push(sp + ' km/h');
  const inc = fin(s.inclinePct);
  if (inc != null && inc > 0) bits.push(inc + '%');
  const k = fin(s.kcal);
  if (k != null && k > 0) bits.push(k + ' kcal');
  return bits.join(' \u00b7 ');
}

/** Total kcal across a workout's sets (0 when it has no cardio). */
export function workoutKcal(sets) {
  if (!Array.isArray(sets)) return 0;
  let t = 0;
  for (const s of sets) {
    const k = s && typeof s === 'object' ? fin(s.kcal) : null;
    if (k != null && k > 0) t += k;
  }
  return Math.round(t);
}

/* ------------------------------------------------------------------ */
/* Drop sets                                                           */
/* ------------------------------------------------------------------ */
/*
 * A drop set is ONE set taken to failure, then immediately repeated at a lower
 * weight without rest, as many times as the lifter wants. It is not a superset
 * -- a superset alternates two different exercises, which this app already
 * models with `exercise.superset`. Keeping the two words apart matters: they
 * are different things and both exist here.
 *
 * Shape: the set's own weightKg/reps are the FIRST segment, and `drops` holds
 * the ones after it:
 *
 *   { weightKg: 60, reps: 8, drops: [ {weightKg: 45, reps: 6, done: true},
 *                                     {weightKg: 30, reps: 5, done: true} ] }
 *
 * Additive on purpose. A set without `drops` is byte-identical to what every
 * earlier version wrote, so history, merges, PRs and the Strong import all keep
 * working untouched.
 */

/** The drops on a set, always an array, never null. */
export function dropsOf(set) {
  return (set && typeof set === 'object' && Array.isArray(set.drops)) ? set.drops : [];
}

export function hasDrops(set) {
  return dropsOf(set).length > 0;
}

function numOr0(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : 0;
}

/**
 * Total load moved by one set, INCLUDING every drop segment.
 *
 * The drops are real work and have to count towards volume, otherwise a session
 * built on drop sets reads as lighter than the same session without them --
 * which would be exactly backwards.
 */
export function setVolumeKg(set) {
  if (!set || typeof set !== 'object') return 0;
  let total = numOr0(set.weightKg) * numOr0(set.reps);
  for (const d of dropsOf(set)) {
    if (!d || typeof d !== 'object') continue;
    total += numOr0(d.weightKg) * numOr0(d.reps);
  }
  return total;
}

/**
 * "60 × 8 → 45 × 6 → 30 × 5", or "60 × 8" when there are no drops.
 * `fmt` renders one weight; the caller owns units.
 */
export function fmtSetChain(set, fmt) {
  if (!set || typeof set !== 'object') return '';
  const one = (w, r) => (fmt ? fmt(w) : String(w)) + ' \u00d7 ' + (r == null ? 0 : r);
  const parts = [one(set.weightKg, set.reps)];
  for (const d of dropsOf(set)) {
    if (!d || typeof d !== 'object') continue;
    parts.push(one(d.weightKg, d.reps));
  }
  return parts.join(' \u2192 ');
}

/** Just the drop segments, "45x6;30x5" — compact enough for one CSV cell. */
export function dropsToField(set, fmt) {
  const out = [];
  for (const d of dropsOf(set)) {
    if (!d || typeof d !== 'object') continue;
    out.push((fmt ? fmt(d.weightKg) : String(numOr0(d.weightKg))) + 'x' + numOr0(d.reps));
  }
  return out.join(';');
}
