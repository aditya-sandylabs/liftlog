/* LiftLog — ES module. Storage: IndexedDB (system of record).
   The only network calls are the one-time data.json fetch and, if the user has
   explicitly connected it, the best-effort Google Drive mirror in sync.js. */
'use strict';

import { sync, mergeWorkouts } from './sync.js';
import { parseStrongCsv } from './strong.js';
import {
  buildExerciseIndex, searchExercises, makeCustomExercise,
  mergeCustomExercises, mergeBodyWeights,
  bodyWeightSeries, bodyWeightSVG, heatmapSVG,
  CARDIO_EXERCISES, isCardio, cardioMode, estimateKcal, latestBodyKg,
  fmtCardio, workoutKcal
} from './features.js';
import {
  newTemplate, templateFromWorkout, validateTemplateName, renameTemplate,
  addExercise as tplAddExercise, removeExercise as tplRemoveExercise,
  setSets as tplSetSets, moveExercise as tplMoveExercise,
  setReps as tplSetReps, setRest as tplSetRest, setDuration as tplSetDuration,
  mergeCustomTemplates, allTemplates, isCustomTemplate
} from './templates.js';

/* ================= tiny helpers ================= */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const DAY = 864e5;
const LB = 2.2046226218;
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* ================= units (canonical kg, display converts) ================= */
let unit = localStorage.getItem('ll.unit') || 'kg';
const dispKg = kg => (kg == null || isNaN(kg)) ? null : Math.round((unit === 'kg' ? kg : kg * LB) * 100) / 100;
const toKg   = v  => v == null ? null : (unit === 'kg' ? v : v / LB);
const parseDisp = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const stepFor = () => (unit === 'kg' ? 2.5 : 5);
const fmtNum = d => d == null ? '—' : String(Math.round(d * 100) / 100);
const fmtW = kg => { const d = dispKg(kg); return d == null ? '—' : fmtNum(d) + ' ' + unit; };
const e1rm = (w, r) => (w > 0 && r > 0) ? w * (1 + r / 30) : null; // Epley

/* Cardio duration is entered in minutes and stored in seconds. Accepts either
   "32" or "32:30"; anything unparseable is null rather than 0, so a typo shows
   as empty instead of silently logging a zero-minute session. */
const parseMin = v => {
  const t = String(v == null ? '' : v).trim().replace(',', '.');
  if (!t) return null;
  const mm = t.match(/^(\d+):([0-5]?\d)$/);
  if (mm) return (+mm[1]) * 60 + (+mm[2]);
  const n = parseFloat(t);
  return isNaN(n) || n < 0 ? null : Math.round(n * 60);
};
/* Seconds back to what the field should show: whole minutes stay whole. */
const dispMin = sec => {
  if (sec == null || !isFinite(sec) || sec <= 0) return '';
  if (sec % 60 === 0) return String(sec / 60);
  return Math.floor(sec / 60) + ':' + String(Math.round(sec % 60)).padStart(2, '0');
};

const fmtDur = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
};
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function relTime(ts) {
  if (!ts) return 'Never';
  const d = startOfDay(Date.now()) - startOfDay(ts);
  if (d <= 0) return 'Today';
  if (d === DAY) return 'Yesterday';
  if (d < 7 * DAY) return Math.round(d / DAY) + ' days ago';
  return fmtDate(ts);
}

/* Parse rest strings from data.json: "2-3 min"→150, "1.5-2 min"→105, "2 min"→120,
   "1 min between arms"→60, "90 sec"→90, "Superset A"→60. */
function parseRest(s) {
  if (!s) return 90;
  const t = String(s).toLowerCase();
  if (t.includes('superset')) return 60;
  const nums = (t.match(/\d+(\.\d+)?/g) || []).map(Number);
  if (!nums.length) return 90;
  if (t.includes('sec')) return Math.round(nums[0]);
  const m = nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
  return Math.round(m * 60);
}

/* ================= IndexedDB layer ================= */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('liftlog', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
  },
  put(store, val, key) { return DB.tx(store, 'readwrite', s => s.put(val, key)); },
  get(store, key)      { return DB.tx(store, 'readonly',  s => s.get(key)); },
  getAll(store)        { return DB.tx(store, 'readonly',  s => s.getAll()); },
  del(store, key)      { return DB.tx(store, 'readwrite', s => s.delete(key)); },
  clear(store)         { return DB.tx(store, 'readwrite', s => s.clear()); }
};

/* ================= prefs (trivial UI only — localStorage) ================= */
const prefs = {
  get theme() { return localStorage.getItem('ll.theme') || 'system'; },
  set theme(v) { localStorage.setItem('ll.theme', v); applyTheme(); },
  get defaultRest() { return localStorage.getItem('ll.rest') !== '0'; },
  set defaultRest(v) { localStorage.setItem('ll.rest', v ? '1' : '0'); },
  get swaps() { try { return JSON.parse(localStorage.getItem('ll.swaps') || '{}'); } catch { return {}; } },
  set swaps(o) { localStorage.setItem('ll.swaps', JSON.stringify(o)); }
};
function applyTheme() {
  const t = prefs.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/* ================= state ================= */
const state = {
  data: null,       // parsed data.json (read-only, authoritative)
  workouts: [],     // completed workouts, newest first
  active: null,     // in-progress workout (persisted continuously)
  custom: [],       // user-created exercises (synced)
  templates: [],    // user-created workout templates (synced)
  weights: [],      // body-weight entries {ts, kg} (synced)
  view: 'home',
  wodId: null
};

/* The searchable exercise index is derived from data.json + custom + history,
   so it must be rebuilt whenever any of those change. */
let exIndex = [];
function rebuildExerciseIndex() {
  exIndex = buildExerciseIndex({
    data: state.data, custom: state.custom, workouts: state.workouts
  });
}

/* Built-in templates come from data.json and are READ-ONLY; the user's own
   live in state.templates. Anything that used to read state.data.templates
   must read this instead, or custom templates are invisible to it. */
function templateList() {
  return allTemplates(state.data && state.data.templates, state.templates);
}
function findTemplate(id) {
  return templateList().find(t => t.id === id) || null;
}
async function saveTemplates() {
  await DB.put('kv', state.templates, 'templates');
}

async function loadData() {
  try {
    const r = await fetch('./data.json');
    if (!r.ok) throw new Error('http');
    const j = await r.json();
    if (j && j.schemaVersion != null) { await DB.put('kv', j, 'data'); state.data = j; return; }
    throw new Error('shape');
  } catch (e) {
    // offline before SW had a chance: fall back to the IDB mirror
    state.data = await DB.get('kv', 'data');
    if (!state.data) {
      document.body.innerHTML = '<p style="padding:2rem;font-family:system-ui">data.json could not be loaded. Reconnect once so it can be cached.</p>';
      throw new Error('no data');
    }
  }
}

/* ================= "previous" lookup & PR ================= */
/* Most recent completed workout containing exerciseId with a logged, non-warm-up set N. */
function prevFor(exId, n) {
  for (const w of state.workouts) {
    const s = w.sets.find(s => s.exerciseId === exId && s.setNumber === n && !s.isWarmup);
    // Projected rather than returned whole so the "previous" snapshot cannot
    // drag a stale note or PR flag into a new set. Cardio fields are part of
    // that snapshot: without them a repeat interval prefills nothing and the
    // "last:" line on a cardio row renders empty.
    if (s) return s.cardio
      ? { weightKg: s.weightKg, reps: s.reps, cardio: true, durationSec: s.durationSec,
          speedKmh: s.speedKmh ?? null, inclinePct: s.inclinePct ?? null, kcal: s.kcal ?? null }
      : { weightKg: s.weightKg, reps: s.reps };
  }
  return null;
}
/* Best prior e1RM for an exercise: completed history + already-confirmed sets of the live workout. */
function bestPriorE1RM(exId) {
  let m = 0;
  for (const w of state.workouts)
    for (const s of w.sets)
      if (s.exerciseId === exId && !s.isWarmup) {
        const e = e1rm(s.weightKg, s.reps);
        if (e != null && e > m) m = e;
      }
  if (state.active)
    for (const ex of state.active.exercises)
      if (ex.exerciseId === exId)
        for (const s of ex.sets)
          if (s.done && !s.isWarmup) {
            const e = e1rm(s.weightKg, s.reps);
            if (e != null && e > m) m = e;
          }
  return m;
}

/* ================= exercise resolution (incl. alternatives) ================= */
function resolveExercise(id, te) {
  const d = (state.data && state.data.exercises) || {};
  if (d[id]) return d[id];

  /* Cardio built-ins are defined in features.js, not data.json -- data.json is
     regenerated from the PDF by build/, so anything added there is wiped. */
  const cardio = CARDIO_EXERCISES.find(c => c.id === id);
  if (cardio) return {
    id: cardio.id, name: cardio.name, muscle: 'Cardio', bodyweight: true,
    cardio: true, mode: cardio.mode, met: cardio.met,
    video: null, tutorial: null, steps: [], alternatives: []
  };

  // User-created exercises live outside data.json but must resolve like any other.
  const own = (state.custom || []).find(c => c.id === id);
  if (own) {
    const c = isCardio(own);
    return {
      id: own.id, name: own.name, muscle: own.muscle || '',
      bodyweight: c ? true : !!own.bodyweight, video: null, tutorial: null,
      cardio: c, mode: c ? cardioMode(own) : null,
      met: typeof own.met === 'number' ? own.met : null,
      steps: [], alternatives: [], custom: true
    };
  }
  const bySlug = Object.values(d).find(e => slug(e.name) === id);
  if (bySlug) return bySlug;

  /* Alternatives are NOT top-level entries in data.json -- they live inside each
     exercise's `alternatives` array as {name, video}. Without this lookup the
     search fell through to the `te` fallback below and returned the ORIGINAL
     exercise, so swapping set a new exerciseId but kept the old name and video
     and the card appeared unchanged. Inherit the parent's muscle group; the
     alternative carries its own name and tutorial video. */
  for (const parent of Object.values(d)) {
    const alt = (parent.alternatives || []).find(a => slug(a.name) === id);
    if (alt) return {
      id, name: alt.name, muscle: parent.muscle || '',
      bodyweight: !!parent.bodyweight, video: alt.video || null,
      tutorial: null, steps: [], alternatives: parent.alternatives || []
    };
  }

  if (te && d[te.id]) return d[te.id];
  return { id, name: te ? te.name : id, muscle: '', bodyweight: false, video: null, tutorial: null, steps: [], alternatives: [] };
}

/* ================= views / router ================= */
function showView(v) {
  state.view = v;
  $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.v === v || (v === 'wod' && b.dataset.v === 'history')));
  if (v === 'home') renderHome();
  if (v === 'history') renderHistory();
  if (v === 'stats') renderStats();
  if (v === 'quotes') renderQuotes();
  /* Settings used to be painted once at startup and never again, so the Drive
     box showed whatever was true when the app launched -- including "Not
     connected" or a last-backed-up date that had since gone stale. Opening the
     screen must re-read the real state. */
  if (v === 'settings') renderDrive();
  // The elapsed clock keeps running while the workout is minimised -- the mini
  // bar shows it -- so it is tied to the workout existing, not to the view.
  if (state.active) startElapsed(); else stopElapsed();
  if (v === 'active') acquireWake(); else releaseWake();
  renderMiniBar();
  window.scrollTo(0, 0);
}

/* ================= minimised workout =================
   Leaving the active view used to strand the workout: it was still running and
   still saved, but the only route back was to reload the app and answer the
   resume prompt. The mini bar is that route -- always on screen while a
   workout is open and the active view is not. */
function reopenActive() {
  if (!state.active) return;
  buildActiveHeader();
  renderActive();
  showView('active');
}

function renderMiniBar() {
  const bar = $('#minibar');
  if (!bar) return;
  const show = !!state.active && state.view !== 'active';
  bar.hidden = !show;
  document.body.classList.toggle('has-mini', show);
  if (!show) return;
  const a = state.active;
  const done = a.exercises.reduce((t, ex) => t + ex.sets.filter(s => s.done).length, 0);
  $('#mini-name').textContent = a.templateName;
  $('#mini-sets').textContent = done + ' set' + (done === 1 ? '' : 's') + ' done';
  $('#mini-elapsed').textContent = fmtDur(elapsedMs() / 1000);
}

/* ================= home ================= */
function nextUp() {
  const sched = (state.data.program && state.data.program.schedule) || [];
  const last = state.workouts[0];
  let i = 0;
  if (last) {
    const idx = sched.indexOf(last.templateName);
    if (idx >= 0) i = idx + 1;
  }
  for (let k = 0; k < 7; k++) {
    const day = sched[(i + k) % 7];
    if (day && day !== 'Rest') {
      const t = state.data.templates.find(t => t.name === day);
      if (t) return t;
    }
  }
  return state.data.templates[0];
}

