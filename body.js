/*
 * LiftLog — body.js
 *
 * Pure logic module: no DOM, no storage, no network.
 * Body measurements, body-composition scans, progress-photo metadata, and the
 * importer for the fortnightly body-tracking sheet.
 *
 * PRIVACY: that sheet holds another person's health data and does NOT live in
 * this repo. Tests run against build/fixture-tracking-sheet.csv, which is
 * synthetic. Never commit a real export, and never paste real measurements into
 * a test, a comment or a doc -- see the 2026-09-11 block in HANDOFF.md.
 *
 * ── The one integration hazard in this file ──────────────────────────────
 *
 * The tracking sheet has a `Weight` row, and the app ALREADY has a body-weight
 * series (`state.weights`, merged by `mergeBodyWeights`, one entry per day).
 *
 * A second weight series would be a silent disaster: two charts disagreeing,
 * two "latest weight" values, and cardio kcal estimates reading whichever one
 * the code happened to reach for.
 *
 * So weight is NOT stored on a measurement record. `parseTrackingSheet()`
 * returns it in a SEPARATE `weights` array for the host to feed through the
 * existing `mergeBodyWeights` path. `FIELDS` deliberately contains no weight
 * entry. If you are ever tempted to add one, don't — read this note again.
 *
 * ── Tombstones ───────────────────────────────────────────────────────────
 *
 * Same rule as nutrition.js: deleting sets `deleted: true` and keeps the
 * record, so a delete propagates across devices instead of resurrecting. The
 * merge remains strictly append-only.
 */

const DAY_MS = 86400000;

function num(v, dflt = null) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

function r2(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function startOfDayTs(ts) {
  const d = new Date(num(ts, Date.now()));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function arrOf(v, key) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray(v[key])) return v[key];
  return [];
}

