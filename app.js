/* LiftLog — single-file ES module. Storage: IndexedDB. No network calls at runtime
   except the one-time data.json fetch (cached by the service worker and mirrored to IDB). */
'use strict';

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
  view: 'home',
  wodId: null
};

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
    if (s) return { weightKg: s.weightKg, reps: s.reps };
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
  const bySlug = Object.values(d).find(e => slug(e.name) === id);
  if (bySlug) return bySlug;
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
  if (v === 'quotes') renderQuotes();
  if (v === 'active') startElapsed(); else stopElapsed();
  window.scrollTo(0, 0);
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
  const cards = state.data.templates.map(t => {
    const last = state.workouts.find(w => w.templateId === t.id);
    return `<button class="tpl" data-tpl="${esc(t.id)}">
      <span class="tpl-name">${esc(t.name)}</span>
      <span class="tpl-meta">${t.exercises.length} exercises · ${esc(relTime(last ? last.startTime : 0))}</span>
      <svg class="ic chev"><use href="#i-chev"/></svg></button>`;
  }).join('');
  const recent = state.workouts.slice(0, 5).map(w =>
    `<button class="hist-item" data-wod="${esc(w.id)}">
      <span class="hi-date">${esc(fmtDate(w.startTime))}</span>
      <span class="hi-name">${esc(w.templateName)}</span>
      <span class="hi-meta">${fmtDur(w.durationSec)} · ${fmtW(w.volumeKg)} · ${w.setCount} sets</span>
    </button>`).join('')
    || '<p class="muted pad-s">No workouts yet — pick a day above to start.</p>';
  $('#home-body').innerHTML = `
    <div class="nextup"><svg class="ic"><use href="#i-info"/></svg>
      <div><strong>Suggested next:</strong> ${esc(nu ? nu.name : '—')}<br><span class="muted small">A suggestion only — any day can be started.</span></div>
    </div>
    <h2 class="sec">Start workout</h2>
    <div class="list">${cards}</div>
    <h2 class="sec">Recent workouts</h2>
    <div class="list">${recent}</div>`;
}

/* ================= active workout ================= */
function makeSet(exId, n) {
  const p = prevFor(exId, n);
  // weightKg/reps pre-filled from history (rendered dimmed until confirmed)
  return { n, weightKg: p ? p.weightKg : null, reps: p ? p.reps : null, done: false, isWarmup: false, note: '', prev: p, pr: false };
}
function makeEx(te, altId) {
  const exId = altId || te.id;
  const ex = resolveExercise(exId, te);
  return {
    origId: te.id, exerciseId: exId, name: ex.name, muscle: ex.muscle || '',
    bodyweight: !!ex.bodyweight, video: ex.video || null,
    targetReps: te.reps, rest: te.rest, superset: te.superset || null,
    efforts: te.efforts || [],
    sets: Array.from({ length: te.sets }, (_, i) => makeSet(exId, i + 1))
  };
}

function startWorkout(tplId) {
  if (state.active) { promptResume(state.active); return; }
  const t = state.data.templates.find(t => t.id === tplId);
  if (!t) return;
  const swaps = prefs.swaps[tplId] || {};
  state.active = {
    key: 'current', id: uid(), templateId: t.id, templateName: t.name,
    startTime: Date.now(), restEnd: 0,
    exercises: t.exercises.map(te => makeEx(te, swaps[te.id] || null))
  };
  saveActive(true);
  buildActiveHeader();
  renderActive();
  showView('active');
}

function buildActiveHeader() {
  if (!state.active) return;
  $('#aw-name').textContent = state.active.templateName;
  elTick();
}

