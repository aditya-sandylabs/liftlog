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
export function buildExerciseIndex({ data, custom, workouts } = {}) {
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

  if (Array.isArray(custom)) {
    for (const c of custom) {
      if (!c || typeof c !== 'object' || !c.id) continue;
      push({
        id: c.id,
        name: c.name,
        muscle: c.muscle != null ? c.muscle : null,
        video: null,
        bodyweight: !!c.bodyweight,
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

export function makeCustomExercise(name, muscle, opts = {}) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new Error('Exercise name is required.');
  return {
    id: slugify(trimmed),
    name: trimmed,
    muscle: String(muscle == null ? '' : muscle).trim(),
    custom: true,
    bodyweight: !!opts.bodyweight,
    createdAt: Number.isFinite(opts.now) ? opts.now : Date.now(),
  };
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
 * GitHub-style contribution grid, last 53 weeks, as an SVG string.
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

  // Grid geometry: 53 columns (weeks) x 7 rows (Mon top … Sun bottom),
  // ending on the Sunday of the week containing endTs.
  const CELL = 13;
  const GAP = 2;
  const PITCH = CELL + GAP;
  const PAD_L = 34;
  const PAD_T = 20;
  const PAD_R = 6;
  const PAD_B = 6;
  const COLS = 53;
  const ROWS = 7;
  const width = PAD_L + COLS * PITCH - GAP + PAD_R;
  const height = PAD_T + ROWS * PITCH - GAP + PAD_B;

  const end = new Date(endTs);
  end.setHours(0, 0, 0, 0);
  const dow = (end.getDay() + 6) % 7; // 0 = Monday
  const start = new Date(end);
  start.setDate(start.getDate() - dow - 52 * 7); // Monday of the first column

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

  const out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Workout activity heatmap for the last 53 weeks">');

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

  const W = 640;
  const H = 240;
  const PL = 52;
  const PR = 18;
  const PT = 18;
  const PB = 30;

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
  const tSpan = t1 - t0 || 1;
  const xOf = (ts) => PL + ((ts - t0) / tSpan) * (W - PL - PR);
  const yOf = (kg) => PT + (1 - (kg - lo) / (hi - lo)) * (H - PT - PB);
  const r1 = (n) => Math.round(n * 10) / 10;

  const ptsAttr = points.map((p) => r1(xOf(p.ts)) + ',' + r1(yOf(p.kg))).join(' ');

  const ariaLabel = 'Body weight line chart: ' + points.length + ' measurements from '
    + dateStr(t0) + ' (' + fmt(points[0].kg) + ' ' + unit + ') to '
    + dateStr(t1) + ' (' + fmt(points[points.length - 1].kg) + ' ' + unit + ')'
    + (goal != null ? ', goal ' + fmt(goal) + ' ' + unit : '');

  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(ariaLabel) + '">');

  // Baseline
  parts.push('<line class="bw-ax" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '"></line>');

  // Y axis: min and max data values
  parts.push('<text class="bw-ax" x="' + (PL - 8) + '" y="' + r1(yOf(rawHi) + 4) + '" text-anchor="end">' + esc(fmt(rawHi) + ' ' + unit) + '</text>');
  parts.push('<text class="bw-ax" x="' + (PL - 8) + '" y="' + r1(yOf(rawLo) + 4) + '" text-anchor="end">' + esc(fmt(rawLo) + ' ' + unit) + '</text>');

  // X axis: first and last dates
  parts.push('<text class="bw-ax" x="' + PL + '" y="' + (H - 8) + '">' + esc(dateStr(t0)) + '</text>');
  parts.push('<text class="bw-ax" x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(dateStr(t1)) + '</text>');

  // Goal line — dashed so it reads as "target", not data, without colour.
  if (goal != null) {
    const gy = r1(yOf(goal));
    parts.push('<line class="bw-goal" x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke-dasharray="7 5"></line>');
    parts.push('<text class="bw-goal" x="' + (W - PR) + '" y="' + r1(gy - 6) + '" text-anchor="end">' + esc('Goal ' + fmt(goal) + ' ' + unit) + '</text>');
  }

  parts.push('<polyline class="bw-line" fill="none" points="' + ptsAttr + '"></polyline>');
  for (const p of points) {
    parts.push('<circle class="bw-dot" cx="' + r1(xOf(p.ts)) + '" cy="' + r1(yOf(p.kg)) + '" r="2.5"><title>' + esc(dateStr(p.ts) + ' — ' + fmt(p.kg) + ' ' + unit) + '</title></circle>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}