export function bodyUid(prefix) {
  return (prefix || 'b') + '-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ */
/* Field definitions                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every tracked field, in display order.
 *
 *   kind 'tape'  measured by hand with a tape measure, entered occasionally
 *   kind 'scan'  reported by a bioimpedance scale, all captured in one go
 *
 * `sheet` lists the row labels the importer ACCEPTS for this field, matched
 * case- and whitespace-insensitively. Aliases live here rather than in the
 * parser so adding a field is a one-line change in one place.
 *
 * `csv` is the single label the exporter WRITES. It is deliberately the wording
 * the hand-kept spreadsheet used, so the file the app generates is
 * indistinguishable from the one it replaces. Every `csv` value must normalise
 * to one of that field's own `sheet` aliases, or the file stops round-tripping
 * -- test_body.mjs asserts exactly that, so a mismatch fails the build rather
 * than producing a Drive file that quietly cannot be read back.
 *
 * Scan values are stored EXACTLY as the scale reports them and are never
 * recomputed, even where they are arithmetically derivable (fat mass = weight
 * x body-fat%). The scale's own model is what makes the series comparable
 * over time; recomputing from a differently-derived weight would produce a
 * number that silently disagrees with every previous reading.
 */
export const FIELDS = [
  // Tape measurements, cm.
  { key: 'neck',       label: 'Neck',            unit: 'cm', kind: 'tape', dp: 1, csv: 'Neck', sheet: ['neck'] },
  { key: 'chest',      label: 'Chest',           unit: 'cm', kind: 'tape', dp: 1, csv: 'Chest', sheet: ['chest'] },
  { key: 'waist',      label: 'Waist',           unit: 'cm', kind: 'tape', dp: 1, csv: 'Waist', sheet: ['waist'] },
  { key: 'hip',        label: 'Hip',             unit: 'cm', kind: 'tape', dp: 1, csv: 'Hip', sheet: ['hip', 'hips'] },
  { key: 'thighR',     label: 'Thigh (R)',       unit: 'cm', kind: 'tape', dp: 1, csv: 'Thigh Right', sheet: ['thigh right', 'thigh (r)', 'right thigh'] },
  { key: 'armR',       label: 'Upper arm (R)',   unit: 'cm', kind: 'tape', dp: 1, csv: 'Upper Arm Right', sheet: ['upper arm right', 'upper arm (r)', 'right upper arm'] },
  { key: 'armRFlexed', label: 'Upper arm (R) flexed', unit: 'cm', kind: 'tape', dp: 1, csv: 'Upper Arm (R) Flexed', sheet: ['upper arm (r) flexed', 'upper arm right flexed', 'flexed arm'] },

  // Bioimpedance scale outputs.
  { key: 'bmi',        label: 'BMI',             unit: '',   kind: 'scan', dp: 1, csv: 'BMI', sheet: ['bmi'] },
  { key: 'bodyFatPct', label: 'Body fat',        unit: '%',  kind: 'scan', dp: 2, pct: true, csv: 'Body Fat %', sheet: ['body fat %', 'body fat', 'bodyfat %'] },
  { key: 'muscleRatePct', label: 'Muscle rate',  unit: '%',  kind: 'scan', dp: 2, pct: true, csv: 'Muscle Rate %', sheet: ['muscle rate %', 'muscle rate'] },
  { key: 'waterPct',   label: 'Body water',      unit: '%',  kind: 'scan', dp: 2, pct: true, csv: 'Body Water %', sheet: ['body water %', 'body water'] },
  { key: 'visceralFatPct', label: 'Visceral fat', unit: '%', kind: 'scan', dp: 2, pct: true, csv: 'Visceral fat %', sheet: ['visceral fat %', 'visceral fat'] },
  { key: 'subcutFatPct', label: 'Subcutaneous fat', unit: '%', kind: 'scan', dp: 2, pct: true, csv: 'Subcutaneous Fat %', sheet: ['subcutaneous fat %', 'subcutaneous fat'] },
  { key: 'fatMassKg',  label: 'Fat mass',        unit: 'kg', kind: 'scan', dp: 2, csv: 'Fat Mass', sheet: ['fat mass'] },
  { key: 'muscleMassKg', label: 'Muscle mass',   unit: 'kg', kind: 'scan', dp: 2, csv: 'Muscle Mass KG', sheet: ['muscle mass kg', 'muscle mass'] },
  { key: 'skeletalMuscleKg', label: 'Skeletal muscle', unit: 'kg', kind: 'scan', dp: 2, csv: 'Skeletal Muscle Mass', sheet: ['skeletal muscle mass', 'skeletal muscle'] },
  { key: 'leanMassKg', label: 'Weight w/o fat',  unit: 'kg', kind: 'scan', dp: 2, csv: 'Weight W/O Fat', sheet: ['weight w/o fat', 'weight without fat', 'lean mass'] },
  { key: 'waterKg',    label: 'Water weight',    unit: 'kg', kind: 'scan', dp: 2, csv: 'Water Weight', sheet: ['water weight'] },
  { key: 'proteinKg',  label: 'Protein mass',    unit: 'kg', kind: 'scan', dp: 2, csv: 'Protein Mass KG', sheet: ['protein mass kg', 'protein mass'] },
  { key: 'boneKg',     label: 'Bone mass',       unit: 'kg', kind: 'scan', dp: 2, csv: 'Bone Mass KG', sheet: ['bone mass kg', 'bone mass'] },
  { key: 'bmr',        label: 'BMR',             unit: 'kcal', kind: 'scan', dp: 0, csv: 'BMR', sheet: ['bmr'] },
  { key: 'metabolicAge', label: 'Metabolic age', unit: 'yr', kind: 'scan', dp: 0, csv: 'Metabolic Age', sheet: ['metabolic age'] },
  { key: 'bodyScore',  label: 'Body score',      unit: '',   kind: 'scan', dp: 0, csv: 'Body Score', sheet: ['body score'] },
  { key: 'obesityLevel', label: 'Obesity level', unit: '',   kind: 'scan', text: true, csv: 'Obesity Level', sheet: ['obesity level'] }
];

export const FIELD_BY_KEY = FIELDS.reduce((m, f) => { m[f.key] = f; return m; }, {});

export function fieldsOfKind(kind) {
  return FIELDS.filter(f => f.kind === kind);
}

/** Progress-photo poses. Mirrors the sheet's three photo rows. */
export const POSES = [
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
  { id: 'rear', label: 'Rear' }
];

export function poseLabel(id) {
  const p = POSES.find(x => x.id === id);
  return p ? p.label : String(id || '');
}

/** Format a value for display using its field's precision and unit. */
export function fmtField(key, value, opts = {}) {
  const f = FIELD_BY_KEY[key];
  if (value == null || value === '') return '—';
  if (f && f.text) return String(value);
  const n = num(value);
  if (n == null) return '—';
  const dp = f ? (f.dp == null ? 1 : f.dp) : 1;
  const s = n.toFixed(dp);
  if (opts.bare) return s;
  const unit = f ? f.unit : '';
  return unit === '%' ? s + '%' : (unit ? s + ' ' + unit : s);
}

/* ------------------------------------------------------------------ */
/* Measurement records                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build a measurement record. Unknown keys and blank values are dropped, so a
 * partially-filled form produces a record holding only what was measured
 * rather than a wall of nulls.
 */
export function makeMeasurement(fields, opts = {}) {
  const ts = num(opts.ts, Date.now());
  const src = fields || {};
  const out = {};
  /* Iterate FIELDS, not the input's own keys, so `fields` is always in the same
     canonical order no matter how the record was built -- typed into the form,
     parsed from a sheet, or read back from an export.
     This is not cosmetic. backgroundSync() and the JSON import both decide
     "did this change?" with JSON.stringify, and key order changes that string.
     Without this, a record that round-tripped through the sheet would compare
     as modified against the identical record already stored, and every sync
     would rewrite and re-upload it forever. */
  for (const f of FIELDS) {
    const k = f.key;
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = src[k];
    if (v == null || v === '') continue;
    if (f.text) {
      const s = String(v).trim();
      if (s) out[k] = s;
    } else {
      const n = num(v);
      if (n != null) out[k] = r2(n);
    }
  }
  return {
    id: opts.id || bodyUid('m'),
    ts,
    day: startOfDayTs(ts),
    fields: out,
    note: opts.note ? String(opts.note) : null
  };
}

export function tombstone(rec, opts = {}) {
  if (!rec || !rec.id) return rec;
  return { id: rec.id, deleted: true, ts: num(opts.ts, Date.now()) };
}

export function liveOnly(list) {
  return (Array.isArray(list) ? list : []).filter(r => r && r.id && !r.deleted);
}

/** True when a record carries no actual measurements. */
export function isEmptyMeasurement(rec) {
  return !rec || !rec.fields || Object.keys(rec.fields).length === 0;
}

/**
 * One measurement record per calendar day, newest wins.
 *
 * Losers are TOMBSTONED rather than dropped: if a same-day duplicate arrived
 * from another device, silently discarding it locally would let the next sync
 * pull it straight back and the collapse would never converge.
 */
export function collapseByDay(records) {
  const all = Array.isArray(records) ? records.slice() : [];
  const live = liveOnly(all);
  const best = new Map();
  for (const r of live) {
    const d = startOfDayTs(r.day != null ? r.day : r.ts);
    const cur = best.get(d);
    if (!cur || num(r.ts, 0) >= num(cur.ts, 0)) best.set(d, r);
  }
  const keep = new Set(Array.from(best.values()).map(r => r.id));
  const out = [];
  for (const r of all) {
    if (!r || !r.id) continue;
    if (r.deleted) { out.push(r); continue; }
    out.push(keep.has(r.id) ? r : { id: r.id, deleted: true, ts: num(r.ts, Date.now()) });
  }
  return out.sort((a, b) => num(a.ts, 0) - num(b.ts, 0));
}

/** Live measurements, oldest first. */
export function measurementSeries(records) {
  return liveOnly(arrOf(records, 'measurements'))
    .filter(r => !isEmptyMeasurement(r))
    .sort((a, b) => num(a.ts, 0) - num(b.ts, 0));
}

/**
 * The series for ONE field: [{ts, value}], oldest first, plus first/last and
 * the change between them. Records missing that field are skipped, not zeroed.
 */
export function fieldSeries(records, key) {
  const f = FIELD_BY_KEY[key];
  const pts = [];
  for (const r of measurementSeries(records)) {
    const v = r.fields ? r.fields[key] : undefined;
    if (v == null || v === '') continue;
    if (f && f.text) { pts.push({ ts: num(r.ts), value: String(v) }); continue; }
    const n = num(v);
    if (n != null) pts.push({ ts: num(r.ts), value: n });
  }
  const first = pts.length ? pts[0] : null;
  const last = pts.length ? pts[pts.length - 1] : null;
  const change = (first && last && !(f && f.text) && pts.length > 1)
    ? Math.round((last.value - first.value) * 100) / 100
    : null;
  return { key, points: pts, first, last, change };
}

/** Latest recorded value of one field, or null. */
export function latestField(records, key) {
  const s = fieldSeries(records, key);
  return s.last ? s.last.value : null;
}

/** Which fields have ever been recorded — drives what the UI bothers showing. */
export function usedFields(records) {
  const seen = new Set();
  for (const r of measurementSeries(records)) {
    for (const k of Object.keys(r.fields || {})) if (FIELD_BY_KEY[k]) seen.add(k);
  }
  return FIELDS.filter(f => seen.has(f.key)).map(f => f.key);
}

/* ------------------------------------------------------------------ */
/* Progress photos                                                     */
/* ------------------------------------------------------------------ */

/**
 * Photo METADATA only — the image bytes live in their own IndexedDB store and
 * are uploaded to Drive as individual files.
 *
 * This split is the whole reason photos are affordable here. The Drive backup
 * is one JSON blob rewritten in full after every workout; a base64 image
 * inside it would be re-uploaded on every single sync. Instead the blob
 * carries only `driveId`, and each image moves exactly once.
 */
export function makePhotoMeta(opts = {}) {
  const ts = num(opts.ts, Date.now());
  return {
    id: opts.id || bodyUid('p'),
    ts,
    day: startOfDayTs(ts),
    pose: POSES.some(p => p.id === opts.pose) ? opts.pose : 'front',
    w: num(opts.w, null),
    h: num(opts.h, null),
    bytes: num(opts.bytes, null),
    type: opts.type ? String(opts.type) : 'image/jpeg',
    weightKg: num(opts.weightKg, null),   // what you weighed that day, for the caption
    driveId: opts.driveId ? String(opts.driveId) : null,
    note: opts.note ? String(opts.note) : null
  };
}

/** Live photos newest first. */
export function photoList(metas, opts = {}) {
  let list = liveOnly(arrOf(metas, 'photos'));
  if (opts.pose) list = list.filter(p => p.pose === opts.pose);
  return list.sort((a, b) => num(b.ts, 0) - num(a.ts, 0));
}

/** Photos grouped by day, newest day first, each day's poses in POSES order. */
export function photosByDay(metas) {
  const byDay = new Map();
  for (const p of photoList(metas)) {
    const d = startOfDayTs(p.day != null ? p.day : p.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  const order = POSES.map(p => p.id);
  return Array.from(byDay.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([day, items]) => ({
      day,
      items: items.sort((a, b) => order.indexOf(a.pose) - order.indexOf(b.pose))
    }));
}

/**
 * The two photos worth putting side by side for one pose: earliest and latest.
 * Returns null when there is only one, because a comparison needs two.
 */
export function comparePair(metas, pose) {
  const list = photoList(metas, { pose }).slice().sort((a, b) => num(a.ts, 0) - num(b.ts, 0));
  if (list.length < 2) return null;
  return { before: list[0], after: list[list.length - 1] };
}

/**
 * Photos whose Drive upload has not happened yet.
 * The host walks this list when a sync runs; until an id lands, the image
 * exists only on this device.
 */
export function photosNeedingUpload(metas) {
  return liveOnly(arrOf(metas, 'photos')).filter(p => !p.driveId);
}

/**
 * Drive files that are safe to delete: referenced only by tombstoned photos.
 * Deliberately conservative — a driveId still claimed by any live record is
 * never returned, so a merge that resurrects nothing can still not orphan a
 * live image.
 */
export function orphanDriveIds(metas) {
  const all = arrOf(metas, 'photos');
  const live = new Set();
  for (const p of all) if (p && !p.deleted && p.driveId) live.add(p.driveId);
  const out = [];
  for (const p of all) {
    if (p && p.deleted && p.driveId && !live.has(p.driveId) && out.indexOf(p.driveId) < 0) {
      out.push(p.driveId);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Merges — union + tombstone                                          */
/* ------------------------------------------------------------------ */

function mergeById(local, remote, key) {
  const byId = new Map();
  const take = (rec, isLocal) => {
    if (!rec || typeof rec !== 'object' || !rec.id) return;
    const prev = byId.get(rec.id);
    if (!prev) { byId.set(rec.id, Object.assign({}, rec)); return; }
    if (prev.deleted && !rec.deleted) return;
    if (!prev.deleted && rec.deleted) { byId.set(rec.id, Object.assign({}, rec)); return; }
    const pt = num(prev.ts, 0), rt = num(rec.ts, 0);
    if (rt > pt || (rt === pt && isLocal)) byId.set(rec.id, Object.assign({}, rec));
  };
  for (const r of arrOf(remote, key)) take(r, false);
  for (const l of arrOf(local, key)) take(l, true);
  return Array.from(byId.values());
}

export function mergeMeasurements(local, remote) {
  return mergeById(local, remote, 'measurements').sort((a, b) => num(a.ts, 0) - num(b.ts, 0));
}

/**
 * Photo metadata union. One extra rule beyond the usual: a `driveId` is never
 * lost. If either side knows where the image was uploaded and the winner does
 * not, the id is carried across — otherwise a metadata edit on a device that
 * had not yet synced would strand the uploaded file and the photo would look
 * un-backed-up forever.
 */
export function mergePhotos(local, remote) {
  const merged = mergeById(local, remote, 'photos');
  const knownDrive = new Map();
  for (const src of [arrOf(remote, 'photos'), arrOf(local, 'photos')]) {
    for (const p of src) if (p && p.id && p.driveId) knownDrive.set(p.id, p.driveId);
  }
  for (const p of merged) {
    if (!p.deleted && !p.driveId && knownDrive.has(p.id)) p.driveId = knownDrive.get(p.id);
  }
  return merged.sort((a, b) => num(a.ts, 0) - num(b.ts, 0));
}

/* ------------------------------------------------------------------ */
/* Tracking-sheet import                                               */
/* ------------------------------------------------------------------ */

/**
 * Which delimiter is this table using?
 *
 * A file exported as CSV is comma-separated. Text COPIED out of Google Sheets or
 * Excel and pasted in is TAB-separated — and pasting is by far the easiest way to
 * get a sheet off a phone, so it has to work. Decided per-table on the header
 * row, not per-line, because a single row of a comma file can legitimately
 * contain a tab and vice versa.
 */
export function detectDelimiter(text) {
  const firstLine = String(text == null ? '' : text).split(/\r?\n/, 1)[0] || '';
  // Count only OUTSIDE quotes: "Smith, John" is one cell, not a vote for commas.
  let tabs = 0, commas = 0, q = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') { q = !q; continue; }
    if (q) continue;
    if (ch === '\t') tabs++;
    else if (ch === ',') commas++;
  }
  return tabs > commas ? '\t' : ',';
}

/**
 * RFC4180-ish table split: handles quotes, embedded delimiters/newlines, CRLF.
 * `delimiter` defaults to auto-detection, so the same function reads a CSV file
 * and a paste out of a spreadsheet.
 */
export function parseCsv(text, delimiter) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(s);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch === '\r') { /* CRLF and lone CR both handled by ignoring CR */ }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse a column header into a timestamp. The sheet writes "1 Jul 2026";
 * "01/07/2026" and ISO are accepted too.
 *
 * Day-first is assumed for slash dates, because the sheet is day-first and a
 * silent US reading would move every entry to the wrong day for half the year.
 */
export function parseSheetDate(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;

  let m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    return new Date(+m[3], mi, +m[1], 12, 0, 0, 0).getTime();
  }
  m = t.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    return new Date(+m[3], mi, +m[2], 12, 0, 0, 0).getTime();
  }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0).getTime();
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0).getTime();
  return null;
}