function renderHome() {
  $('#program-name').textContent = (state.data.program && state.data.program.name) || '';
  const nu = nextUp();
  const cards = templateList().map(t => {
    const last = state.workouts.find(w => w.templateId === t.id);
    const mine = isCustomTemplate(t);
    // "Custom" is a bordered text badge, never a colour: the palette carries no
    // state by hue anywhere in this app.
    const badge = mine ? '<span class="tpl-badge">Custom</span>' : '';
    const card = `<button class="tpl" data-tpl="${esc(t.id)}">
      <span class="tpl-name">${esc(t.name)}${badge}</span>
      <span class="tpl-meta">${t.exercises.length} exercises · ${esc(relTime(last ? last.startTime : 0))}</span>
      <svg class="ic chev"><use href="#i-chev"/></svg></button>`;
    // Siblings, not nesting: a <button> inside a <button> is invalid HTML and
    // the inner one is unreachable to a real tap.
    return mine
      ? `<div class="tpl-row">${card}<button class="tpl-edit" data-tpledit="${esc(t.id)}" aria-label="Edit ${esc(t.name)}"><svg class="ic"><use href="#i-dots"/></svg></button></div>`
      : card;
  }).join('');
  const recent = state.workouts.slice(0, 5).map(w =>
    `<button class="hist-item" data-wod="${esc(w.id)}">
      <span class="hi-date">${esc(fmtDate(w.startTime))}</span>
      <span class="hi-name">${esc(w.templateName)}</span>
      <span class="hi-meta">${esc(workoutMeta(w))}</span>
    </button>`).join('')
    || '<p class="muted pad-s">No workouts yet — pick a day above to start.</p>';
  /* A dead backup has to be visible somewhere the user actually looks. Settings
     is not that place -- the whole failure mode was that nobody opened it. */
  const backupWarn = backupUnhealthy()
    ? `<button class="nextup warn" id="backup-warn"><svg class="ic"><use href="#i-warn"/></svg>
        <div><strong>Backup is not up to date.</strong><br><span class="small">${
          sync.needsAuth()
            ? 'Google sign-in expired. Tap to reconnect.'
            : 'Last backed up ' + esc(sync.lastSync() ? relTime(sync.lastSync()).toLowerCase() : 'never') + '. Tap to retry.'
        }</span></div></button>`
    : '';

  $('#home-body').innerHTML = `
    ${backupWarn}
    <div class="nextup"><svg class="ic"><use href="#i-info"/></svg>
      <div><strong>Suggested next:</strong> ${esc(nu ? nu.name : '—')}<br><span class="muted small">A suggestion only — any day can be started.</span></div>
    </div>
    <h2 class="sec">Start workout</h2>
    <div class="list">
      <button class="addex" id="start-empty"><svg class="ic"><use href="#i-plus"/></svg>Start an empty workout</button>
      ${cards}
      <button class="addex" data-tplnew="1"><svg class="ic"><use href="#i-plus"/></svg>Create a template</button>
    </div>
    <h2 class="sec">Recent workouts</h2>
    <div class="list">${recent}</div>`;
  $('#start-empty').onclick = startEmptyWorkout;
  const bw = $('#backup-warn');
  // The tap IS the user gesture the interactive token request needs, so this
  // is a real fix-it button, not just a link to Settings.
  if (bw) bw.onclick = async () => {
    toast('Reconnecting to Google Drive…');
    const r = await backgroundSync({ interactive: true });
    toast(r.ok ? 'Backup up to date' : 'Still not working — see Settings');
    renderHome();
  };
}

/* ================= active workout ================= */
function makeSet(exId, n, opts) {
  const p = prevFor(exId, n);
  const o = opts || {};
  if (o.cardio) {
    /* A cardio set carries time, not load. Pre-filled from the last time this
       exercise was logged so a repeat session is one tap; the template's
       prescribed duration is the fallback on the very first outing. */
    return {
      n, done: false, isWarmup: false, note: '', prev: p, pr: false,
      cardio: true,
      durationSec: p && p.durationSec != null ? p.durationSec : (o.durationSec ?? null),
      speedKmh: p && p.speedKmh != null ? p.speedKmh : null,
      inclinePct: p && p.inclinePct != null ? p.inclinePct : null,
      kcal: null,
      // kcal stays derived until the user types over it, at which point their
      // number is authoritative and must never be recomputed away.
      kcalManual: false,
      weightKg: 0, reps: 0
    };
  }
  // weightKg/reps pre-filled from history (rendered dimmed until confirmed)
  return { n, weightKg: p ? p.weightKg : null, reps: p ? p.reps : null, done: false, isWarmup: false, note: '', prev: p, pr: false };
}
function makeEx(te, altId) {
  const exId = altId || te.id;
  const ex = resolveExercise(exId, te);
  const cardio = isCardio(ex) || te.cardio === true;
  const dur = te.durationSec != null ? te.durationSec : (cardio ? 1800 : null);
  return {
    origId: te.id, exerciseId: exId, name: ex.name, muscle: ex.muscle || '',
    bodyweight: cardio ? true : !!ex.bodyweight, video: ex.video || null,
    targetReps: te.reps, rest: te.rest, superset: te.superset || null,
    efforts: te.efforts || [],
    cardio, mode: cardio ? cardioMode(ex) : null,
    met: cardio && typeof ex.met === 'number' ? ex.met : null,
    targetDurationSec: cardio ? dur : null,
    sets: Array.from({ length: te.sets },
      (_, i) => makeSet(exId, i + 1, { cardio, durationSec: dur }))
  };
}

/* makeSet cannot estimate calories on its own -- the mode and MET live on the
   exercise, not the set -- so a prefilled cardio row is costed here, once the
   exercise wrapper exists. Without this the estimate stays blank until the
   first field is touched. */
function withKcal(ex) {
  if (ex.cardio) for (const s of ex.sets) refreshKcal(ex, s);
  return ex;
}

/* Body weight drives the calorie estimate. Falls back inside estimateKcal to a
   documented 75 kg when nothing has been logged. */
function bodyKg() { return latestBodyKg(state.weights); }

/* Recompute a cardio set's calorie estimate unless the user typed their own. */
function refreshKcal(ex, s) {
  if (!s.cardio || s.kcalManual) return;
  s.kcal = estimateKcal({
    mode: ex.mode, met: ex.met, durationSec: s.durationSec,
    speedKmh: s.speedKmh, inclinePct: s.inclinePct, bodyKg: bodyKg()
  });
}

function startWorkout(tplId) {
  if (state.active) { promptResume(state.active); return; }
  const t = findTemplate(tplId);
  if (!t) return;
  const swaps = prefs.swaps[tplId] || {};
  state.active = {
    key: 'current', id: uid(), templateId: t.id, templateName: t.name,
    startTime: Date.now(), restEnd: 0,
    elapsedMs: 0, runningSince: null, everStarted: false,   // timer starts paused
    exercises: t.exercises.map(te => withKcal(makeEx(te, swaps[te.id] || null)))
  };
  saveActive(true);
  buildActiveHeader();
  renderActive();
  showView('active');
  showCheer('start', esc(state.active.templateName));
}

function buildActiveHeader() {
  if (!state.active) return;
  $('#aw-name').textContent = state.active.templateName;
  renderTimerBtn();
  elTick();
}

function cardHTML(ex, ei) {
  const rows = ex.sets.map((s, si) => rowHTML(ex, s, ei, si)).join('');
  // Cardio has no weight/reps columns, so it gets no column header either --
  // each field carries its own label instead.
  const head = ex.cardio ? ''
    : `<div class="set-row head"><span>SET</span><span>PREVIOUS</span><span>${esc(unit.toUpperCase())}</span><span>REPS</span><span></span><span></span></div>`;
  const target = ex.cardio
    ? `<span class="muted">${esc(ex.targetDurationSec ? dispMin(ex.targetDurationSec) + ' min target' : 'time-based')}</span>`
    : `<span class="muted">${esc(ex.targetReps)} reps · rest ${esc(ex.rest)}</span>`;
  return `<article class="ex-card${ex.cardio ? ' cardio-card' : ''}" data-ei="${ei}">
    <header class="ex-head">
      <button class="ex-name" data-act="detail" data-ei="${ei}"><span>${esc(ex.name)}</span><svg class="ic chev"><use href="#i-chev"/></svg></button>
      <button class="icon-btn" data-act="cardmenu" data-ei="${ei}" aria-label="Exercise options"><svg class="ic"><use href="#i-dots"/></svg></button>
    </header>
    <div class="ex-target">
      <span class="tag">${esc(ex.muscle || 'Exercise')}</span>
      ${target}
    </div>
    <div class="set-grid">
      ${head}
      ${rows}
    </div>
    <button class="addset" data-act="addset" data-ei="${ei}"><svg class="ic"><use href="#i-plus"/></svg> ${ex.cardio ? 'Add interval' : 'Add set'}</button>
  </article>`;
}

/* One labelled numeric field inside a cardio row. */
function cardioField(cls, label, value, hint, disabled) {
  return `<label class="cr-f"><span class="cr-lbl">${esc(label)}</span>
    <input class="inp ${cls}" type="text" inputmode="decimal" value="${esc(value)}"
      placeholder="${esc(hint)}" ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"></label>`;
}

/* Cardio set: time (+ speed and incline for treadmill-shaped work) and an
   editable calorie estimate. Laid out as its own block rather than squeezed
   into the six lifting columns, which are already tight on a phone. */
function cardioRowHTML(ex, s, ei, si) {
  const dis = s.done;
  const showPace = ex.mode === 'walk' || ex.mode === 'run';
  const prev = s.prev ? fmtCardio(s.prev) : '';
  const badges = (s.note ? `<span class="badge note" role="img" aria-label="Has note"><svg class="ic"><use href="#i-note"/></svg></span>` : '');
  const est = (!s.kcalManual && s.kcal != null) ? '<span class="cr-est">est.</span>' : '';
  return `<div class="set-row cardio-row${s.done ? ' done' : ''}" data-ei="${ei}" data-si="${si}">
    <div class="cr-top">
      <span class="c-set">${s.n}${badges}</span>
      ${prev ? `<span class="c-prev">last: ${esc(prev)}</span>` : '<span class="c-prev">—</span>'}
    </div>
    <div class="cr-fields">
      ${cardioField('d-inp', 'MIN', dispMin(s.durationSec), '30', dis)}
      ${showPace ? cardioField('sp-inp', 'KM/H', s.speedKmh == null ? '' : s.speedKmh, '5.0', dis) : ''}
      ${showPace ? cardioField('in-inp', 'INCLINE %', s.inclinePct == null ? '' : s.inclinePct, '12', dis) : ''}
      ${cardioField('k-inp', 'KCAL', s.kcal == null ? '' : s.kcal, '—', dis)}
    </div>
    <div class="cr-actions">
      ${est}
      <button class="check${s.done ? ' on' : ''}" data-act="check" aria-pressed="${s.done}" aria-label="${s.done ? 'Uncomplete set' : 'Complete set'}"><svg class="ic"><use href="#i-check"/></svg></button>
      <button class="rowmenu" data-act="rowmenu" aria-label="Set options"><svg class="ic"><use href="#i-dots"/></svg></button>
    </div>
  </div>`;
}

/* Glossary marker: only for effort strings that differ from the plain default and exist in the glossary. */
function effortMark(ex, s) {
  const eff = ex.efforts && ex.efforts[s.n - 1];
  if (!eff || eff === '2-3 reps shy of failure') return '';
  const g = (state.data.program && state.data.program.glossary) || {};
  if (!g[eff]) return '';
  return `<button class="gloss" data-act="gloss" data-term="${esc(eff)}" aria-label="What does “${esc(eff)}” mean?"><svg class="ic"><use href="#i-info"/></svg></button>`;
}

function rowHTML(ex, s, ei, si) {
  if (ex.cardio) return cardioRowHTML(ex, s, ei, si);
  const prev = s.prev ? `${fmtNum(dispKg(s.prev.weightKg))} × ${s.prev.reps}` : '—';
  const wv = s.weightKg == null ? '' : fmtNum(dispKg(s.weightKg));
  const rv = s.reps == null ? '' : String(s.reps);
  const pref = (!s.done && s.prev) ? ' pref' : '';
  const badges =
    (s.isWarmup ? '<span class="badge warm">Warm-up</span>' : '') +
    (s.pr ? '<span class="badge pr"><svg class="ic"><use href="#i-trophy"/></svg>PR</span>' : '') +
    (s.note ? `<span class="badge note" role="img" aria-label="Has note"><svg class="ic"><use href="#i-note"/></svg></span>` : '');
  const dis = s.done ? 'disabled' : '';
  return `<div class="set-row${s.done ? ' done' : ''}${s.isWarmup ? ' warmup' : ''}" data-ei="${ei}" data-si="${si}">
    <span class="c-set">${s.n}${effortMark(ex, s)}${badges}</span>
    <span class="c-prev">${esc(prev)}</span>
    <span class="c-inp">
      <input class="inp w-inp${pref}" type="text" inputmode="decimal" value="${esc(wv)}" placeholder="0" ${dis} aria-label="Weight (${esc(unit)})">
    </span>
    <span class="c-inp">
      <input class="inp r-inp${pref}" type="text" inputmode="numeric" value="${esc(rv)}" placeholder="0" ${dis} aria-label="Reps">
    </span>
    <button class="check${s.done ? ' on' : ''}" data-act="check" aria-pressed="${s.done}" aria-label="${s.done ? 'Uncomplete set' : 'Complete set'}"><svg class="ic"><use href="#i-check"/></svg></button>
    <button class="rowmenu" data-act="rowmenu" aria-label="Set options"><svg class="ic"><use href="#i-dots"/></svg></button>
  </div>`;
}

function renderActive() {
  const a = state.active;
  if (!a) return;
  $('#aw-name').textContent = a.templateName;
  let html = '', i = 0;
  while (i < a.exercises.length) {
    const ex = a.exercises[i];
    if (ex.superset) {
      // bracket consecutive members sharing a superset letter
      let j = i;
      const letter = ex.superset;
      let group = '';
      while (j < a.exercises.length && a.exercises[j].superset === letter) { group += cardHTML(a.exercises[j], j); j++; }
      html += `<div class="superset"><div class="ss-label">SUPERSET ${esc(letter)} — go straight to the next exercise</div>${group}</div>`;
      i = j;
    } else { html += cardHTML(ex, i); i++; }
  }
  if (!a.exercises.length) {
    html += '<p class="muted pad-s">Nothing here yet \u2014 add an exercise to begin.</p>';
  }
  html += '<button class="addex" id="add-ex"><svg class="ic"><use href="#i-plus"/></svg>Add an exercise</button>';
  $('#aw-body').innerHTML = html;
  $('#add-ex').onclick = () => openExercisePicker('Add an exercise', addExerciseToActive);
}

function rowEl(ei, si) {
  return $(`#aw-body .ex-card[data-ei="${ei}"] .set-row[data-si="${si}"]`);
}

/* Pull whatever is currently in a cardio row's fields into the set, and
   re-derive the calorie estimate. Called both on every field edit and again on
   completion, so a value typed but not blurred is never lost. */
function readCardioRow(ex, s, row) {
  if (!row) return;
  // A field the row does not render (speed/incline on a non-treadmill
  // exercise) reads back as undefined and must leave the stored value alone,
  // never overwrite it with null.
  const g = c => { const el = row.querySelector('.' + c); return el ? el.value : undefined; };
  const dRaw = g('d-inp');
  if (dRaw !== undefined) {
    const d = parseMin(dRaw);
    // Junk keeps the previous value; an empty field genuinely clears it.
    if (d != null || String(dRaw).trim() === '') s.durationSec = d;
  }
  if (g('sp-inp') !== undefined) s.speedKmh = parseDisp(g('sp-inp'));
  if (g('in-inp') !== undefined) s.inclinePct = parseDisp(g('in-inp'));
  const kRaw = g('k-inp');
  if (kRaw === undefined) { refreshKcal(ex, s); return; }
  const k = parseDisp(kRaw);
  // A cleared calorie field hands control back to the estimator.
  if (String(kRaw || '').trim() === '') { s.kcalManual = false; s.kcal = null; }
  else if (k != null && k !== s.kcal) { s.kcalManual = true; s.kcal = Math.round(k); }
  refreshKcal(ex, s);
}