function cardHTML(ex, ei) {
  const rows = ex.sets.map((s, si) => rowHTML(ex, s, ei, si)).join('');
  return `<article class="ex-card" data-ei="${ei}">
    <header class="ex-head">
      <button class="ex-name" data-act="detail" data-ei="${ei}"><span>${esc(ex.name)}</span><svg class="ic chev"><use href="#i-chev"/></svg></button>
      <button class="icon-btn" data-act="cardmenu" data-ei="${ei}" aria-label="Exercise options"><svg class="ic"><use href="#i-dots"/></svg></button>
    </header>
    <div class="ex-target">
      <span class="tag">${esc(ex.muscle || 'Exercise')}</span>
      <span class="muted">${esc(ex.targetReps)} reps · rest ${esc(ex.rest)}</span>
    </div>
    <div class="set-grid">
      <div class="set-row head"><span>SET</span><span>PREVIOUS</span><span>${esc(unit.toUpperCase())}</span><span>REPS</span><span></span><span></span></div>
      ${rows}
    </div>
    <button class="addset" data-act="addset" data-ei="${ei}"><svg class="ic"><use href="#i-plus"/></svg> Add set</button>
  </article>`;
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
      <button class="step" data-act="step" data-field="w" data-dir="-1" aria-label="Weight down">−</button>
      <input class="inp w-inp${pref}" type="text" inputmode="decimal" value="${esc(wv)}" placeholder="0" ${dis} aria-label="Weight (${esc(unit)})">
      <button class="step" data-act="step" data-field="w" data-dir="1" aria-label="Weight up">+</button>
    </span>
    <span class="c-inp">
      <button class="step" data-act="step" data-field="r" data-dir="-1" aria-label="Reps down">−</button>
      <input class="inp r-inp${pref}" type="text" inputmode="numeric" value="${esc(rv)}" placeholder="0" ${dis} aria-label="Reps">
      <button class="step" data-act="step" data-field="r" data-dir="1" aria-label="Reps up">+</button>
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
  $('#aw-body').innerHTML = html;
}

function rowEl(ei, si) {
  return $(`#aw-body .ex-card[data-ei="${ei}"] .set-row[data-si="${si}"]`);
}