/** "20.00%" -> 20 ; "1,700" -> 1700 ; "" -> null ; "OWT" -> null (numeric ctx). */
function parseCell(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  const pct = /%\s*$/.test(t);
  const n = num(t.replace(/[%\s]/g, '').replace(/,/g, ''));
  if (n == null) return null;
  return { value: n, pct };
}

function normLabel(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

const SHEET_LOOKUP = (() => {
  const m = new Map();
  for (const f of FIELDS) for (const a of (f.sheet || [])) m.set(normLabel(a), f.key);
  return m;
})();

/* Rows the sheet uses for photo slots — recognised so they are not reported
   as unmapped, but they carry no importable data (the images are not in a CSV). */
const PHOTO_ROWS = new Set(['front profile', 'rear profile', 'side profile',
  'front', 'rear', 'side', 'front photo', 'rear photo', 'side photo']);

/* Weight is handled separately and deliberately. See the header note. */
const WEIGHT_ROWS = new Set(['weight', 'body weight', 'weight kg']);

/**
 * Parse the Fitness Tracking Sheet.
 *
 * Shape: WIDE. Row 1 is dates, column 1 is field names, so the table is
 * transposed relative to how records are stored — each COLUMN becomes one
 * measurement.
 *
 * Returns:
 *   measurements  one record per dated column that had any data
 *   weights       [{ts, kg}] from the Weight row — feed these through the
 *                 app's EXISTING body-weight merge, never into measurements
 *   columns       per-column report (date, how many fields found)
 *   unmapped      row labels that matched no field, so a renamed row is
 *                 visible instead of silently dropped
 *   skipped       recognised rows that intentionally carry no data (photos)
 */
export function parseTrackingSheet(text, opts = {}) {
  // opts.delimiter forces one; otherwise a pasted (tab-separated) sheet and a
  // downloaded (comma-separated) file both just work.
  const rows = parseCsv(text, opts.delimiter)
    .filter(r => r && r.some(c => String(c).trim() !== ''));
  if (!rows.length) {
    return { measurements: [], weights: [], columns: [], unmapped: [], skipped: [], error: 'The file is empty.' };
  }

  const header = rows[0];
  const cols = [];
  for (let i = 1; i < header.length; i++) {
    const ts = parseSheetDate(header[i]);
    if (ts != null) cols.push({ index: i, ts, label: String(header[i]).trim() });
  }
  if (!cols.length) {
    return {
      measurements: [], weights: [], columns: [], unmapped: [], skipped: [],
      error: 'No dates found in the first row. Expected columns like "1 Jul 2026".'
    };
  }

  const perCol = new Map(cols.map(c => [c.index, {}]));
  const weightsByCol = new Map();
  const unmapped = [];
  const skipped = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const label = normLabel(row[0]);
    if (!label) continue;

    if (PHOTO_ROWS.has(label)) { skipped.push(String(row[0]).trim()); continue; }

    if (WEIGHT_ROWS.has(label)) {
      for (const c of cols) {
        const p = parseCell(row[c.index]);
        if (p && p.value > 0) weightsByCol.set(c.index, p.value);
      }
      continue;
    }

    const key = SHEET_LOOKUP.get(label);
    if (!key) { unmapped.push(String(row[0]).trim()); continue; }
    const f = FIELD_BY_KEY[key];

    for (const c of cols) {
      const cell = row[c.index];
      if (f.text) {
        const t = String(cell == null ? '' : cell).trim();
        if (t) perCol.get(c.index)[key] = t;
        continue;
      }
      const p = parseCell(cell);
      if (p == null) continue;
      // A percentage field written as "0.20" rather than "20.00%" would be
      // off by 100x and look plausible. Only trust a bare fraction when the
      // cell was NOT marked with a % sign and is below 1.
      let v = p.value;
      if (f.pct && !p.pct && v > 0 && v < 1) v = v * 100;
      perCol.get(c.index)[key] = v;
    }
  }

  const measurements = [];
  const columns = [];
  for (const c of cols) {
    const fields = perCol.get(c.index) || {};
    const n = Object.keys(fields).length;
    columns.push({ label: c.label, ts: c.ts, fields: n, weight: weightsByCol.get(c.index) || null });
    if (n > 0) {
      measurements.push(makeMeasurement(fields, {
        ts: c.ts,
        id: opts.idFor ? opts.idFor(c.ts) : bodyUid('m'),
        note: opts.note || 'Imported from tracking sheet'
      }));
    }
  }

  const weights = [];
  for (const c of cols) {
    const kg = weightsByCol.get(c.index);
    if (kg != null) weights.push({ ts: c.ts, kg });
  }

  return {
    measurements, weights, columns,
    unmapped: Array.from(new Set(unmapped)),
    skipped: Array.from(new Set(skipped)),
    error: null
  };
}