function toggleCardioSet(ei, si) {
  const ex = state.active.exercises[ei], s = ex.sets[si];
  readCardioRow(ex, s, rowEl(ei, si));
  if (s.durationSec == null || s.durationSec <= 0) {
    // Time is the whole record for a cardio set; completing without it would
    // save an empty row that shows as "—" forever.
    toast('Enter how long it took');
    return;
  }
  if (!state.active.everStarted) timerStart();
  s.done = true;
  s.weightKg = 0; s.reps = 0; s.pr = false;
  saveActive();
  renderActive();
}

function toggleSet(ei, si) {
  const ex = state.active.exercises[ei], s = ex.sets[si];
  if (s.done) { s.done = false; s.pr = false; saveActive(); renderActive(); return; }
  // Cardio has no weight/reps to read, no e1RM and no PR, and does not start a
  // rest timer -- the interval itself is the work.
  if (ex.cardio) return toggleCardioSet(ei, si);
  const row = rowEl(ei, si);
  const w = parseDisp(row.querySelector('.w-inp').value);
  const r = parseInt(row.querySelector('.r-inp').value, 10);
  const weight = w == null ? (ex.bodyweight ? 0 : (s.weightKg ?? (s.prev ? s.prev.weightKg : 0))) : toKg(w);
  const reps = isNaN(r) ? (s.reps ?? (s.prev ? s.prev.reps : 0)) : r;
  // First completed set starts the clock, so a whole session can't be logged at
  // 0:00. An explicit pause is never overridden -- only the never-started case.
  if (!state.active.everStarted) timerStart();
  const prior = bestPriorE1RM(ex.exerciseId); // computed before stamping so this set can beat it
  s.weightKg = weight;
  s.reps = reps;
  s.done = true;
  const cur = e1rm(weight, reps);
  s.pr = cur != null && cur > prior;
  if (prefs.defaultRest) startRest(parseRest(ex.rest));
  saveActive();
  renderActive();
}


function addSet(ei) {
  const ex = state.active.exercises[ei];
  const last = ex.sets[ex.sets.length - 1];
  const n = ex.sets.length + 1;
  if (ex.cardio) {
    const s = {
      n, done: false, isWarmup: false, note: '', prev: prevFor(ex.exerciseId, n), pr: false,
      cardio: true,
      durationSec: last ? last.durationSec : ex.targetDurationSec,
      speedKmh: last ? last.speedKmh : null,
      inclinePct: last ? last.inclinePct : null,
      kcal: null, kcalManual: false, weightKg: 0, reps: 0
    };
    refreshKcal(ex, s);
    ex.sets.push(s);
    saveActive();
    renderActive();
    return;
  }
  ex.sets.push({
    n, weightKg: last ? last.weightKg : null, reps: last ? last.reps : null,
    done: false, isWarmup: false, note: '', prev: prevFor(ex.exerciseId, n), pr: false
  });
  saveActive();
  renderActive();
  const cards = $$('#aw-body .ex-card');
  if (cards[ei]) cards[ei].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function rowMenu(ei, si) {
  const ex = state.active.exercises[ei], s = ex.sets[si];
  showModal({
    title: `Set ${s.n} — ${ex.name}`,
    actions: [
      ...(ex.cardio ? [] : [{ label: s.isWarmup ? 'Unmark warm-up' : 'Mark as warm-up', onClick: () => { s.isWarmup = !s.isWarmup; saveActive(); renderActive(); } }]),
      { label: s.note ? 'Edit note' : 'Add note', onClick: () => noteModal(ei, si) },
      {
        label: 'Delete set', danger: true, onClick: () => showModal({
          title: 'Delete set?',
          body: `<p>Remove set ${s.n} of <strong>${esc(ex.name)}</strong> from this workout?</p>`,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Delete set', danger: true, onClick: () => {
                ex.sets.splice(si, 1);
                ex.sets.forEach((x, i) => { x.n = i + 1; }); // renumber remaining sets
                saveActive(); renderActive();
              }
            }
          ]
        })
      },
      { label: 'Cancel' }
    ]
  });
}

function noteModal(ei, si) {
  const s = state.active.exercises[ei].sets[si];
  showModal({
    title: 'Set note',
    body: `<textarea id="note-in" class="ta" maxlength="300" placeholder="e.g. felt easy, no belt">${esc(s.note || '')}</textarea>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Save note', primary: true, onClick: () => { s.note = $('#note-in').value.trim(); saveActive(); renderActive(); } }
    ]
  });
}

function cardMenu(ei) {
  const ex = state.active.exercises[ei];
  showModal({
    title: ex.name,
    actions: [
      { label: 'Exercise details', onClick: () => openExerciseSheet(ex.exerciseId, { ei }) },
      { label: 'Swap exercise', onClick: () => openExerciseSheet(ex.exerciseId, { ei }) },
      { label: 'Remove exercise', danger: true, onClick: () => removeExerciseConfirm(ei) },
      { label: 'Cancel' }
    ]
  });
}

/* Drop a whole exercise from the live workout.
   Until now the only way to get rid of one was to delete its sets one at a
   time, which still left an empty card sitting in the workout. Logged history
   is untouched -- this only edits the in-progress session. */
function removeExerciseConfirm(ei) {
  const ex = state.active.exercises[ei];
  if (!ex) return;
  const done = ex.sets.filter(s => s.done).length;
  showModal({
    title: 'Remove exercise?',
    body: `<p>Remove <strong>${esc(ex.name)}</strong> from this workout?</p>` +
      (done
        // Only warn when there is something to lose. Saying "0 sets will be
        // discarded" on an untouched card is noise that trains you to tap through.
        ? `<p class="warnline"><svg class="ic"><use href="#i-warn"/></svg><span>${done} completed set${done === 1 ? '' : 's'} will be discarded.</span></p>`
        : '') +
      '<p class="muted small">Workouts you have already finished are not affected.</p>',
    actions: [
      { label: 'Cancel' },
      {
        label: 'Remove', danger: true, onClick: () => {
          state.active.exercises.splice(ei, 1);
          saveActive(true);
          renderActive();
          toast('Removed ' + ex.name);
        }
      }
    ]
  });
}

/* ---- swap ---- */
function openSwapConfirm(ei, altId, altName) {
  const ex = state.active.exercises[ei];
  showModal({
    title: 'Swap exercise?',
    body: `<p>Replace <strong>${esc(ex.name)}</strong> with <strong>${esc(altName)}</strong> for this session? The alternative keeps its own history under its own name.</p>
      <label class="checkline"><input type="checkbox" id="swap-remember"> Remember this swap for next time</label>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Swap', primary: true, onClick: () => doSwap(ei, altId, $('#swap-remember').checked) }
    ]
  });
}
function doSwap(ei, altId, remember) {
  const a = state.active, old = a.exercises[ei];
  const tpl = findTemplate(a.templateId);
  const te = (tpl && tpl.exercises.find(x => x.id === old.origId)) ||
    { id: old.origId, name: old.name, sets: old.sets.length, reps: old.targetReps, rest: old.rest, superset: old.superset, efforts: old.efforts };
  a.exercises[ei] = withKcal(makeEx(te, altId));
  if (remember) {
    const sw = prefs.swaps;
    sw[a.templateId] = sw[a.templateId] || {};
    sw[a.templateId][old.origId] = altId;
    prefs.swaps = sw;
  }
  saveActive(true);
  closeSheet();
  renderActive();
  toast('Exercise swapped');
}

/* ================= rest timer ================= */
const rest = { iv: null, end: 0, fired: false };
function startRest(sec) {
  rest.end = Date.now() + sec * 1000;
  scheduleRestNotif(sec * 1000);
  rest.fired = false;
  if (state.active) { state.active.restEnd = rest.end; saveActive(true); }
  $('#restbar').hidden = false;
  clearInterval(rest.iv);
  rest.iv = setInterval(restTick, 250);
  restTick();
}
function restTick() {
  const left = Math.max(0, Math.round((rest.end - Date.now()) / 1000));
  $('#rest-time').textContent = fmtDur(left);
  const done = left <= 0;
  $('#rest-label').textContent = done ? 'Rest complete — next set' : 'Rest';
  $('#restbar').classList.toggle('rest-done', done);
  if (done) {
    clearInterval(rest.iv); rest.iv = null;
    if (!rest.fired) {
      rest.fired = true;
      try { navigator.vibrate && navigator.vibrate([180, 90, 180]); } catch (e) { /* unsupported */ }
    }
  }
}
function adjustRest(sec) {
  rest.end += sec * 1000;
  rest.fired = false;
  if (state.active) { state.active.restEnd = rest.end; saveActive(true); }
  if (!rest.iv) rest.iv = setInterval(restTick, 250);
  restTick();
}
function skipRest() {
  clearRestNotif();
  clearInterval(rest.iv); rest.iv = null; rest.fired = false;
  $('#restbar').hidden = true;
  if (state.active) { state.active.restEnd = 0; saveActive(true); }
}

/* ================= elapsed timer =================
   Accumulator, not wall clock: elapsed = elapsedMs + (runningSince ? now - runningSince : 0).
   runningSince === null means paused. A new workout starts paused. */
let eliv = null;

/* Older in-progress workouts were saved before the timer had these fields.
   Treat them as having been running since startTime so no time is lost. */
function ensureTimerFields(a) {
  if (!a) return;
  if (a.elapsedMs == null) {
    a.elapsedMs = Math.max(0, Date.now() - (a.startTime || Date.now()));
    a.runningSince = Date.now();
    a.everStarted = true;
  }
}
function elapsedMs() {
  const a = state.active;
  if (!a) return 0;
  ensureTimerFields(a);
  return a.elapsedMs + (a.runningSince ? Date.now() - a.runningSince : 0);
}
function timerRunning() { return !!(state.active && state.active.runningSince); }

function timerStart() {
  const a = state.active;
  if (!a || a.runningSince) return;
  a.runningSince = Date.now();
  a.everStarted = true;
  saveActive(true);
  startElapsed();
  renderTimerBtn();
}
function timerPause() {
  const a = state.active;
  if (!a || !a.runningSince) return;
  a.elapsedMs = (a.elapsedMs || 0) + (Date.now() - a.runningSince);
  a.runningSince = null;
  saveActive(true);
  stopElapsed();
  elTick();                 // paint the frozen value
  renderTimerBtn();
}
function timerToggle() { timerRunning() ? timerPause() : timerStart(); }

function renderTimerBtn() {
  const b = $('#aw-timer');
  if (!b) return;
  const on = timerRunning();
  b.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.setAttribute('aria-label', on ? 'Pause workout timer' : 'Start workout timer');
  const wrap = b.closest('.elapsed');
  if (wrap) wrap.classList.toggle('paused', !on);
}

/* Idempotent: showView calls this on every navigation while a workout is open,
   and a second interval would double the tick rate for no benefit. */
function startElapsed() {
  if (eliv) { elTick(); return; }
  stopElapsed();
  if (!state.active || !timerRunning()) { elTick(); return; }
  eliv = setInterval(elTick, 1000);
  elTick();
}
function stopElapsed() { clearInterval(eliv); eliv = null; }
function elTick() {
  if (!state.active) return;
  const t = fmtDur(elapsedMs() / 1000);
  $('#aw-elapsed').textContent = t;
  const m = $('#mini-elapsed');
  if (m) m.textContent = t;
}

/* ================= persistence of in-progress workout ================= */
let saveT = null;
function saveActive(now) {
  if (!state.active) return;
  const snap = state.active;
  if (now) { clearTimeout(saveT); DB.put('kv', snap, 'active'); return; }
  clearTimeout(saveT);
  saveT = setTimeout(() => DB.put('kv', state.active, 'active'), 200);
}
/* Drop the in-progress workout.
   saveActive() debounces its write by 200ms, and `await` yields to the event
   loop -- so a pending timer would fire *during* the delete, while
   state.active was still set, and write the workout straight back. Cancel the
   timer and null the state before awaiting anything. */
async function discardActive() {
  clearTimeout(saveT);
  saveT = null;
  state.active = null;
  await DB.del('kv', 'active');
  skipRest();
  stopElapsed();
  renderMiniBar();
}

/* Tapping anywhere off a number field blurs it, which closes the device
   keypad and commits the value through the existing `change` handler.
   Capture phase so the value is committed before any button click lands. */
document.addEventListener('pointerdown', e => {
  const a = document.activeElement;
  if (!a || !a.classList || !a.classList.contains('inp')) return;
  if (e.target === a) return;                                   // same field
  if (e.target.classList && e.target.classList.contains('inp')) return; // moving to another field
  a.blur();
}, true);

document.addEventListener('visibilitychange', () => { if (document.hidden) saveActive(true); });
window.addEventListener('pagehide', () => saveActive(true));

/* ================= finish / resume / discard ================= */
function finishFlow() {
  const a = state.active;
  if (!a) return;
  const all = a.exercises.flatMap(ex => ex.sets.map(s => ({ ex, s })));
  const done = all.filter(x => x.s.done);
  const inc = all.length - done.length;
  const vol = done.filter(x => !x.s.isWarmup).reduce((t, x) => t + (x.s.weightKg || 0) * (x.s.reps || 0), 0);
  const body = `<p>${esc(fmtDur((Date.now() - a.startTime) / 1000))} · ${done.length} sets · ${esc(fmtW(vol))} volume</p>` +
    (inc ? `<p class="warnline"><svg class="ic"><use href="#i-warn"/></svg><span>${inc} set${inc > 1 ? 's' : ''} not completed. Finishing will discard them.</span></p>` : '');
  showModal({
    title: 'Finish workout?',
    body,
    actions: [
      { label: inc ? `Discard ${inc} incomplete & finish` : 'Finish & save', primary: true, onClick: () => saveWorkout(done) },
      { label: 'Keep lifting' }
    ]
  });
}

