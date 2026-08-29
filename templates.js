/*
 * templates.js - pure logic for user-created workout templates in LiftLog.
 *
 * This module holds no state, imports nothing, and touches no DOM, storage or
 * network. It is plain functions over plain objects, runnable identically in
 * Node and in the browser.
 *
 * Rules every function in here obeys:
 *   - NO MUTATION. No function ever modifies its arguments. Every edit returns
 *     fresh objects and arrays, because the built-in template array comes
 *     straight from data.json and mutating it would corrupt the programme.
 *   - UNION-ONLY SYNC. mergeCustomTemplates can never delete a record: every
 *     id present on either side is present in the output.
 *   - TOTAL TOLERANCE. null, undefined and junk input never throw; a sensible
 *     empty value is returned instead.
 *   - JSON SAFETY. Every returned record contains only JSON-safe values, so it
 *     can be persisted verbatim.
 */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Returns the value only if it is a finite number; otherwise null.
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function optNow(opts) {
  var n = isObj(opts) ? num(opts.now) : null;
  return n === null ? Date.now() : n;
}

// Distinct across calls: millisecond timestamp in base 36 plus a random tail.
function freshId() {
  return 'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Deep copy keeping only JSON-safe values. Undefined properties and functions
// are dropped outright; Dates, Maps and Sets have no JSON form and become null.
function jsonSafe(value) {
  if (value === null) return null;
  var t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) arr.push(jsonSafe(value[i]));
    return arr;
  }
  if (t === 'object') {
    var out = {};
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var v = value[keys[k]];
      if (v === undefined || typeof v === 'function') continue;
      out[keys[k]] = jsonSafe(v);
    }
    return out;
  }
  return null;
}

// Fresh deep copy of a template record, guaranteed to carry an exercises array.
function cloneTemplate(tpl) {
  var next = jsonSafe(isObj(tpl) ? tpl : {});
  if (!Array.isArray(next.exercises)) next.exercises = [];
  return next;
}

// Valid integer index into a list of the given length, or null.
function intIndex(index, len) {
  var i = num(index);
  if (i === null || Math.floor(i) !== i || i < 0 || i >= len) return null;
  return i;
}

// Group logged set rows by exerciseId, preserving first-appearance order and
// gathering non-consecutive rows for the same exercise into one bucket.
function groupRows(rows) {
  var order = [];
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!isObj(row)) continue;
    var key = typeof row.exerciseId === 'string'
      ? row.exerciseId
      : String(row.exerciseId);
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(row);
  }
  return { order: order, groups: groups };
}

// Working-set count for one exercise bucket. Warmup rows do not count, but an
// exercise logged only as warmups still gets one working set - never zero.
function workingCount(rows) {
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (isObj(rows[i]) && !rows[i].isWarmup) n++;
  }
  return n > 0 ? n : 1;
}

// Repscription derived from the logged reps numbers: '12' when min equals max,
// otherwise '<min>-<max>'. Working sets take priority; all rows are the
// fallback when there are no working sets; '8-12' when nothing is numeric.
function deriveReps(rows) {
  var working = [];
  var all = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!isObj(row)) continue;
    var v = num(row.reps);
    if (v === null) continue;
    all.push(v);
    if (!row.isWarmup) working.push(v);
  }
  var pool = working.length > 0 ? working : all;
  if (pool.length === 0) return '8-12';
  var min = Math.min.apply(null, pool);
  var max = Math.max.apply(null, pool);
  if (min === max) return String(min);
  return String(min) + '-' + String(max);
}

// Longest durationSec across a bucket, or null if no row logged one - which is
// also how a bucket is recognised as cardio at all.
function longestDuration(rows) {
  var best = null;
  for (var i = 0; i < rows.length; i++) {
    if (!isObj(rows[i])) continue;
    var v = num(rows[i].durationSec);
    if (v === null || v <= 0) continue;
    if (best === null || v > best) best = v;
  }
  return best === null ? null : Math.round(best);
}

export function newTemplate(name, opts) {
  var o = isObj(opts) ? opts : {};
  var now = optNow(o);
  return {
    id: str(o.id) || freshId(),
    name: str(name).trim(),
    exercises: [],
    custom: true,
    createdAt: now,
    updatedAt: now
  };
}

export function templateFromWorkout(workout, name, opts) {
  var w = isObj(workout) ? workout : {};
  var rows = Array.isArray(w.sets) ? w.sets : [];
  var grouped = groupRows(rows);
  var exercises = [];
  for (var i = 0; i < grouped.order.length; i++) {
    var bucket = grouped.groups[grouped.order[i]];
    var first = isObj(bucket[0]) ? bucket[0] : {};
    var entry = {
      id: str(first.exerciseId),
      name: str(first.exerciseName),
      sets: workingCount(bucket),
      reps: deriveReps(bucket),
      rest: '2-3 min',
      efforts: [],
      superset: null
    };
    // A cardio row logged time, not reps: prescribe the longest duration the
    // workout actually recorded rather than a meaningless rep range.
    var dur = longestDuration(bucket);
    if (dur !== null) {
      entry.cardio = true;
      entry.durationSec = dur;
    }
    exercises.push(entry);
  }
  var label = str(name).trim();
  if (!label) label = str(w.templateName).trim();
  if (!label) label = 'Workout template';
  var o = isObj(opts) ? opts : {};
  var now = optNow(o);
  return {
    id: str(o.id) || freshId(),
    name: label,
    exercises: exercises,
    custom: true,
    createdAt: now,
    updatedAt: now
  };
}