/* ------------------------------------------------------------------ */
/* Tracking-sheet EXPORT                                               */
/* ------------------------------------------------------------------ */

/* Date format the sheet uses, and the one parseSheetDate reads back. */
const MONTHS_TITLE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sheetDateLabel(ts) {
  const d = new Date(num(ts, Date.now()));
  return d.getDate() + ' ' + MONTHS_TITLE[d.getMonth()] + ' ' + d.getFullYear();
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Render the measurement history back OUT as a tracking sheet.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The app is where measurements are entered; Drive is where they durably live.
 * This is the human-readable half of that: a spreadsheet in visible Drive that
 * is rewritten on every sync, so the sheet never has to be maintained by hand
 * again and there is never a second copy to keep in step.
 *
 * ── Why the layout is WIDE (dates across the top) ────────────────────────
 *
 * Because that is the format `parseTrackingSheet()` reads. Export and import
 * are the same shape, so the file ROUND-TRIPS: edit it in Sheets and paste it
 * back, or restore from it onto a new phone, and nothing is lost. A
 * conventional one-row-per-date layout would read more naturally to a database
 * person and would have to be parsed by a second, separate code path.
 * `test_body.mjs` asserts the round trip.
 *
 * ── Which dates become columns ───────────────────────────────────────────
 *
 * Only dates that have a MEASUREMENT. Body weight is logged daily, so
 * including weight-only dates would add a column a day and make the sheet
 * unreadable within a year. Weight IS emitted for the dates that appear, which
 * is exactly what the hand-kept sheet did. The complete daily weight series
 * lives in the JSON backup, which is the full record; this file is the
 * readable summary.
 */
export function measurementsToSheetCsv(measurements, weights, opts = {}) {
  const recs = measurementSeries(measurements);
  const rows = [];

  if (!recs.length) {
    // A header alone would look like a broken export. Say what happened.
    return 'No measurements recorded yet.\n';
  }

  // Weight for a given day, if one was logged that day.
  const weightByDay = new Map();
  for (const w of (Array.isArray(weights) ? weights : [])) {
    if (!w || !Number.isFinite(num(w.ts)) || !Number.isFinite(num(w.kg))) continue;
    weightByDay.set(startOfDayTs(w.ts), num(w.kg));
  }

  const cols = recs.map(r => ({
    ts: r.ts,
    day: startOfDayTs(r.day != null ? r.day : r.ts),
    fields: r.fields || {}
  }));

  rows.push([''].concat(cols.map(c => sheetDateLabel(c.day))));

  // Photo rows are kept, empty, so the file keeps the shape of the sheet it
  // replaces. The importer recognises and skips them, so they round-trip.
  if (opts.photoRows !== false) {
    for (const p of ['Front Profile', 'Rear Profile', 'Side Profile']) {
      rows.push([p].concat(cols.map(() => '')));
    }
  }

  const emit = (field) => {
    const line = [field.csv || field.label];
    let any = false;
    for (const c of cols) {
      const v = c.fields[field.key];
      if (v == null || v === '') { line.push(''); continue; }
      any = true;
      if (field.text) { line.push(String(v)); continue; }
      const n = num(v);
      if (n == null) { line.push(''); continue; }
      const dp = field.dp == null ? 1 : field.dp;
      line.push(field.pct ? n.toFixed(2) + '%' : n.toFixed(dp));
    }
    // Skip fields nobody has ever recorded rather than emitting a blank row.
    if (any) rows.push(line);
  };

  for (const f of fieldsOfKind('tape')) emit(f);

  // Weight sits between the tape and scale blocks, as it does in the sheet this
  // replaces. It comes from the app's own weight series, NEVER from a
  // measurement record -- see the header note on why weight must not fork.
  const wLine = ['Weight'];
  let anyW = false;
  for (const c of cols) {
    const kg = weightByDay.get(c.day);
    if (kg == null) { wLine.push(''); continue; }
    anyW = true;
    wLine.push(String(Math.round(kg * 100) / 100));
  }
  if (anyW) rows.push(wLine);

  for (const f of fieldsOfKind('scan')) emit(f);

  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

/**
 * One field's history as a line chart.
 * No colour carries meaning: the line is a single stroke, points are marked
 * with shapes, and the host stylesheet supplies a luminance-safe palette.
 */
export function measurementSVG(records, key, opts = {}) {
  const f = FIELD_BY_KEY[key];
  const series = fieldSeries(records, key);
  const W = 320, H = 130, padL = 34, padR = 10, padT = 12, padB = 20;

  if (f && f.text) {
    return '<svg class="ms-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc((f ? f.label : key) + ' is not a numeric field') + '"><text class="ms-empty" x="' +
      (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle">Not charted</text></svg>';
  }

  const pts = series.points;
  if (pts.length < 2) {
    return '<svg class="ms-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc('Not enough ' + (f ? f.label : key) + ' entries to chart') +
      '"><text class="ms-empty" x="' + (W / 2) + '" y="' + (H / 2) +
      '" text-anchor="middle">' +
      (pts.length ? 'Log another to see a trend' : 'No entries yet') + '</text></svg>';
  }

  const xs = pts.map(p => p.ts), ys = pts.map(p => p.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const spanY = maxY - minY;
  minY -= spanY * 0.15; maxY += spanY * 0.15;

  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = t => padL + (maxX === minX ? plotW / 2 : ((t - minX) / (maxX - minX)) * plotW);
  const Y = v => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

  const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.ts).toFixed(1) + ' ' + Y(p.value).toFixed(1)).join(' ');
  const dots = pts.map(p =>
    '<circle class="ms-dot" cx="' + X(p.ts).toFixed(1) + '" cy="' + Y(p.value).toFixed(1) +
    '" r="2.5"><title>' + esc(new Date(p.ts).toDateString() + ' — ' + fmtField(key, p.value)) +
    '</title></circle>').join('');

  const grid = [maxY, minY].map(v =>
    '<line class="ms-grid" x1="' + padL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - padR) +
    '" y2="' + Y(v).toFixed(1) + '"/>').join('');

  const axis =
    '<text class="ms-ax" x="' + (padL - 4) + '" y="' + (Y(pts.reduce((a, b) => a.value > b.value ? a : b).value) + 3).toFixed(1) +
    '" text-anchor="end">' + esc(fmtField(key, Math.max(...ys), { bare: true })) + '</text>' +
    '<text class="ms-ax" x="' + (padL - 4) + '" y="' + (Y(Math.min(...ys)) + 3).toFixed(1) +
    '" text-anchor="end">' + esc(fmtField(key, Math.min(...ys), { bare: true })) + '</text>';

  const fmtD = t => { const d2 = new Date(t); return d2.getDate() + '/' + (d2.getMonth() + 1); };
  const labels =
    '<text class="ms-ax" x="' + padL + '" y="' + (H - 4) + '">' + esc(fmtD(minX)) + '</text>' +
    '<text class="ms-ax" x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(fmtD(maxX)) + '</text>';

  return '<svg class="ms-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
    esc((f ? f.label : key) + ' over time') + '">' +
    grid + '<path class="ms-line" d="' + d + '" fill="none"/>' + dots + axis + labels + '</svg>';
}