function saveWorkout(donePairs) {
  const a = state.active, end = Date.now();
  const sets = donePairs.map(({ ex, s }) => {
    const row = {
      exerciseId: ex.exerciseId, exerciseName: ex.name, setNumber: s.n,
      weightKg: s.weightKg == null ? 0 : s.weightKg, reps: s.reps == null ? 0 : s.reps,
      isWarmup: !!s.isWarmup, note: s.note || '', pr: !!s.pr
    };
    // Cardio fields are added only on cardio rows, so every existing lifting
    // record keeps exactly the shape the exports and merges already expect.
    if (s.cardio) {
      row.cardio = true;
      row.durationSec = s.durationSec == null ? 0 : s.durationSec;
      if (s.speedKmh != null) row.speedKmh = s.speedKmh;
      if (s.inclinePct != null) row.inclinePct = s.inclinePct;
      if (s.kcal != null) row.kcal = s.kcal;
      row.kcalEstimated = !s.kcalManual;
    }
    return row;
  });
  const rec = {
    id: a.id, templateId: a.templateId, templateName: a.templateName,
    startTime: a.startTime, endTime: end,
    durationSec: Math.round(elapsedMs() / 1000),   // excludes paused time
    sets,
    volumeKg: sets.filter(s => !s.isWarmup).reduce((t, s) => t + s.weightKg * s.reps, 0),
    setCount: sets.length,
    kcal: workoutKcal(sets),
    cardioSec: sets.reduce((t, s) => t + (s.durationSec || 0), 0)
  };
  DB.put('workouts', rec).then(async () => {
    await discardActive();
    state.workouts = (await DB.getAll('workouts')).sort((x, y) => y.startTime - x.startTime);
    rebuildExerciseIndex();
    releaseWake();
    showView('home');
    showCheer('finish', rec.setCount + ' sets · ' + fmtW(rec.volumeKg) +
      (rec.durationSec ? ' · ' + fmtDur(rec.durationSec) : ''));
    backupAfterWorkout();      // fire-and-forget; never blocks, but does report
  });
}

/* ================= custom exercises & body weight ================= */
async function saveCustom() {
  await DB.put('kv', state.custom, 'custom');
  rebuildExerciseIndex();
}
async function saveWeights() {
  // Collapse to one entry per calendar day (latest ts wins) before storing, so
  // storage matches what the chart and export show and self-heals any same-day
  // duplicates -- including ones a cross-device sync merged in by timestamp.
  const byDay = new Map();
  for (const w of state.weights) {
    if (!w || !isFinite(w.kg) || w.ts == null) continue;
    const d = startOfDay(w.ts);
    const cur = byDay.get(d);
    if (!cur || w.ts >= cur.ts) byDay.set(d, w);
  }
  state.weights = [...byDay.values()].sort((a, b) => a.ts - b.ts);
  await DB.put('kv', state.weights, 'weights');
}

/* ================= Google Drive mirror =================
   IndexedDB stays authoritative. Everything here is best-effort: if Drive is
   unreachable, not connected, or errors, the app carries on unchanged. */
function syncPayload() {
  return {
    app: 'LiftLog', schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    workouts: state.workouts,
    customExercises: state.custom,
    bodyWeights: state.weights,
    customTemplates: state.templates
  };
}

/* How long a backup may go stale before the app says so on the Home screen.
   Two days: long enough that a rest day or a flat battery is not an alarm,
   short enough that a silently dead backup is caught within one training week
   rather than discovered when a phone is lost. */
const BACKUP_STALE_MS = 2 * DAY;

/* True when Drive is connected but the backup is not actually working: either
   the last attempt failed in a way only a tap can fix, or nothing has succeeded
   in BACKUP_STALE_MS. This is what turns a silent failure into a visible one. */
function backupUnhealthy() {
  if (!sync.isConnected()) return false;
  if (sync.needsAuth()) return true;
  const last = sync.lastSync();
  return last == null || (Date.now() - last) > BACKUP_STALE_MS;
}

/* pull -> merge all three -> push. Done here rather than inside sync.js so the
   transport stays ignorant of record types and every merge stays union-only.

   `opts.interactive` is passed only by things the user tapped. An automatic
   sync must stay silent -- a Google popup with no user gesture is blocked by
   the browser anyway -- but when the silent path fails the failure is now
   recorded and surfaced instead of being swallowed. */
async function backgroundSync(opts) {
  if (!sync.isConnected()) return { ok: false, reason: 'not-connected' };
  const interactive = !!(opts && opts.interactive);
  /* An automatic sync stops here once we know only a tap can fix the sign-in.
     sync.js enforces this too, but doing it here as well means the whole
     pull/merge/push cycle is skipped rather than run and thrown away, and it
     keeps every one of the eight automatic callers honest without each having
     to remember the check. */
  if (!interactive && sync.needsAuth()) return { ok: false, reason: 'needs-auth' };

  const remote = await sync.pull({ interactive });  // null on failure/offline
  const beforeW = state.workouts.length;

  const workouts = mergeWorkouts(state.workouts, remote && remote.workouts);
  const custom   = mergeCustomExercises(state.custom, remote && remote.customExercises);
  const weights  = mergeBodyWeights(state.weights, remote && remote.bodyWeights);
  const tpls     = mergeCustomTemplates(state.templates, remote && remote.customTemplates);

  // Persist only what this device was missing; a union can never shrink.
  const haveW = new Set(state.workouts.map(w => w.id));
  for (const w of workouts) if (!haveW.has(w.id)) await DB.put('workouts', w);
  state.workouts = workouts.slice().sort((x, y) => y.startTime - x.startTime);

  if (custom.length !== state.custom.length) { state.custom = custom; await saveCustom(); }
  if (weights.length !== state.weights.length) { state.weights = weights; await saveWeights(); }
  // Templates compare by JSON, not length: a rename arriving from another
  // device changes content without changing the count.
  if (JSON.stringify(tpls) !== JSON.stringify(state.templates)) {
    state.templates = tpls; await saveTemplates();
  }
  rebuildExerciseIndex();

  const pushed = await sync.push(syncPayload(), { interactive }); // resolves even on failure

  const gained = state.workouts.length - beforeW;
  if (gained > 0) {
    if (state.view === 'home') renderHome();
    else if (state.view === 'history') renderHistory();
    toast('Restored ' + gained + ' workout(s) from Drive');
  }
  renderDrive();
  // Home carries the backup warning, so it has to repaint when health changes.
  if (state.view === 'home' && gained <= 0) renderHome();
  return { ok: !!pushed, reason: pushed ? null : (sync.lastError() || 'push-failed') };
}

/* Automatic sync that is allowed to complain. Used after a workout is saved --
   the one moment where a failed backup matters most and where, until now, the
   failure was completely invisible because the status listener only rendered
   while Settings was on screen.

   Offline is not an error worth a toast: it is expected in a basement gym and
   the next sync will pick it up. Anything else gets one line. */
async function backupAfterWorkout() {
  const r = await backgroundSync();
  if (r.ok || !sync.isConnected()) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  toast(sync.needsAuth()
    ? 'Backup needs reconnecting — Settings › Sync now'
    : 'Backup failed — your workout is saved on this phone');
}

/* Show which build is actually running. The service-worker cache name carries
   the deploy stamp, so this reports the build being *served*, not the one that
   was deployed -- which is exactly what you need when a stale worker is
   suspected. */
async function renderBuildStamp() {
  const el = $('#build-stamp');
  if (!el) return;
  let v = 'unknown';
  try {
    const keys = await caches.keys();
    const hit = keys.find(k => k.startsWith('liftlog-v'));
    if (hit) v = hit.replace('liftlog-v', '');
  } catch (e) { /* caches unavailable */ }
  el.textContent = 'LiftLog · build ' + v;
}

function renderDrive() {
  renderBuildStamp();
  const on = sync.isConnected();
  const last = sync.lastSync();
  $('#drive-connect').hidden = on;
  $('#drive-sync').hidden = !on;
  $('#drive-disconnect').hidden = !on;

  /* "Connected · last backed up 6 days ago" was indistinguishable from a
     working backup, because nothing else ever contradicted it. State the
     verdict first, and name the raw failure code -- a friendly message that
     never says what broke is how this went unnoticed for a week. */
  const box = $('#drive-state');
  if (!on) { box.textContent = 'Not connected.'; box.classList.remove('warnline'); return; }
  const when = last ? 'Last backed up ' + relTime(last).toLowerCase() + '.' : 'Never backed up yet.';
  const bad = backupUnhealthy();
  box.classList.toggle('warnline', bad);
  const code = sync.lastError();
  if (sync.needsAuth()) {
    box.innerHTML = '<strong>Backup is not working.</strong> Google sign-in has expired — ' +
      'tap <strong>Sync now</strong> to reconnect. ' + esc(when) +
      (code ? '<br><span class="muted small">Reason: ' + esc(code) + '</span>' : '');
  } else if (bad) {
    box.innerHTML = '<strong>Backup is behind.</strong> ' + esc(when) +
      ' Tap <strong>Sync now</strong>.' +
      (code ? '<br><span class="muted small">Reason: ' + esc(code) + '</span>' : '');
  } else {
    box.textContent = 'Connected · ' + when.charAt(0).toLowerCase() + when.slice(1);
  }
}

function promptResume(a) {
  const doneCount = a.exercises.reduce((t, ex) => t + ex.sets.filter(s => s.done).length, 0);
  showModal({
    title: 'Resume workout?',
    body: `<p><strong>${esc(a.templateName)}</strong> — started ${esc(relTime(a.startTime))}, ${doneCount} set${doneCount === 1 ? '' : 's'} done.</p>`,
    actions: [
      {
        label: 'Resume', primary: true, onClick: () => {
          state.active = a;
          if (a.restEnd && a.restEnd > Date.now()) {
            rest.end = a.restEnd; rest.fired = false;
            $('#restbar').hidden = false;
            clearInterval(rest.iv); rest.iv = setInterval(restTick, 250);
          }
          reopenActive();
        }
      },
      {
        label: 'Discard', danger: true, onClick: () => showModal({
          title: 'Discard in-progress workout?',
          body: '<p>This in-progress workout will be removed. Saved workout history is not affected.</p>',
          actions: [
            { label: 'Keep it' },
            {
              label: 'Discard', danger: true, onClick: async () => {
                await discardActive();
                renderHome(); showView('home');
                toast('Workout discarded');
              }
            }
          ]
        })
      }
    ]
  });
}

/* ================= exercise detail sheet ================= */
function openSheet(html) {
  $('#sheet-inner').innerHTML = html;
  $('#sheet-wrap').hidden = false;
  $('#sheet').scrollTop = 0;
}
function closeSheet() { $('#sheet-wrap').hidden = true; }

function exerciseHistoryHTML(exId) {
  const sessions = [];
  for (const w of state.workouts) {
    const ss = w.sets.filter(s => s.exerciseId === exId);
    if (!ss.length) continue;
    const working = ss.filter(s => !s.isWarmup);
    const e1s = working.map(s => e1rm(s.weightKg, s.reps)).filter(v => v != null);
    sessions.push({
      ts: w.startTime, date: fmtDate(w.startTime), sets: ss,
      best: e1s.length ? Math.max(...e1s) : null,
      top: working.length ? Math.max(...working.map(s => s.reps)) : 0
    });
  }
  if (!sessions.length) return '<p class="muted">No history for this exercise yet.</p>';
  const list = sessions.slice(0, 12).map(sn =>
    `<div class="exh"><span class="exh-date">${esc(sn.date)}</span>
     <span class="exh-sets">${esc(sn.sets.map(s => `${s.weightKg > 0 ? fmtNum(dispKg(s.weightKg)) + ' × ' : ''}${s.reps}${s.isWarmup ? ' (wu)' : ''}`).join(' · '))}</span></div>`).join('');
  const hasE = sessions.some(s => s.best != null);
  const pts = sessions.slice(0, 20).reverse().map(sn => ({ x: sn.ts, y: hasE ? (sn.best ?? 0) : sn.top })).filter(p => p.y > 0);
  const label = hasE ? `Best estimated 1RM per session (${unit})` : 'Best set reps per session';
  const fmtY = hasE ? (v => fmtNum(dispKg(v))) : (v => String(Math.round(v)));
  return list + trendSVG(pts, fmtY, label);
}