export function validateTemplateName(name, opts) {
  if (typeof name !== 'string') {
    return { ok: false, error: 'Name must be text.' };
  }
  var trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: 'Name cannot be empty.' };
  }
  if (trimmed.length > 40) {
    return { ok: false, error: 'Name must be 40 characters or fewer.' };
  }
  // Duplicate names are deliberately allowed: ids are the unique key, and a
  // user may legitimately want two templates called 'Leg Day'.
  return { ok: true, name: trimmed };
}

export function renameTemplate(tpl, name, opts) {
  var check = validateTemplateName(name, opts);
  if (!check.ok) return tpl; // invalid name: hand back the record untouched
  var next = cloneTemplate(tpl);
  next.name = check.name;
  next.updatedAt = optNow(opts);
  return next;
}

export function addExercise(tpl, exercise, opts) {
  var src = isObj(exercise) ? exercise : {};
  var cardio = src.cardio === true;
  var entry = {
    id: str(src.id),
    name: str(src.name),
    sets: num(src.sets) !== null ? src.sets : (cardio ? 1 : 3),
    reps: typeof src.reps === 'string' && src.reps ? src.reps : '8-12',
    rest: typeof src.rest === 'string' && src.rest ? src.rest : '2-3 min',
    efforts: Array.isArray(src.efforts) ? src.efforts.map(str) : [],
    superset: src.superset === null || typeof src.superset === 'string'
      ? src.superset
      : null
  };
  // Cardio rows prescribe a duration instead of a rep range. The flag is
  // stored on the row so a template stays readable without having to resolve
  // the exercise id back to its definition.
  if (cardio) {
    entry.cardio = true;
    entry.durationSec = num(src.durationSec) !== null && src.durationSec > 0
      ? Math.round(src.durationSec)
      : 1800;
  }
  var next = cloneTemplate(tpl);
  // The same exercise id may appear more than once; no uniqueness check here.
  next.exercises.push(entry);
  next.updatedAt = optNow(opts);
  return next;
}

export function removeExercise(tpl, index, opts) {
  var list = isObj(tpl) && Array.isArray(tpl.exercises) ? tpl.exercises : [];
  var i = intIndex(index, list.length);
  if (i === null) {
    // No-op: an equivalent template, not a corrupted one, and no bump -
    // nothing actually changed.
    return cloneTemplate(tpl);
  }
  var next = cloneTemplate(tpl);
  next.exercises.splice(i, 1);
  next.updatedAt = optNow(opts);
  return next;
}

// Shared shape for a replacement row when the slot holds junk. Kept in one
// place so every setter repairs a corrupt template the same way.
function blankRow(overrides) {
  var row = {
    id: '', name: '', sets: 3,
    reps: '8-12', rest: '2-3 min', efforts: [], superset: null
  };
  var keys = Object.keys(isObj(overrides) ? overrides : {});
  for (var i = 0; i < keys.length; i++) row[keys[i]] = overrides[keys[i]];
  return row;
}

// Shared guard for the per-row setters: returns the row to edit inside a fresh
// clone, or null when the index is unusable and the caller should no-op.
function editRow(tpl, index) {
  var list = isObj(tpl) && Array.isArray(tpl.exercises) ? tpl.exercises : [];
  return intIndex(index, list.length);
}

// Rep prescription is free text on purpose: '8', '8-12', 'AMRAP' and 'to
// failure' are all things a real programme writes. Only length is bounded.
export function setReps(tpl, index, reps, opts) {
  var i = editRow(tpl, index);
  if (i === null || typeof reps !== 'string') return cloneTemplate(tpl);
  var v = reps.trim().slice(0, 20);
  if (!v) v = '8-12';
  var next = cloneTemplate(tpl);
  if (isObj(next.exercises[i])) next.exercises[i].reps = v;
  else next.exercises[i] = blankRow({ reps: v });
  next.updatedAt = optNow(opts);
  return next;
}

// Rest is free text too ('90s', '2-3 min'); parseRest in the app reads it.
export function setRest(tpl, index, rest, opts) {
  var i = editRow(tpl, index);
  if (i === null || typeof rest !== 'string') return cloneTemplate(tpl);
  var v = rest.trim().slice(0, 20);
  if (!v) v = '2-3 min';
  var next = cloneTemplate(tpl);
  if (isObj(next.exercises[i])) next.exercises[i].rest = v;
  else next.exercises[i] = blankRow({ rest: v });
  next.updatedAt = optNow(opts);
  return next;
}