function toggleSet(ei, si) {
  const ex = state.active.exercises[ei], s = ex.sets[si];
  if (s.done) { s.done = false; s.pr = false; saveActive(); renderActive(); return; }
  const row = rowEl(ei, si);
  const w = parseDisp(row.querySelector('.w-inp').value);
  const r = parseInt(row.querySelector('.r-inp').value, 10);
  const weight = w == null ? (ex.bodyweight ? 0 : (s.weightKg ?? (s.prev ? s.prev.weightKg : 0))) : toKg(w);
  const reps = isNaN(r) ? (s.reps ?? (s.prev ? s.prev.reps : 0)) : r;
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

function stepVal(ei, si, field, dir) {
  const ex = state.active.exercises[ei], s = ex.sets[si];
  if (s.done) return;
  const row = rowEl(ei, si);
  const inp = row.querySelector(field === 'w' ? '.w-inp' : '.r-inp');
  let v = parseDisp(inp.value);
  if (v == null) v = field === 'w'
    ? (s.weightKg != null ? dispKg(s.weightKg) : (s.prev ? dispKg(s.prev.weightKg) : 0))
    : (s.reps ?? (s.prev ? s.prev.reps : 0));
  const st = field === 'w' ? stepFor() : 1;
  v = Math.max(0, Math.round((v + dir * st) * 100) / 100);
  inp.value = field === 'w' ? fmtNum(v) : String(Math.round(v));
  inp.classList.remove('pref');
  if (field === 'w') s.weightKg = toKg(v); else s.reps = Math.round(v);
  saveActive();
}

function addSet(ei) {
  const ex = state.active.exercises[ei];
  const last = ex.sets[ex.sets.length - 1];
  const n = ex.sets.length + 1;
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
      { label: s.isWarmup ? 'Unmark warm-up' : 'Mark as warm-up', onClick: () => { s.isWarmup = !s.isWarmup; saveActive(); renderActive(); } },
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
      { label: 'Cancel' }
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
  const tpl = state.data.templates.find(t => t.id === a.templateId);
  const te = (tpl && tpl.exercises.find(x => x.id === old.origId)) ||
    { id: old.origId, name: old.name, sets: old.sets.length, reps: old.targetReps, rest: old.rest, superset: old.superset, efforts: old.efforts };
  a.exercises[ei] = makeEx(te, altId);
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
  clearInterval(rest.iv); rest.iv = null; rest.fired = false;
  $('#restbar').hidden = true;
  if (state.active) { state.active.restEnd = 0; saveActive(true); }
}

/* ================= elapsed timer ================= */
let eliv = null;
function startElapsed() { if (!state.active) return; stopElapsed(); eliv = setInterval(elTick, 1000); elTick(); }
function stopElapsed() { clearInterval(eliv); eliv = null; }
function elTick() { if (state.active) $('#aw-elapsed').textContent = fmtDur((Date.now() - state.active.startTime) / 1000); }

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
}

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
  const sets = donePairs.map(({ ex, s }) => ({
    exerciseId: ex.exerciseId, exerciseName: ex.name, setNumber: s.n,
    weightKg: s.weightKg == null ? 0 : s.weightKg, reps: s.reps == null ? 0 : s.reps,
    isWarmup: !!s.isWarmup, note: s.note || '', pr: !!s.pr
  }));
  const rec = {
    id: a.id, templateId: a.templateId, templateName: a.templateName,
    startTime: a.startTime, endTime: end, durationSec: Math.round((end - a.startTime) / 1000),
    sets,
    volumeKg: sets.filter(s => !s.isWarmup).reduce((t, s) => t + s.weightKg * s.reps, 0),
    setCount: sets.length
  };
  DB.put('workouts', rec).then(async () => {
    await discardActive();
    state.workouts = (await DB.getAll('workouts')).sort((x, y) => y.startTime - x.startTime);
    showView('home');
    toast('Workout saved');
  });
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
          buildActiveHeader(); renderActive(); showView('active');
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
    ${exerciseHistoryHTML(ex.exerciseId)}`);
  $$('#sheet-inner [data-alt]').forEach(b => {
    b.onclick = () => openSwapConfirm(ctx.ei, b.dataset.alt, b.dataset.altname);
  });
}

function openGlossary(term) {
  const g = (state.data.program && state.data.program.glossary) || {};
  openSheet(`<h2>${esc(term)}</h2><p>${esc(g[term] || 'No explanation available.')}</p>`);
}

/* ================= history & read-only workout view ================= */
function renderHistory() {
  const groups = {};
  for (const w of state.workouts) {
    const d = new Date(w.startTime);
    const k = d.getFullYear() + '-' + d.getMonth();
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
          <span class="hi-meta">${fmtDur(w.durationSec)} · ${fmtW(w.volumeKg)} · ${w.setCount} sets</span>
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
    `<div class="wod-sum">${esc(w.templateName)} · ${fmtDur(w.durationSec)} · ${fmtW(w.volumeKg)} volume · ${w.setCount} sets</div>` +
    order.map(exId => {
      const sets = map[exId];
      return `<article class="ex-card">
        <header class="ex-head"><span class="ex-name" style="cursor:default"><span>${esc(sets[0].exerciseName)}</span></span></header>
        <div class="ro-grid" style="margin-top:6px"><span class="ro-h">SET</span><span class="ro-h">WEIGHT</span><span class="ro-h">REPS</span></div>
        ${sets.map(s => `<div class="ro-grid ro-row${s.isWarmup ? ' warmup' : ''}">
          <span>${s.setNumber}${s.isWarmup ? ' <span class="badge warm">Warm-up</span>' : ''}${s.pr ? ' <span class="badge pr"><svg class="ic"><use href="#i-trophy"/></svg>PR</span>' : ''}</span>
          <span>${s.weightKg > 0 ? esc(fmtW(s.weightKg)) : '—'}</span>
          <span>${s.reps}</span>
          ${s.note ? `<span class="ro-note">Note: ${esc(s.note)}</span>` : ''}
        </div>`).join('')}
      </article>`;
    }).join('');
  showView('wod');
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
function showModal({ title, body = '', actions = [] }) {
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
  const rows = [['date','workout','exercise','set_number','is_warmup','weight_kg','weight_display','unit','reps','estimated_1rm','notes']];
  for (const w of sortedAsc())
    for (const s of w.sets) {
      const e = e1rm(s.weightKg, s.reps);
      rows.push([
        new Date(w.startTime).toISOString().slice(0, 10), w.templateName, s.exerciseName,
        s.setNumber, s.isWarmup ? 'true' : 'false',
        s.weightKg ?? 0, dispKg(s.weightKg ?? 0) ?? 0, unit, s.reps ?? 0,
        e == null ? '' : e.toFixed(2), s.note || ''
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
    out += `${fmtDur(w.durationSec)} · volume ${fmtW(w.volumeKg)} · ${w.setCount} sets