/* Inline SVG trend line — single series, text-labelled, no colour discrimination needed. */
function trendSVG(pts, fmtY, label) {
  if (pts.length === 0) return '';
  if (pts.length === 1)
    return `<p class="muted">Latest: <strong>${esc(fmtY(pts[0].y))}</strong> on ${esc(fmtDate(pts[0].x))}</p>`;
  const W = 320, H = 150, L = 42, R = 12, T = 18, B = 28;
  const ys = pts.map(p => p.y);
  let mn = Math.min(...ys), mx = Math.max(...ys);
  if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
  const pad = (mx - mn) * 0.12; mn -= pad; mx += pad;
  const X = i => L + (W - L - R) * i / (pts.length - 1);
  const Y = v => T + (H - T - B) * (1 - (v - mn) / (mx - mn));
  const poly = pts.map((p, i) => X(i).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ');
  const dots = pts.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" class="dot"/>`).join('');
  const lbl = i => `<text x="${X(i).toFixed(1)}" y="${(Y(pts[i].y) - 7).toFixed(1)}" class="ax" text-anchor="middle">${esc(fmtY(pts[i].y))}</text>`;
  const marks = pts.length <= 7 ? pts.map((_, i) => lbl(i)).join('') : lbl(pts.length - 1);
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <text x="${L - 4}" y="${(T + 4).toFixed(1)}" class="ax" text-anchor="end">${esc(fmtY(mx - pad))}</text>
    <text x="${L - 4}" y="${(H - B).toFixed(1)}" class="ax" text-anchor="end">${esc(fmtY(mn + pad))}</text>
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="axis"/>
    <polyline points="${poly}" class="line"/>
    ${dots}${marks}
    <text x="${L}" y="${H - 9}" class="ax">${esc(fmtDate(pts[0].x))}</text>
    <text x="${W - R}" y="${H - 9}" class="ax" text-anchor="end">${esc(fmtDate(pts[pts.length - 1].x))}</text>
  </svg><p class="muted chart-cap">${esc(label)}</p>`;
}

function openExerciseSheet(exId, ctx = {}) {
  const ex = resolveExercise(exId, null);
  const yt = ex.video
    ? `<a class="btn yt" href="https://www.youtube.com/watch?v=${esc(ex.video)}" target="_blank" rel="noopener"><svg class="ic"><use href="#i-play"/></svg>Watch on YouTube</a>` : '';
  const tut = ex.tutorial
    ? `<a class="btn" href="https://www.youtube.com/watch?v=${esc(ex.tutorial)}" target="_blank" rel="noopener"><svg class="ic"><use href="#i-play"/></svg>Full technique tutorial</a>` : '';
  const steps = (ex.steps || []).map(st =>
    `<section class="step-sec"><h3>${esc(st.heading)}</h3><p>${esc(st.body)}</p></section>`).join('');
  const alts = (ex.alternatives || []).map(al => {
    const altEx = resolveExercise(slug(al.name), null);
    return `<div class="alt">
      <div class="alt-info"><strong>${esc(al.name)}</strong>
        <a class="mini-link" href="https://www.youtube.com/watch?v=${esc(al.video)}" target="_blank" rel="noopener">Watch<svg class="ic"><use href="#i-play"/></svg></a>
      </div>
      ${ctx.ei != null ? `<button class="btn small" data-alt="${esc(altEx.id)}" data-altname="${esc(al.name)}">Use instead</button>` : ''}
    </div>`;
  }).join('');
  openSheet(`
    <h2>${esc(ex.name)}</h2>
    ${ex.muscle ? `<span class="tag">${esc(ex.muscle)}</span>` : ''}
    <div class="btn-col" style="margin:10px 0">${yt}${tut}</div>
    ${steps ? `<h3 class="sec">How to</h3>${steps}` : ''}
    ${alts ? `<h3 class="sec">Alternatives</h3><div class="alt-list">${alts}</div>` : ''}
    <h3 class="sec">History</h3>
    ${/* Use exId, not ex.exerciseId: `ex` here comes from resolveExercise(),
          i.e. the data.json record, which keys its identifier as `id`.
          `exerciseId` only exists on active-workout entries, so reading it
          here yielded undefined and every exercise reported "no history". */
      exerciseHistoryHTML(exId)}`);
  $$('#sheet-inner [data-alt]').forEach(b => {
    b.onclick = () => openSwapConfirm(ctx.ei, b.dataset.alt, b.dataset.altname);
  });
}

function openGlossary(term) {
  const g = (state.data.program && state.data.program.glossary) || {};
  openSheet(`<h2>${esc(term)}</h2><p>${esc(g[term] || 'No explanation available.')}</p>`);
}

/* ================= history & read-only workout view ================= */
/* One-line summary for a saved workout. Volume is dropped when the session was
   pure cardio -- "0 kg volume" reads as a bug, not as information. */
function workoutMeta(w) {
  const k = w.kcal || 0;
  const bits = [fmtDur(w.durationSec)];
  if (w.volumeKg > 0) bits.push(fmtW(w.volumeKg));
  bits.push(w.setCount + ' set' + (w.setCount === 1 ? '' : 's'));
  if (k > 0) bits.push(k + ' kcal');
  return bits.join(' · ');
}

function renderHistory() {
  const groups = {};
  for (const w of state.workouts) {
    const d = new Date(w.startTime);
    const k = d.getFullYear() + '-' + String(d.getMonth()).padStart(2, '0');
    (groups[k] = groups[k] || []).push(w);
  }
  const keys = Object.keys(groups).sort().reverse();
  $('#history-body').innerHTML = keys.map(k => {
    const [y, m] = k.split('-');
    return `<h2 class="sec">${MONTHS[+m]} ${y}</h2><div class="list">` +
      groups[k].map(w =>
        `<button class="hist-item" data-wod="${esc(w.id)}">
          <span class="hi-date">${esc(fmtDate(w.startTime))}</span>
          <span class="hi-name">${esc(w.templateName)}</span>
          <span class="hi-meta">${esc(workoutMeta(w))}</span>
        </button>`).join('') + '</div>';
  }).join('') || '<p class="muted pad-s">No workouts logged yet.</p>';
}

function openWod(id) {
  const w = state.workouts.find(x => x.id === id);
  if (!w) return;
  state.wodId = id;
  $('#wod-title').textContent = fmtDate(w.startTime);
  const order = [], map = {};
  for (const s of w.sets) {
    if (!map[s.exerciseId]) { map[s.exerciseId] = []; order.push(s.exerciseId); }
    map[s.exerciseId].push(s);
  }
  $('#wod-body').innerHTML =
    `<div class="wod-sum">${esc(w.templateName)} · ${esc(workoutMeta(w))}</div>` +
    `<button class="addex" id="wod-save-tpl"><svg class="ic"><use href="#i-plus"/></svg>Save as template</button>` +
    order.map(exId => {
      const sets = map[exId];
      const cardio = sets.some(s => s.cardio);
      const body = cardio
        // Cardio prints as one line per interval: the weight/reps columns would
        // be two dashes and a zero.
        ? sets.map(s => `<div class="ro-cardio">
            <span class="ro-n">${s.setNumber}</span>
            <span>${esc(fmtCardio(s))}${s.kcalEstimated && s.kcal ? ' <span class="cr-est">est.</span>' : ''}</span>
            ${s.note ? `<span class="ro-note">Note: ${esc(s.note)}</span>` : ''}
          </div>`).join('')
        : `<div class="ro-grid" style="margin-top:6px"><span class="ro-h">SET</span><span class="ro-h">WEIGHT</span><span class="ro-h">REPS</span></div>` +
          sets.map(s => `<div class="ro-grid ro-row${s.isWarmup ? ' warmup' : ''}">
            <span>${s.setNumber}${s.isWarmup ? ' <span class="badge warm">Warm-up</span>' : ''}${s.pr ? ' <span class="badge pr"><svg class="ic"><use href="#i-trophy"/></svg>PR</span>' : ''}</span>
            <span>${s.weightKg > 0 ? esc(fmtW(s.weightKg)) : '—'}</span>
            <span>${s.reps}</span>
            ${s.note ? `<span class="ro-note">Note: ${esc(s.note)}</span>` : ''}
          </div>`).join('');
      return `<article class="ex-card${cardio ? ' cardio-card' : ''}">
        <header class="ex-head"><span class="ex-name" style="cursor:default"><span>${esc(sets[0].exerciseName)}</span></span></header>
        ${body}
      </article>`;
    }).join('');
  $('#wod-save-tpl').onclick = () => saveWorkoutAsTemplate(w);
  showView('wod');
}

/* Turn a logged workout into a reusable template. The name is asked for up
   front because the workout's own name ("Upper Body 1", "Custom workout") is
   rarely what the user wants the template called. */
function saveWorkoutAsTemplate(w) {
  showModal({
    title: 'Save as template',
    body: '<label class="fld"><span>Template name</span>' +
      '<input id="tpl-nm" class="inp wide" type="text" autocomplete="off" value="' +
      esc(w.templateName || '') + '"></label>' +
      '<p class="muted small">Exercises and set counts are copied from this workout. ' +
      'Warm-up sets are not counted.</p>',
    actions: [
      { label: 'Cancel' },
      { label: 'Save template', primary: true, onClick: () => {
          const v = validateTemplateName($('#tpl-nm').value);
          if (!v.ok) { toast(v.error || 'Give it a name'); return false; }
          const tpl = templateFromWorkout(w, v.name, { now: Date.now() });
          state.templates = state.templates.concat([tpl]);
          saveTemplates().then(() => backgroundSync());
          toast('Saved "' + tpl.name + '"');
        } }
    ]
  });
}

/* ================= template editor ================= */
/* Edits a draft copy and commits on Save, so backing out of a half-finished
   edit cannot leave a mangled template behind. */
let tplDraft = null;

function openTemplateEditor(tplId) {
  const existing = tplId ? state.templates.find(t => t.id === tplId) : null;
  tplDraft = existing ? JSON.parse(JSON.stringify(existing))
                      : newTemplate('', { now: Date.now() });
  renderTemplateEditor(!!existing);
}

function tplField(cls, label, value, hint, i) {
  return `<label class="tpl-f"><span>${esc(label)}</span>
    <input class="inp ${cls}" type="text" value="${esc(value)}" placeholder="${esc(hint)}"
      data-i="${i}" autocomplete="off" aria-label="${esc(label)}"></label>`;
}

function templateEditorRowsHTML() {
  if (!tplDraft.exercises.length)
    return '<p class="muted pad-s">No exercises yet — add one below.</p>';
  return tplDraft.exercises.map((e, i) => {
    // A cardio row prescribes minutes; reps and rest mean nothing for it.
    const fields = e.cardio
      ? tplField('tf-dur', 'MINUTES', dispMin(e.durationSec), '30', i)
      : tplField('tf-reps', 'REPS', e.reps, '8-12', i) +
        tplField('tf-rest', 'REST', e.rest, '2-3 min', i);
    return `
    <div class="tpl-ex" data-i="${i}">
      <div class="tpl-ex-main">
        <strong>${esc(e.name)}</strong>
        ${e.cardio ? '<span class="muted small">Cardio — logged by time</span>' : ''}
      </div>
      <div class="tpl-ex-fields">${fields}</div>
      <div class="tpl-ex-sets">
        <button class="btn tiny" data-te="dec" aria-label="Fewer sets"><svg class="ic"><use href="#i-minus"/></svg></button>
        <span class="tpl-ex-n">${e.sets}<span class="muted small"> ${e.cardio ? (e.sets === 1 ? 'interval' : 'intervals') : 'sets'}</span></span>
        <button class="btn tiny" data-te="inc" aria-label="More sets"><svg class="ic"><use href="#i-plus"/></svg></button>
      </div>
      <div class="tpl-ex-ord">
        <button class="btn tiny" data-te="up" aria-label="Move up"${i === 0 ? ' disabled' : ''}><svg class="ic"><use href="#i-up"/></svg></button>
        <button class="btn tiny" data-te="down" aria-label="Move down"${i === tplDraft.exercises.length - 1 ? ' disabled' : ''}><svg class="ic"><use href="#i-down"/></svg></button>
        <button class="btn tiny danger" data-te="del" aria-label="Remove ${esc(e.name)}">Remove</button>
      </div>
    </div>`;
  }).join('');
}

/* Read every reps / rest / minutes field in the editor back into the draft.
   Called before anything that re-renders the list or saves, so a value typed
   and not blurred is never silently dropped. */
function commitTplFields() {
  if (!tplDraft) return;
  const now = Date.now();
  for (const el of $$('#tpl-ex-list .tf-reps'))
    tplDraft = tplSetReps(tplDraft, +el.dataset.i, el.value, { now });
  for (const el of $$('#tpl-ex-list .tf-rest'))
    tplDraft = tplSetRest(tplDraft, +el.dataset.i, el.value, { now });
  for (const el of $$('#tpl-ex-list .tf-dur')) {
    const sec = parseMin(el.value);
    if (sec != null) tplDraft = tplSetDuration(tplDraft, +el.dataset.i, sec, { now });
  }
}

function renderTemplateEditor(isExisting) {
  openSheet(
    '<h2>' + (isExisting ? 'Edit template' : 'New template') + '</h2>' +
    '<label class="fld"><span>Name</span><input id="tpl-name" class="inp wide" type="text" ' +
    'autocomplete="off" placeholder="e.g. Push Day" value="' + esc(tplDraft.name) + '"></label>' +
    '<div id="tpl-ex-list" class="tpl-ex-list">' + templateEditorRowsHTML() + '</div>' +
    '<button class="btn" id="tpl-add"><svg class="ic"><use href="#i-plus"/></svg>Add exercise</button>' +
    '<div class="tpl-actions">' +
      '<button class="btn primary" id="tpl-save">Save template</button>' +
      (isExisting ? '<button class="btn danger" id="tpl-del">Delete template</button>' : '') +
    '</div>');

  // Keep whatever has been typed when the list re-renders.
  const nameEl = $('#tpl-name');
  nameEl.addEventListener('input', () => { tplDraft.name = nameEl.value; });

  $('#tpl-ex-list').onclick = e => {
    const b = e.target.closest('[data-te]');
    if (!b) return;
    // Whatever is half-typed in the reps/rest/minutes fields is committed
    // first, so reordering or adding a set never discards it.
    commitTplFields();
    const i = +b.closest('.tpl-ex').dataset.i;
    const now = Date.now();
    const act = b.dataset.te;
    if (act === 'inc')  tplDraft = tplSetSets(tplDraft, i, tplDraft.exercises[i].sets + 1, { now });
    if (act === 'dec')  tplDraft = tplSetSets(tplDraft, i, tplDraft.exercises[i].sets - 1, { now });
    if (act === 'del')  tplDraft = tplRemoveExercise(tplDraft, i, { now });
    if (act === 'up')   tplDraft = tplMoveExercise(tplDraft, i, i - 1, { now });
    if (act === 'down') tplDraft = tplMoveExercise(tplDraft, i, i + 1, { now });
    $('#tpl-ex-list').innerHTML = templateEditorRowsHTML();
  };

  // Committed on change (blur / keyboard done) rather than on every keystroke:
  // each setter returns a fresh template, and re-reading the list mid-type
  // would fight the field the user is still in.
  $('#tpl-ex-list').addEventListener('change', ev => {
    if (!ev.target.classList.contains('inp')) return;
    commitTplFields();
  });

  $('#tpl-add').onclick = () => {
    commitTplFields();
    openExercisePicker('Add to template', exId => {
      const ex = resolveExercise(exId, null);
      tplDraft = tplAddExercise(tplDraft, {
        id: exId, name: (ex && ex.name) || exId, cardio: isCardio(ex)
      }, { now: Date.now() });
      renderTemplateEditor(isExisting);
    });
  };

  $('#tpl-save').onclick = () => {
    commitTplFields();
    const v = validateTemplateName(tplDraft.name);
    if (!v.ok) { toast(v.error || 'Give it a name'); return; }
    if (!tplDraft.exercises.length) { toast('Add at least one exercise'); return; }
    const now = Date.now();
    const saved = renameTemplate(tplDraft, v.name, { now });
    const i = state.templates.findIndex(t => t.id === saved.id);
    state.templates = i >= 0
      ? state.templates.map(t => (t.id === saved.id ? saved : t))
      : state.templates.concat([saved]);
    saveTemplates().then(() => backgroundSync());
    closeSheet();
    renderHome();
    toast('Saved "' + saved.name + '"');
  };

  if (isExisting) $('#tpl-del').onclick = () => {
    const id = tplDraft.id, nm = tplDraft.name;
    showModal({
      title: 'Delete template?',
      body: '<p>Delete <strong>' + esc(nm) + '</strong>? Workouts you already logged from it are kept.</p>',
      actions: [
        { label: 'Cancel' },
        { label: 'Delete template', danger: true, onClick: () => {
            state.templates = state.templates.filter(t => t.id !== id);
            saveTemplates().then(() => backgroundSync());
            closeSheet();
            renderHome();
            toast('Deleted "' + nm + '"');
          } }
      ]
    });
  };
}

function deleteCurrentWod() {
  const w = state.workouts.find(x => x.id === state.wodId);
  if (!w) return;
  showModal({
    title: 'Delete workout?',
    body: `<p>Delete <strong>${esc(fmtDate(w.startTime))} — ${esc(w.templateName)}</strong>? This cannot be undone.</p>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Delete workout', danger: true, onClick: async () => {
          await DB.del('workouts', w.id);
          state.workouts = state.workouts.filter(x => x.id !== w.id);
          toast('Workout deleted');
          showView('history');
        }
      }
    ]
  });
}