// Prescribed cardio duration, in seconds. Clamped to 1 second .. 6 hours.
export function setDuration(tpl, index, seconds, opts) {
  var i = editRow(tpl, index);
  var v = num(seconds);
  if (i === null || v === null) return cloneTemplate(tpl);
  var clamped = Math.min(21600, Math.max(1, Math.round(v)));
  var next = cloneTemplate(tpl);
  if (isObj(next.exercises[i])) {
    next.exercises[i].durationSec = clamped;
    next.exercises[i].cardio = true;
  } else {
    next.exercises[i] = blankRow({ sets: 1, cardio: true, durationSec: clamped });
  }
  next.updatedAt = optNow(opts);
  return next;
}

export function setSets(tpl, index, n, opts) {
  var list = isObj(tpl) && Array.isArray(tpl.exercises) ? tpl.exercises : [];
  var i = intIndex(index, list.length);
  var count = num(n);
  if (i === null || count === null) return cloneTemplate(tpl);
  // Clamped to a sane range: at least one set, at most twenty.
  var clamped = Math.min(20, Math.max(1, Math.floor(count)));
  var next = cloneTemplate(tpl);
  var ex = next.exercises[i];
  if (isObj(ex)) {
    ex.sets = clamped;
  } else {
    // Junk element at that slot: replace it wholesale rather than throw.
    next.exercises[i] = blankRow({ sets: clamped });
  }
  next.updatedAt = optNow(opts);
  return next;
}

export function moveExercise(tpl, from, to, opts) {
  var list = isObj(tpl) && Array.isArray(tpl.exercises) ? tpl.exercises : [];
  var f = intIndex(from, list.length);
  var t = intIndex(to, list.length);
  if (f === null || t === null) return cloneTemplate(tpl);
  var next = cloneTemplate(tpl);
  // Splice out one element, splice it back in: nothing lost, nothing doubled.
  var moved = next.exercises.splice(f, 1)[0];
  next.exercises.splice(t, 0, moved);
  next.updatedAt = optNow(opts);
  return next;
}

export function mergeCustomTemplates(local, remote) {
  // Prototype-less lookup table: ids like '__proto__' must behave as plain keys.
  var at = Object.create(null);
  var out = [];

  function usable(rec) {
    return isObj(rec) && typeof rec.id === 'string' && rec.id.length > 0;
  }

  // A missing updatedAt counts as 0, so it loses to anything dated.
  function stamp(rec) {
    var t = num(rec.updatedAt);
    return t === null ? 0 : t;
  }

  var localList = Array.isArray(local) ? local : [];
  var remoteList = Array.isArray(remote) ? remote : [];
  var i, rec, id;

  // Local side seeds the union first, so on an updatedAt tie the local record
  // simply stays in place and the remote one never displaces it.
  for (i = 0; i < localList.length; i++) {
    rec = localList[i];
    if (!usable(rec)) continue; // junk rows are skipped, never thrown on
    id = rec.id;
    if (at[id] === undefined) {
      at[id] = out.length;
      out.push(jsonSafe(rec));
    } else if (stamp(rec) > stamp(out[at[id]])) {
      out[at[id]] = jsonSafe(rec); // duplicate id within one side: newest wins
    }
  }
  for (i = 0; i < remoteList.length; i++) {
    rec = remoteList[i];
    if (!usable(rec)) continue;
    id = rec.id;
    if (at[id] === undefined) {
      at[id] = out.length;
      out.push(jsonSafe(rec));
    } else if (stamp(rec) > stamp(out[at[id]])) {
      // Strictly newer remote replaces local; an exact tie keeps local.
      out[at[id]] = jsonSafe(rec);
    }
  }
  // Union guarantee: every usable id from either side is present above, and
  // neither input array nor any input record was touched.
  return out;
}

export function allTemplates(builtIn, custom) {
  var builtIns = Array.isArray(builtIn) ? builtIn : [];
  var customs = Array.isArray(custom) ? custom : [];
  var taken = Object.create(null);
  var out = [];
  var i, rec, id;

  for (i = 0; i < builtIns.length; i++) {
    rec = builtIns[i];
    if (!isObj(rec)) continue;
    id = typeof rec.id === 'string' ? rec.id : '';
    if (id) taken[id] = true;
    out.push(jsonSafe(rec));
  }
  for (i = 0; i < customs.length; i++) {
    rec = customs[i];
    if (!isObj(rec)) continue;
    id = typeof rec.id === 'string' ? rec.id : '';
    // A custom id colliding with a built-in id is dropped. The built-in always
    // wins because the shipped programme is authoritative: a corrupted or
    // malicious custom record must never be able to shadow or replace the real
    // built-in workouts.
    if (id && taken[id]) continue;
    out.push(jsonSafe(rec));
  }
  return out;
}

export function isCustomTemplate(tpl) {
  return isObj(tpl) && tpl.custom === true;
}