`;
    out += '| Set | Exercise | Weight | Reps | Notes |\n|---|---|---|---|---|\n';
    for (const s of w.sets)
      out += `| ${s.setNumber}${s.isWarmup ? ' (warm-up)' : ''}${s.pr ? ' ★PR' : ''} | ${s.exerciseName} | ${s.weightKg > 0 ? fmtW(s.weightKg) : '—'} | ${s.reps} | ${s.note || ''} |
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
    out += `Duration ${fmtDur(w.durationSec)} · Volume ${fmtW(w.volumeKg)} · ${w.setCount} sets
`;
    for (const s of w.sets)
      out += `  Set ${s.setNumber}${s.isWarmup ? ' (warm-up)' : ''}${s.pr ? ' [PR]' : ''}: ${s.exerciseName} — ${s.weightKg > 0 ? fmtW(s.weightKg) + ' x ' : ''}${s.reps} reps${s.note ? ' — ' + s.note : ''}
`;
    out += '\n';
  }
  download(`liftlog-${stamp()}.txt`, 'text/plain', out);
  toast('TXT exported');
}

function exportJSON() {
  const payload = {
    app: 'LiftLog', schemaVersion: 1, exportedAt: new Date().toISOString(),
    workouts: state.workouts,
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
    if (!fresh.length) { toast('Nothing new — all workouts already exist'); return; }
    const dates = fresh.map(w => fmtDate(w.startTime)).sort();
    showModal({
      title: 'Import backup',
      body: `<p>Add <strong>${fresh.length}</strong> workout${fresh.length > 1 ? 's' : ''} (${esc(dates[0])} → ${esc(dates[dates.length - 1])})?</p>
        <p class="muted">${valid.length - fresh.length} duplicate${valid.length - fresh.length === 1 ? '' : 's'} will be skipped. Existing data is never replaced.</p>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Import', primary: true, onClick: async () => {
            for (const w of fresh) await DB.put('workouts', w);
            state.workouts = (await DB.getAll('workouts')).sort((a, b) => b.startTime - a.startTime);
            toast(`Imported ${fresh.length} workout${fresh.length > 1 ? 's' : ''}`);
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
}

/* ================= event wiring ================= */
function wire() {
  $$('#tabbar button').forEach(b => b.onclick = () => showView(b.dataset.v));

  // home
  $('#home-body').addEventListener('click', e => {
    const b = e.target.closest('[data-tpl],[data-wod]');
    if (!b) return;
    if (b.dataset.tpl) startWorkout(b.dataset.tpl);
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
    else if (act === 'step') stepVal(ei, si, b.dataset.field, +b.dataset.dir);
  });
  // weight/reps edits commit on change (blur / keyboard done) — no re-render, so focus is safe
  $('#aw-body').addEventListener('change', e => {
    const i = e.target;
    if (!i.classList.contains('w-inp') && !i.classList.contains('r-inp')) return;
    const row = i.closest('.set-row');
    const s = state.active.exercises[+row.dataset.ei].sets[+row.dataset.si];
    if (s.done) return;
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

  // active header
  $('#btn-finish').onclick = finishFlow;
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
  $('#exp-csv').onclick = exportCSV;
  $('#exp-md').onclick = exportMD;
  $('#exp-txt').onclick = exportTXT;
  $('#exp-json').onclick = exportJSON;
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
  const act = await DB.get('kv', 'active');
  if (act) state.active = act;
  wire();
  renderSettings();
  showView('home');
  if (act) promptResume(act);
  // ask for persistent storage once, on first run
  if (!localStorage.getItem('ll.persist')) {
    localStorage.setItem('ll.persist', '1');
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* unsupported */ }
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* e.g. file:// — app still works */ });
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