/* ================= modal & toast ================= */
/* Bumped on every showModal. An action whose handler opens a *further* modal
   (confirm-a-confirm) must not then be closed by the parent's handler --
   otherwise the second dialog is created and hidden in the same tick and the
   user never sees it, which silently broke Delete set, Discard workout and
   Clear all data. */
let modalSeq = 0;

function showModal({ title, body = '', actions = [] }) {
  const gen = ++modalSeq;
  const w = $('#modal-wrap');
  w.hidden = false;
  $('#modal').innerHTML = `<h2>${esc(title)}</h2><div class="modal-body">${body}</div><div class="modal-actions"></div>`;
  const act = $('#modal .modal-actions');
  actions.forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : '');
    b.textContent = a.label;
    b.onclick = () => {
      // returning false from onClick keeps the modal open (used for inline validation)
      if (a.onClick && a.onClick() === false) return;
      // If the handler opened another modal, leave that one on screen.
      if (modalSeq !== gen) return;
      closeModal();
    };
    act.appendChild(b);
  });
  $('#modal-backdrop').onclick = closeModal;
}
function closeModal() { $('#modal-wrap').hidden = true; }

let toastT = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ================= export / import / clear ================= */
function download(name, mime, text) {
  const u = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const sortedAsc = () => [...state.workouts].sort((a, b) => a.startTime - b.startTime);

function exportCSV() {
  // Cardio columns are appended, never inserted: anything already parsing this
  // export by column position keeps working.
  const rows = [['date','workout','exercise','set_number','is_warmup','weight_kg','weight_display','unit','reps','estimated_1rm','notes',
                 'is_cardio','duration_sec','speed_kmh','incline_pct','kcal','kcal_estimated']];
  for (const w of sortedAsc())
    for (const s of w.sets) {
      const e = e1rm(s.weightKg, s.reps);
      rows.push([
        new Date(w.startTime).toISOString().slice(0, 10), w.templateName, s.exerciseName,
        s.setNumber, s.isWarmup ? 'true' : 'false',
        s.weightKg ?? 0, dispKg(s.weightKg ?? 0) ?? 0, unit, s.reps ?? 0,
        e == null ? '' : e.toFixed(2), s.note || '',
        s.cardio ? 'true' : 'false',
        s.durationSec ?? '', s.speedKmh ?? '', s.inclinePct ?? '', s.kcal ?? '',
        s.cardio ? (s.kcalEstimated ? 'true' : 'false') : ''
      ]);
    }
  const csv = rows.map(r => r.map(v => {
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\n');
  download(`liftlog-${stamp()}.csv`, 'text/csv', csv);
  toast('CSV exported');
}

function exportMD() {
  let out = '# LiftLog export\n\n';
  for (const w of sortedAsc()) {
    out += `## ${fmtDate(w.startTime)} — ${w.templateName}

`;
    out += `${workoutMeta(w)}

`;
    out += '| Set | Exercise | Weight | Reps | Notes |\n|---|---|---|---|---|\n';
    for (const s of w.sets)
      out += s.cardio
        ? `| ${s.setNumber} | ${s.exerciseName} | ${fmtCardio(s)} | — | ${s.note || ''} |
`
        : `| ${s.setNumber}${s.isWarmup ? ' (warm-up)' : ''}${s.pr ? ' ★PR' : ''} | ${s.exerciseName} | ${s.weightKg > 0 ? fmtW(s.weightKg) : '—'} | ${s.reps} | ${s.note || ''} |
`;
    out += '\n';
  }
  download(`liftlog-${stamp()}.md`, 'text/markdown', out);
  toast('Markdown exported');
}

function exportTXT() {
  let out = 'LiftLog export\n==============\n\n';
  for (const w of sortedAsc()) {
    out += `${fmtDate(w.startTime)} — ${w.templateName}
`;
    out += `${workoutMeta(w)}
`;
    for (const s of w.sets)
      out += s.cardio
        ? `  Set ${s.setNumber}: ${s.exerciseName} — ${fmtCardio(s)}${s.note ? ' — ' + s.note : ''}
`
        : `  Set ${s.setNumber}${s.isWarmup ? ' (warm-up)' : ''}${s.pr ? ' [PR]' : ''}: ${s.exerciseName} — ${s.weightKg > 0 ? fmtW(s.weightKg) + ' x ' : ''}${s.reps} reps${s.note ? ' — ' + s.note : ''}
`;
    out += '\n';
  }
  download(`liftlog-${stamp()}.txt`, 'text/plain', out);
  toast('TXT exported');
}

function exportJSON() {
  /* schemaVersion 2 -- the same four record types the Drive mirror carries.
     Version 1 backups held workouts only, which meant a restore silently lost
     every custom exercise, custom template and body-weight entry. Importing a
     v1 file still works: the extra keys are simply absent. */
  const payload = {
    app: 'LiftLog', schemaVersion: 2, exportedAt: new Date().toISOString(),
    workouts: state.workouts,
    customExercises: state.custom,
    customTemplates: state.templates,
    bodyWeights: state.weights,
    settings: { unit, theme: prefs.theme, defaultRest: prefs.defaultRest, swaps: prefs.swaps }
  };
  download(`liftlog-backup-${stamp()}.json`, 'application/json', JSON.stringify(payload, null, 2));
  toast('Backup exported');
}

function importJSON(file) {
  file.text().then(txt => {
    let j;
    try { j = JSON.parse(txt); } catch { toast('Could not read that file'); return; }
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.workouts) ? j.workouts : null);
    if (!arr) { toast('Not a LiftLog backup'); return; }
    const valid = arr.filter(w => w && w.id && Array.isArray(w.sets) && w.startTime);
    const have = new Set(state.workouts.map(w => w.id));
    const fresh = valid.filter(w => !have.has(w.id)); // merge by id — never replace
    /* Exercises, templates and body weights ride along in schemaVersion 2
       files. Merged with the same union-only functions the Drive sync uses, so
       an import can no more delete something than a sync can. */
    const exs  = mergeCustomExercises(state.custom, j.customExercises);
    const tpls = mergeCustomTemplates(state.templates, j.customTemplates);
    const wts  = mergeBodyWeights(state.weights, j.bodyWeights);
    const extra = (exs.length - state.custom.length) + (tpls.length - state.templates.length) +
                  (wts.length - state.weights.length);
    if (!fresh.length && extra <= 0) { toast('Nothing new — everything is already here'); return; }
    const dates = fresh.map(w => fmtDate(w.startTime)).sort();
    const range = fresh.length ? ` (${esc(dates[0])} → ${esc(dates[dates.length - 1])})` : '';
    showModal({
      title: 'Import backup',
      body: `<p>Add <strong>${fresh.length}</strong> workout${fresh.length === 1 ? '' : 's'}${range}` +
        (extra > 0 ? ` and <strong>${extra}</strong> exercise/template/weight record${extra === 1 ? '' : 's'}` : '') + `?</p>
        <p class="muted">${valid.length - fresh.length} duplicate${valid.length - fresh.length === 1 ? '' : 's'} will be skipped. Existing data is never replaced.</p>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Import', primary: true, onClick: async () => {
            for (const w of fresh) await DB.put('workouts', w);
            state.workouts = (await DB.getAll('workouts')).sort((a, b) => b.startTime - a.startTime);
            if (exs.length !== state.custom.length) { state.custom = exs; await saveCustom(); }
            if (tpls.length !== state.templates.length) { state.templates = tpls; await saveTemplates(); }
            if (wts.length !== state.weights.length) { state.weights = wts; await saveWeights(); }
            rebuildExerciseIndex();
            toast(`Imported ${fresh.length} workout${fresh.length === 1 ? '' : 's'}`);
            if (state.view === 'home') renderHome();
            if (state.view === 'history') renderHistory();
          }
        }
      ]
    });
  });
}

function clearAllFlow() {
  showModal({
    title: 'Clear all data?',
    body: '<p>This permanently deletes every logged workout on this device. Export a backup first if in doubt.</p>',
    actions: [
      { label: 'Cancel' },
      {
        label: 'Continue', danger: true, onClick: () => showModal({
          title: 'Type DELETE to confirm',
          body: '<input id="del-in" class="inp wide" type="text" autocomplete="off" autocapitalize="characters" placeholder="DELETE">',
          actions: [
            { label: 'Cancel' },
            {
              label: 'Delete everything', danger: true, onClick: () => {
                if ($('#del-in').value.trim() !== 'DELETE') { toast('Type DELETE exactly to confirm'); return false; }
                (async () => {
                  await DB.clear('workouts');
                  await discardActive();
                  state.workouts = [];
                  toast('All data cleared'); showView('home');
                })();
              }
            }
          ]
        })
      }
    ]
  });
}

/* ================= settings ================= */
function renderSettings() {
  $$('#seg-unit button').forEach(b => b.classList.toggle('on', b.dataset.v === unit));
  $$('#seg-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.theme));
  $('#opt-rest').checked = prefs.defaultRest;
  $('#opt-wake').checked = wakeWanted();
  $('#opt-notif').checked = ('Notification' in window) &&
    localStorage.getItem('ll.notif') === '1' && Notification.permission === 'granted';
  renderDrive();
}

/* ================= event wiring ================= */
function wire() {
  $$('#tabbar button').forEach(b => b.onclick = () => showView(b.dataset.v));

  // home
  $('#home-body').addEventListener('click', e => {
    const b = e.target.closest('[data-tpl],[data-wod],[data-tpledit],[data-tplnew]');
    if (!b) return;
    // Edit and create are checked first: the edit control sits beside the card,
    // so a tap that lands on it must not fall through to starting a workout.
    if (b.dataset.tplnew) openTemplateEditor(null);
    else if (b.dataset.tpledit) openTemplateEditor(b.dataset.tpledit);
    else if (b.dataset.tpl) startWorkout(b.dataset.tpl);
    else openWod(b.dataset.wod);
  });

  // history
  $('#history-body').addEventListener('click', e => {
    const b = e.target.closest('[data-wod]');
    if (b) openWod(b.dataset.wod);
  });

  // active workout — one delegated listener for all card interactions
  $('#aw-body').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const card = b.closest('.ex-card');
    const row = b.closest('.set-row');
    const ei = card ? +card.dataset.ei : -1;
    const si = row ? +row.dataset.si : -1;
    if (act === 'detail') openExerciseSheet(state.active.exercises[ei].exerciseId, { ei });
    else if (act === 'cardmenu') cardMenu(ei);
    else if (act === 'gloss') openGlossary(b.dataset.term);
    else if (act === 'check') toggleSet(ei, si);
    else if (act === 'rowmenu') rowMenu(ei, si);
    else if (act === 'addset') addSet(ei);
  });
  // weight/reps edits commit on change (blur / keyboard done) — no re-render, so focus is safe
  $('#aw-body').addEventListener('change', e => {
    const i = e.target;
    const isCardioField = i.classList.contains('d-inp') || i.classList.contains('sp-inp') ||
                          i.classList.contains('in-inp') || i.classList.contains('k-inp');
    if (!isCardioField && !i.classList.contains('w-inp') && !i.classList.contains('r-inp')) return;
    const row = i.closest('.set-row');
    const ex = state.active.exercises[+row.dataset.ei];
    const s = ex.sets[+row.dataset.si];
    if (s.done) return;
    if (isCardioField) {
      readCardioRow(ex, s, row);
      saveActive();
      // Only the calorie field and its "est." marker can change as a result, so
      // repaint that one row rather than the whole view -- a full re-render
      // would steal focus while the number pad is still open.
      const k = row.querySelector('.k-inp');
      if (k && document.activeElement !== k) k.value = s.kcal == null ? '' : s.kcal;
      const est = row.querySelector('.cr-est');
      const wantEst = !s.kcalManual && s.kcal != null;
      if (est && !wantEst) est.remove();
      if (!est && wantEst) row.querySelector('.cr-actions')
        .insertAdjacentHTML('afterbegin', '<span class="cr-est">est.</span>');
      return;
    }
    if (i.classList.contains('w-inp')) {
      const v = parseDisp(i.value);
      s.weightKg = v == null ? null : toKg(v);
    } else {
      const v = parseInt(i.value, 10);
      s.reps = isNaN(v) ? null : v;
    }
    i.classList.remove('pref');
    saveActive();
  });

  // minimised workout bar
  $('#mini-open').onclick = reopenActive;
  $('#mini-finish').onclick = () => { reopenActive(); finishFlow(); };

  // active header
  $('#btn-finish').onclick = finishFlow;
  $('#aw-minimise').onclick = () => showView('home');
  $('#aw-timer').onclick = timerToggle;
  $('#aw-menu').onclick = () => showModal({
    title: 'Workout options',
    actions: [
      {
        label: 'Discard workout', danger: true, onClick: () => showModal({
          title: 'Discard workout?',
          body: '<p>Nothing will be saved. Logged history is unaffected.</p>',
          actions: [
            { label: 'Keep lifting' },
            {
              label: 'Discard', danger: true, onClick: async () => {
                await discardActive();
                showView('home'); toast('Workout discarded');
              }
            }
          ]
        })
      },
      { label: 'Cancel' }
    ]
  });

  // workout detail
  $('#wod-back').onclick = () => showView('history');
  $('#wod-delete').onclick = deleteCurrentWod;

  // sheet & modal
  $('#sheet-close').onclick = closeSheet;
  $('#sheet-backdrop').onclick = closeSheet;
  $('#modal-backdrop').onclick = closeModal;

  // rest bar
  $('#rest-minus').onclick = () => adjustRest(-15);
  $('#rest-plus').onclick = () => adjustRest(15);
  $('#rest-skip').onclick = skipRest;

  // settings
  $$('#seg-unit button').forEach(b => b.onclick = () => {
    unit = b.dataset.v;
    localStorage.setItem('ll.unit', unit);
    renderSettings();
    // re-render whatever is on screen so displayed values convert
    if (state.view === 'active') renderActive();
    else if (state.view === 'home') renderHome();
    else if (state.view === 'history') renderHistory();
    else if (state.view === 'wod') openWod(state.wodId);
  });
  $$('#seg-theme button').forEach(b => b.onclick = () => { prefs.theme = b.dataset.v; renderSettings(); });
  $('#opt-rest').onchange = e => { prefs.defaultRest = e.target.checked; };
  $('#opt-wake').onchange = e => {
    localStorage.setItem('ll.wake', e.target.checked ? '1' : '0');
    if (e.target.checked && state.view === 'active') acquireWake(); else releaseWake();
    if (e.target.checked && !('wakeLock' in navigator)) toast('This browser has no screen lock control');
  };
  $('#opt-notif').onchange = async e => {
    if (!e.target.checked) { localStorage.setItem('ll.notif', '0'); clearRestNotif(); return; }
    const ok = await requestNotif();
    e.target.checked = ok;
  };
  // Google Drive backup
  $('#drive-connect').onclick = async () => {
    $('#drive-state').textContent = 'Opening Google sign-in…';
    const ok = await sync.connect();
    if (!ok) { toast('Could not connect to Drive'); renderDrive(); return; }
    toast('Drive connected');
    await backgroundSync();
  };
  $('#drive-sync').onclick = async () => {
    $('#drive-state').textContent = 'Backing up…';
    // The user tapped, so this one is allowed to raise Google's consent
    // prompt. Without an interactive path here there was no way at all to
    // recover an expired grant short of Disconnect + Connect.
    const r = await backgroundSync({ interactive: true });
    toast(r.ok ? 'Backed up to Drive' : 'Backup failed — see the note above');
  };
  $('#drive-disconnect').onclick = async () => {
    await sync.disconnect();          // clears local flags only; deletes nothing
    toast('Drive disconnected');
    renderDrive();
  };
  sync.onStatus(s => {
    if (state.view !== 'settings') return;
    if (s.state === 'syncing') $('#drive-state').textContent = 'Backing up…';
    else if (s.state === 'offline') $('#drive-state').textContent = 'Offline — will back up later.';
    else if (s.state === 'error') $('#drive-state').textContent = s.message || 'Backup problem — local data is safe.';
    else renderDrive();
  });

  $('#exp-csv').onclick = exportCSV;
  $('#exp-md').onclick = exportMD;
  $('#exp-txt').onclick = exportTXT;
  $('#exp-json').onclick = exportJSON;
  $('#imp-strong').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importStrong(f);
  });
  $('#imp-file').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importJSON(f);
  });
  $('#btn-clear').onclick = clearAllFlow;
}

/* ================= init ================= */
(async function init() {
  applyTheme();
  try { await DB.open(); } catch (e) { /* storage blocked; app will still render read-only */ }
  await loadData();
  state.workouts = (await DB.getAll('workouts')).sort((a, b) => b.startTime - a.startTime);
  state.custom = (await DB.get('kv', 'custom')) || [];
  state.weights = (await DB.get('kv', 'weights')) || [];
  state.templates = (await DB.get('kv', 'templates')) || [];
  rebuildExerciseIndex();
  const act = await DB.get('kv', 'active');
  if (act) state.active = act;
  wire();
  renderSettings();
  showView('home');
  if (act) promptResume(act);
  // Pull anything this device is missing (e.g. a replaced phone). Deferred so
  // it can never delay first paint, and it fails silently when offline.
  // backgroundSync itself declines when the sign-in needs a tap, so a device
  // with a dead grant does no Google work at all on launch.
  setTimeout(backgroundSync, 1200);
  /* Retry a failed backup when the phone comes back -- network returning, or
     the app being brought to the foreground. Without this a backup that failed
     in the gym waited until the *next* workout to try again.

     Rate-limited: this fires on EVERY foreground, and an installed PWA is
     foregrounded constantly. Skipped outright when the failure needs a tap,
     since a silent retry would fail identically. */
  let lastRetry = 0;
  const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
  const retryIfBehind = () => {
    if (!sync.isConnected() || sync.needsAuth()) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!backupUnhealthy()) return;
    if (Date.now() - lastRetry < RETRY_COOLDOWN_MS) return;
    lastRetry = Date.now();
    backgroundSync();
  };
  window.addEventListener('online', retryIfBehind);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) retryIfBehind(); });
  /* Ask for persistent storage -- and keep asking until it is actually
     granted. Chrome refuses this until the app is installed or the site has
     earned enough engagement, so a single fire-and-forget attempt on first run
     usually FAILS and, because the old code recorded a flag regardless of the
     outcome, it never asked again. Without persistence the browser may evict
     training history under storage pressure. */
  (async () => {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      if (await navigator.storage.persisted()) return;   // already durable
      await navigator.storage.persist();                 // retried on every load until granted
    } catch (e) { /* unsupported */ }
  })();
  if ('serviceWorker' in navigator) {
    // updateViaCache:'none' stops the browser serving sw.js from its own HTTP
    // cache -- GitHub Pages sets a max-age, so without this the worker itself
    // could not be re-checked for minutes and the app sat on a stale build.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A brand-new install claims the page too; only reload when an existing
      // worker was *replaced*, otherwise the first visit would loop.
      if (!hadController || reloading) return;
      reloading = true;
      saveActive(true);          // flush the in-progress workout before reloading
      location.reload();
    });

    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(reg => {
        reg.update();
        // Re-check whenever the app is brought back to the foreground, which is
        // how an installed PWA is normally resumed rather than reloaded.
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) reg.update();
        });
      })
      .catch(() => { /* e.g. file:// — app still works */ });
  }
})();


/* ================= Stoic quotes ================= */
const quotesState = { list: null, idx: 0, swipeInit: false };

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

async function loadQuotes() {
  if (quotesState.list) return quotesState.list;   // fetched once, then in memory
  try {
    const res = await fetch('./quotes.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    quotesState.list = Array.isArray(data.quotes) ? data.quotes : [];
  } catch (err) {
    quotesState.list = [];
    toast('Could not load quotes');
  }
  return quotesState.list;
}

function goToQuote(i) {
  const list = quotesState.list;
  if (!list || !list.length) return;
  quotesState.idx = ((i % list.length) + list.length) % list.length;   // wraps both ends
  try { localStorage.setItem('ll.quoteIdx', String(quotesState.idx)); } catch (e) {}
  const q = list[quotesState.idx];
  $('#q-text').textContent = q.text || '';
  $('#q-author').textContent = q.author ? '\u2014 ' + q.author : '';
  $('#q-source').textContent = q.source || '';
  $('#q-pos').textContent = (quotesState.idx + 1) + ' / ' + list.length;
  $('#q-stage').setAttribute('aria-label',
    'Quote ' + (quotesState.idx + 1) + ' of ' + list.length);
}

const stepQuote = dir => goToQuote(quotesState.idx + dir);

function randomQuote() {
  const n = quotesState.list ? quotesState.list.length : 0;
  if (n < 2) return;
  let r;
  do { r = Math.floor(Math.random() * n); } while (r === quotesState.idx);
  goToQuote(r);
}

async function renderQuotes() {
  initQuoteSwipe();
  if (!quotesState.list) {
    const list = await loadQuotes();
    if (!list.length) {
      $('#q-text').textContent = 'No quotes available.';
      $('#q-author').textContent = '';
      $('#q-source').textContent = '';
      $('#q-pos').textContent = '\u2013 / \u2013';
      return;
    }
    let saved = NaN;
    try { saved = parseInt(localStorage.getItem('ll.quoteIdx'), 10); } catch (e) {}
    quotesState.idx = (Number.isInteger(saved) && saved >= 0 && saved < list.length)
      ? saved                                      // resume where the user left off
      : Math.floor(Math.random() * list.length);   // first ever open: random
  }
  goToQuote(quotesState.idx);
}

function initQuoteSwipe() {
  if (quotesState.swipeInit) return;
  quotesState.swipeInit = true;

  const stage = $('#q-stage');
  const track = $('#q-track');
  let pid = null, x0 = 0, y0 = 0, dx = 0, axis = null, tLast = 0, xLast = 0, v = 0;

  stage.addEventListener('pointerdown', e => {
    if (!quotesState.list || !quotesState.list.length) return;
    pid = e.pointerId;
    x0 = xLast = e.clientX; y0 = e.clientY;
    dx = 0; axis = null; v = 0; tLast = performance.now();
    track.classList.remove('q-anim');
    try { stage.setPointerCapture(pid); } catch (err) {}
  });

  stage.addEventListener('pointermove', e => {
    if (pid === null || e.pointerId !== pid) return;
    dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (axis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';   // lock the axis once
      if (axis === 'y') { pid = null; track.style.transform = ''; return; }
    }
    if (axis !== 'x') return;
    const now = performance.now(), dt = now - tLast;
    if (dt > 0) v = (e.clientX - xLast) / dt;            // px/ms, for flick detection
    tLast = now; xLast = e.clientX;
    track.style.transform = 'translateX(' + dx + 'px)';  // card follows the finger
  });

  function finish(e) {
    if (pid === null || (e && e.pointerId !== pid)) return;
    pid = null;
    const w = stage.clientWidth || 1;
    const flick = Math.abs(v) > 0.5 && Math.abs(dx) > 30;
    if (axis === 'x' && (Math.abs(dx) > w * 0.25 || flick)) {
      const dir = dx < 0 ? 1 : -1;
      if (prefersReducedMotion()) {
        stepQuote(dir); track.style.transform = '';
      } else {
        track.classList.add('q-anim');
        track.style.transform = 'translateX(' + (-dir * w) + 'px)';
        setTimeout(() => {
          stepQuote(dir);
          track.classList.remove('q-anim');
          track.style.transform = '';
        }, 210);
      }
    } else {
      track.classList.add('q-anim');                     // spring back
      track.style.transform = '';
      setTimeout(() => track.classList.remove('q-anim'), 210);
    }
    axis = null; dx = 0; v = 0;
  }

  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);

  $('#q-prev').addEventListener('click', () => stepQuote(-1));
  $('#q-next').addEventListener('click', () => stepQuote(1));
  $('#q-shuffle').addEventListener('click', randomQuote);

  document.addEventListener('keydown', e => {
    if (state.view !== 'quotes') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepQuote(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepQuote(1); }
  });
}


/* ================= exercise picker ================= */
/* One picker serves three jobs: adding an exercise to a live workout, starting
   an empty workout, and creating a custom exercise. Rows show how often the
   exercise has actually been logged, so the ones you use surface first. */
function pickerRowsHTML(q) {
  const rows = searchExercises(exIndex, q, { limit: 120 });
  if (!rows.length) return '<p class="muted pad-s">No match. Create it below.</p>';
  return rows.map(x => {
    const tag = [x.muscle || '', x.cardio ? 'time-based' : '',
                 x.custom ? 'custom' : (x.isAlternative ? 'alternative' : '')]
      .filter(Boolean).join(' · ');
    const count = x.timesLogged
      ? '<span class="pick-n">' + x.timesLogged + '\u00d7</span><span class="muted small">' +
        esc(relTime(x.lastLoggedTs).toLowerCase()) + '</span>'
      : '<span class="muted small">never</span>';
    return '<button class="pick-row" data-pick="' + esc(x.id) + '">' +
      '<span class="pick-main"><strong>' + esc(x.name) + '</strong>' +
      '<span class="muted small">' + esc(tag) + '</span></span>' +
      '<span class="pick-meta">' + count + '</span></button>';
  }).join('');
}

function openExercisePicker(title, onPick) {
  openSheet(
    '<h2>' + esc(title) + '</h2>' +
    '<input id="pick-q" class="inp wide" type="search" placeholder="Search exercises\u2026" ' +
    'autocomplete="off" autocapitalize="none" aria-label="Search exercises">' +
    '<div id="pick-list" class="pick-list">' + pickerRowsHTML('') + '</div>' +
    '<button class="btn" id="pick-new"><svg class="ic"><use href="#i-plus"/></svg>Create a new exercise</button>');

  const list = $('#pick-list');
  const wireRows = () => $$('#pick-list [data-pick]').forEach(b => {
    b.onclick = () => { closeSheet(); onPick(b.dataset.pick); };
  });
  wireRows();
  $('#pick-q').addEventListener('input', e => {
    list.innerHTML = pickerRowsHTML(e.target.value);
    wireRows();
  });
  $('#pick-new').onclick = () => openCreateExercise(onPick);
}

function openCreateExercise(onPick) {
  const muscles = ['Chest','Back','Shoulders','Biceps','Triceps','Quads','Hamstrings',
                   'Glutes','Calves','Lower Back','Core','Cardio','Other'];
  // Cardio style decides which fields the set row offers and how calories are
  // estimated: treadmill-shaped work gets speed + incline and the ACSM
  // equations, everything else a flat MET.
  const modes = [
    { v: 'walk',  label: 'Walking / incline walking (speed + incline)', met: 4.3 },
    { v: 'run',   label: 'Running (speed + incline)',                   met: 9.8 },
    { v: 'other', label: 'Machine or activity (time only)',             met: 6.0 }
  ];
  showModal({
    title: 'New exercise',
    body: '<label class="fld"><span>Name</span>' +
      '<input id="nx-name" class="inp wide" type="text" autocomplete="off" placeholder="e.g. Cable Crossover"></label>' +
      '<label class="fld"><span>Muscle group</span><select id="nx-muscle" class="inp wide">' +
      muscles.map(m => '<option>' + esc(m) + '</option>').join('') + '</select></label>' +
      '<label class="fld" id="nx-mode-fld" hidden><span>Cardio style</span><select id="nx-mode" class="inp wide">' +
      modes.map(m => '<option value="' + esc(m.v) + '">' + esc(m.label) + '</option>').join('') + '</select></label>' +
      '<label class="checkline" id="nx-bw-fld"><input type="checkbox" id="nx-bw"> Bodyweight (no weight column)</label>',
    actions: [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: () => {
          const name = $('#nx-name').value.trim();
          if (!name) { toast('Give it a name'); return false; }
          const muscle = $('#nx-muscle').value;
          const cardio = muscle === 'Cardio';
          const mode = cardio ? $('#nx-mode').value : null;
          let ex;
          try {
            ex = makeCustomExercise(name, muscle, {
              bodyweight: $('#nx-bw').checked,
              cardio, mode,
              met: cardio ? (modes.find(m => m.v === mode) || {}).met : undefined
            });
          } catch (e) { toast('Give it a name'); return false; }
          if (exIndex.some(x => x.id === ex.id)) { toast('That exercise already exists'); return false; }
          state.custom = state.custom.concat([ex]);
          // Rebuild synchronously: onPick runs on this tick and looks the new
          // exercise up in the index, so an async rebuild would miss it and the
          // card would show the raw slug instead of the name.
          rebuildExerciseIndex();
          saveCustom().then(() => { backgroundSync(); });
          closeSheet();
          if (onPick) onPick(ex.id);
          toast('Created ' + ex.name);
        } }
    ]
  });
  // Wired after showModal has put the body in the DOM.
  const mus = $('#nx-muscle');
  const syncMode = () => {
    const c = mus.value === 'Cardio';
    $('#nx-mode-fld').hidden = !c;
    $('#nx-bw-fld').hidden = c;   // cardio never has a weight column anyway
  };
  mus.addEventListener('change', syncMode);
  syncMode();
}

/* Build a workout-exercise entry for something that has no template row. */
function adHocEx(exId) {
  const meta = exIndex.find(x => x.id === exId) || {};
  const cardio = !!meta.cardio;
  return withKcal(makeEx({
    id: exId, name: meta.name || exId,
    // One interval by default: a cardio "3 sets" is almost never what is meant.
    sets: cardio ? 1 : 3,
    reps: '8-12', rest: '2 min',
    superset: null, efforts: [],
    cardio, durationSec: cardio ? 1800 : null
  }, null));
}

function addExerciseToActive(exId) {
  if (!state.active) return;
  state.active.exercises.push(adHocEx(exId));
  saveActive(true);
  renderActive();
  toast('Added');
}

function startEmptyWorkout() {
  if (state.active) { promptResume(state.active); return; }
  state.active = {
    key: 'current', id: uid(), templateId: null, templateName: 'Custom workout',
    startTime: Date.now(), restEnd: 0,
    elapsedMs: 0, runningSince: null, everStarted: false,
    exercises: []
  };
  saveActive(true);
  buildActiveHeader();
  renderActive();
  showView('active');
  showCheer('start', 'Custom workout', () => openExercisePicker('Add your first exercise', addExerciseToActive));
}

/* ================= stats: heatmap + body weight ================= */
function renderStats() {
  const el = $('#stats-body');
  if (!el) return;
  const series = bodyWeightSeries(state.weights);
  const goal = parseFloat(localStorage.getItem('ll.wgoal') || '');
  const latest = series.points.length ? series.points[series.points.length - 1] : null;

  el.innerHTML =
    '<h2 class="sec">Activity</h2>' +
    '<div class="hm-wrap">' + heatmapSVG(state.workouts, { endTs: Date.now() }) + '</div>' +
    '<h2 class="sec">Body weight</h2>' +
    '<div class="bw-head">' +
      '<strong>' + (latest ? esc(fmtW(latest.kg)) : '\u2014') + '</strong>' +
      (series.change != null
        ? '<span class="muted small">' + (series.change > 0 ? '+' : '') +
          esc(fmtNum(dispKg(Math.abs(series.change)) * (series.change < 0 ? -1 : 1))) +
          ' ' + esc(unit) + ' since ' + esc(fmtDate(series.first.ts)) + '</span>'
        : series.points.length
          ? '<span class="muted small">Logged ' + esc(relTime(latest.ts).toLowerCase()) +
            ' · log another day to see a trend</span>'
          : '<span class="muted small">No entries yet</span>') +
    '</div>' +
    '<div class="bw-wrap">' +
      bodyWeightSVG(state.weights, {
        goalKg: isFinite(goal) ? goal : undefined,
        unit, convert: dispKg
      }) +
    '</div>' +
    '<div class="btn-col">' +
      '<button class="btn primary" id="bw-log"><svg class="ic"><use href="#i-plus"/></svg>Log body weight</button>' +
      '<button class="btn" id="bw-goal">' + (isFinite(goal) ? 'Goal: ' + esc(fmtW(goal)) : 'Set a goal weight') + '</button>' +
    '</div>';

  $('#bw-log').onclick = openLogWeight;
  $('#bw-goal').onclick = openGoalWeight;
}

function openLogWeight() {
  const series = bodyWeightSeries(state.weights);
  const last = series.points.length ? dispKg(series.points[series.points.length - 1].kg) : '';
  showModal({
    title: 'Log body weight',
    body: '<label class="fld"><span>Weight (' + esc(unit) + ')</span>' +
      '<input id="bw-in" class="inp wide" type="text" inputmode="decimal" value="' + esc(last) + '"></label>',
    actions: [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: () => {
          const v = parseDisp($('#bw-in').value);
          if (v == null || v <= 0) { toast('Enter a number'); return false; }
          // One weigh-in per day: replace any entry already logged today rather
          // than appending, so storage matches the one-per-day the chart shows.
          const now = Date.now();
          const today = startOfDay(now);
          const kept = state.weights.filter(w => startOfDay(w.ts) !== today);
          const already = state.weights.length !== kept.length;
          state.weights = kept.concat([{ ts: now, kg: toKg(v) }]);
          saveWeights().then(() => { renderStats(); backgroundSync(); });
          toast(already ? 'Updated today' : 'Logged');
        } }
    ]
  });
}

function openGoalWeight() {
  const cur = parseFloat(localStorage.getItem('ll.wgoal') || '');
  showModal({
    title: 'Goal weight',
    body: '<label class="fld"><span>Target (' + esc(unit) + ')</span>' +
      '<input id="wg-in" class="inp wide" type="text" inputmode="decimal" value="' +
      (isFinite(cur) ? esc(dispKg(cur)) : '') + '"></label>' +
      '<p class="muted pad-s">Drawn as a dashed line on the chart. Leave blank to remove it.</p>',
    actions: [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: () => {
          const raw = $('#wg-in').value.trim();
          if (!raw) { localStorage.removeItem('ll.wgoal'); renderStats(); return; }
          const v = parseDisp(raw);
          if (v == null || v <= 0) { toast('Enter a number'); return false; }
          localStorage.setItem('ll.wgoal', String(toKg(v)));
          renderStats();
        } }
    ]
  });
}

/* ================= rest-timer notifications =================
   Honest limit: without a push server this is a page timer. Chrome throttles
   and can freeze background timers, so a long rest with the phone locked may
   fire late or not at all. The Settings copy says so. */
const notif = { timer: null };
function notifEnabled() { return localStorage.getItem('ll.notif') === '1' && Notification.permission === 'granted'; }

async function requestNotif() {
  if (!('Notification' in window)) { toast('This browser has no notifications'); return false; }
  let p = Notification.permission;
  if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) { p = 'denied'; } }
  if (p !== 'granted') { toast('Notifications not allowed'); localStorage.setItem('ll.notif', '0'); return false; }
  localStorage.setItem('ll.notif', '1');
  return true;
}

function scheduleRestNotif(ms) {
  clearRestNotif();
  if (!notifEnabled() || ms <= 0) return;
  notif.timer = setTimeout(async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const body = 'Next set.';
      if (reg && reg.showNotification) {
        reg.showNotification('Rest over', { body, tag: 'liftlog-rest', renotify: true, icon: './icon-192.png', vibrate: [200, 80, 200] });
      } else {
        new Notification('Rest over', { body, tag: 'liftlog-rest' });
      }
    } catch (e) { /* best effort */ }
  }, ms);
}
function clearRestNotif() { clearTimeout(notif.timer); notif.timer = null; }


/* ================= wake lock ================= */
/* Off by default. Held only while a workout is on screen, and re-acquired when
   the app returns to the foreground -- the browser drops the lock on hide. */
let wakeLock = null;
function wakeWanted() { return localStorage.getItem('ll.wake') === '1'; }

async function acquireWake() {
  if (!wakeWanted() || wakeLock) return;
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* denied, low battery, or unsupported */ }
}
function releaseWake() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* already gone */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.view === 'active' && state.active) acquireWake();
});

/* ================= start / finish motivation ================= */
/* Inline rather than fetched: these are UI copy, and a failed fetch must never
   be the reason a workout can't start. */
const CHEER_START = [
  'You already did the hard part. You showed up. The rest is just moving weight.',
  'Nobody is coming to do this for you. That is not bad news. That is the entire point.',
  'Somewhere in the next hour there is a set you will not want to finish. Decide about it now, not then.',
  'You do not have to feel like it. Feeling like it was never a requirement. The bar does not check.',
  'Motivation is a guest. Discipline lives here. Today you are working with whoever stayed.',
  'The weight has no idea you are tired. Borrow its confidence.',
  'Strong is not something you are. It is something you are about to spend an hour becoming.',
  'Every rep you nearly skipped is the one doing most of the work.',
  'You have never once regretted the session you actually did. Strange how that keeps holding.',
  'Start badly if you have to. Just start. Form follows momentum.',
  'Your excuses are extremely well rehearsed by now. Give them the day off.',
  'This hour passes either way. You may as well be heavier at the end of it.',
  'The version of you that quits today gets a vote on who you are tomorrow. Do not hand him a ballot.',
  'Be the reason your future self runs out of excuses.',
];
const CHEER_FINISH = [
  'That is done. It cannot be taken back, it cannot be done for you, and it is on the board forever.',
  'You were never going to feel ready. You went anyway. That is the whole skill.',
  'Small deposit. Compounding interest. See you next time.',
  'The work is quiet. It does not announce itself. It just turns up later, in you.',
  'You proved something to the only person whose opinion actually runs your life.',
  'Nothing dramatic happened in there. That is precisely how this works.',
  'Another one your excuses lost. They are building quite a losing record.',
  'You did not get stronger in there. You earned the right to get stronger while you sleep.',
  'That is a promise kept. Those are rarer than people admit.',
  'You showed up when not showing up was available. Remember that the next time it is hard.',
  'Job done. Go eat something and be insufferably pleased with yourself.',
  'Consistency is not dramatic. It is just this, again, on a day you did not feel like it.',
  'One more session between you and the person you are turning into.',
  'The first step of a long walk counts exactly as much as the last one. You took one today.',
];

const pick = a => a[Math.floor(Math.random() * a.length)];

function cheerArt(kind) {
  if (kind === 'finish') {
    const rays = Array.from({ length: 10 }, (_, i) =>
      '<span class="cheer-ray" style="--a:' + (i * 36) + 'deg;animation-delay:' +
      (i * 22) + 'ms"></span>').join('');
    return rays + '<span class="cheer-emoji">\ud83c\udfc6</span>';
  }
  return '<span class="cheer-emoji">\ud83d\udd25</span>';
}

function showCheer(kind, sub, onGo) {
  const wrap = $('#cheer');
  if (!wrap) { if (onGo) onGo(); return; }
  $('#cheer-kicker').textContent = kind === 'finish' ? 'Workout complete' : 'Session start';
  $('#cheer-line').textContent = pick(kind === 'finish' ? CHEER_FINISH : CHEER_START);
  $('#cheer-sub').textContent = sub || '';
  $('.cheer-art').innerHTML = cheerArt(kind);
  $('#cheer-go').textContent = kind === 'finish' ? 'Done' : 'Let\u2019s go';
  wrap.hidden = false;

  const close = () => {
    wrap.hidden = true;
    $('#cheer-go').onclick = null;
    $('.cheer-backdrop').onclick = null;
    if (onGo) onGo();
  };
  $('#cheer-go').onclick = close;
  $('.cheer-backdrop').onclick = close;
}


/* ================= Strong CSV import ================= */
/* Union-only, like every other write path here: workouts merge by id, custom
   exercises merge by id, and re-importing the same export is a no-op because
   the parser derives stable ids from Strong's own workout numbers. */
function importStrong(file) {
  file.text().then(txt => {
    const res = parseStrongCsv(txt, { now: Date.now() });
    if (res.error) { toast(res.error); return; }
    if (!res.workouts.length) { toast('No workouts found in that file'); return; }

    const haveW = new Set(state.workouts.map(w => w.id));
    const freshW = res.workouts.filter(w => !haveW.has(w.id));
    const haveX = new Set(state.custom.map(c => c.id));
    const knownIds = new Set(exIndex.map(x => x.id));
    const freshX = res.customExercises.filter(c => !haveX.has(c.id) && !knownIds.has(c.id));

    const st = res.stats;
    const range = st.firstDate
      ? esc(fmtDate(st.firstDate)) + ' \u2192 ' + esc(fmtDate(st.lastDate)) : '';

    if (!freshW.length) {
      showModal({
        title: 'Nothing new to import',
        body: '<p>All ' + st.workouts + ' workouts in that file are already here. ' +
              'Nothing was changed.</p>',
        actions: [{ label: 'OK' }]
      });
      return;
    }

    showModal({
      title: 'Import from Strong',
      body:
        '<p><strong>' + freshW.length + '</strong> workout' + (freshW.length === 1 ? '' : 's') +
          ' \u00b7 <strong>' + st.sets + '</strong> sets \u00b7 ' + range + '</p>' +
        '<p class="muted small">' +
          freshX.length + ' new exercise' + (freshX.length === 1 ? '' : 's') + ' will be added to your list. ' +
          st.restRowsSkipped + ' rest-timer rows were skipped \u2014 they are not sets.' +
          (st.workouts - freshW.length > 0
            ? ' ' + (st.workouts - freshW.length) + ' already imported and will be left alone.' : '') +
        '</p>' +
        '<p class="muted small">Nothing existing is replaced or deleted.</p>',
      actions: [
        { label: 'Cancel' },
        { label: 'Import', primary: true, onClick: async () => {
            for (const w of freshW) await DB.put('workouts', w);
            state.workouts = (await DB.getAll('workouts'))
              .sort((a, b) => b.startTime - a.startTime);
            if (freshX.length) {
              state.custom = state.custom.concat(freshX);
              await saveCustom();
            }
            rebuildExerciseIndex();
            renderHome();
            toast('Imported ' + freshW.length + ' workout' + (freshW.length === 1 ? '' : 's'));
            backgroundSync();
          } }
      ]
    });
  }).catch(() => toast('Could not read that file'));
}
