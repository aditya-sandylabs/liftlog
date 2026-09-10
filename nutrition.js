/*
 * LiftLog — nutrition.js
 *
 * Pure logic module: no DOM, no storage, no network.
 * Data in → data / SVG strings out. The host app does all wiring.
 *
 * ── Two shapes, do NOT conflate them ──────────────────────────────────────
 *
 *   FOOD      a thing you *could* eat. Macros are always PER 100 g.
 *             Either shipped (foods.json — read-only, source 'ifct'|'fndds'|'sr')
 *             or user-created (source 'user', lives in the user's own store).
 *
 *   ENTRY     a thing you *did* eat, on a day, in a slot. Macros are ABSOLUTE
 *             (already scaled by grams) and SNAPSHOTTED at log time.
 *
 * ── Why entries snapshot their macros instead of pointing at a food ───────
 *
 * An entry stores kcal/p/c/f directly rather than {foodId, grams} resolved at
 * read time. This is deliberate and load-bearing:
 *
 *   1. foods.json is REGENERATED. USDA revises values between releases. If
 *      history resolved through the database, rebuilding it would silently
 *      rewrite what you ate last March.
 *   2. A user can edit or delete one of their own foods. That must not
 *      retroactively change a logged day.
 *   3. An entry stays readable when its food no longer exists at all.
 *
 * `foodId` is still carried, but only as a back-reference for "log this
 * again" — never as the source of truth for an entry's macros.
 *
 * ── Deletes and tombstones ───────────────────────────────────────────────
 *
 * The rest of this app merges union-only: a sync can never delete a workout.
 * That is correct for workouts (a handful a week, deleted almost never) and
 * wrong for meals (several a day, mis-logged often) — a deleted breakfast
 * would resurrect on the next sync from another device, forever.
 *
 * So the nutrition stores use TOMBSTONES: deleting sets `deleted: true` and
 * keeps the record. The merge is still strictly append-only — it never drops
 * information — but a tombstone beats a live record, so deletes propagate.
 * `liveOnly()` strips them for display. Never filter tombstones out before a
 * merge or a delete stops propagating.
 */

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function num(v, dflt = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Round to 1dp for grams/macros; keeps totals from showing 12.300000000001. */
function r1(v) {
  return Math.round(num(v) * 10) / 10;
}

function r0(v) {
  return Math.round(num(v));
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

export function nutritionUid(prefix) {
  return (prefix || 'n') + '-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10);
}

/** Meal slots, in the order they are eaten and displayed. */
export const SLOTS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snack', label: 'Snacks' }
];

export function slotLabel(id) {
  const s = SLOTS.find(x => x.id === id);
  return s ? s.label : 'Snacks';
}

/** Slot a given time of day most likely belongs to — a default, always editable. */
export function slotForTime(ts) {
  const h = new Date(num(ts, Date.now())).getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

/* Atwater factors, used only to sanity-check hand-entered foods. */
const KCAL_PER_G = { p: 4, c: 4, f: 9 };

/* ------------------------------------------------------------------ */
/* Foods                                                               */
/* ------------------------------------------------------------------ */

/**
 * Normalise one record from foods.json's terse on-disk shape.
 * Terse keys exist because this file ships to a phone; see build/build_foods.py.
 */
export function dbFoodToFood(raw) {
  if (!raw || typeof raw !== 'object' || !raw.i) return null;
  return {
    id: String(raw.i),
    name: String(raw.n == null ? '' : raw.n),
    source: String(raw.s || 'sr'),
    group: raw.g ? String(raw.g) : '',
    aliases: raw.a ? String(raw.a) : '',
    per100: {
      kcal: num(raw.k), p: num(raw.p), c: num(raw.c), f: num(raw.f),
      fib: raw.fb == null ? null : num(raw.fb),
      sug: raw.sg == null ? null : num(raw.sg)
    },
    portions: Array.isArray(raw.pt)
      ? raw.pt.filter(p => Array.isArray(p) && p.length >= 2 && num(p[1]) > 0)
              .map(p => ({ label: String(p[0]), grams: num(p[1]) }))
      : []
  };
}

/**
 * Create a user food. Macros are entered PER `basis` grams (usually 100, but a
 * label often reads "per 30 g serving") and are stored normalised to per-100 g
 * so everything downstream has one unit.
 */
export function makeUserFood(name, macros, opts = {}) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new Error('Food name is required.');
  const basis = num(opts.basis, 100);
  if (!(basis > 0)) throw new Error('Serving size must be greater than zero.');
  const scale = 100 / basis;
  const m = macros || {};
  const per100 = {
    kcal: r1(num(m.kcal) * scale),
    p: r1(num(m.p) * scale),
    c: r1(num(m.c) * scale),
    f: r1(num(m.f) * scale),
    fib: m.fib == null || m.fib === '' ? null : r1(num(m.fib) * scale),
    sug: m.sug == null || m.sug === '' ? null : r1(num(m.sug) * scale)
  };
  for (const k of ['kcal', 'p', 'c', 'f']) {
    if (per100[k] < 0) throw new Error('Macros cannot be negative.');
  }
  const portions = [];
  if (num(opts.portionGrams) > 0) {
    portions.push({
      label: String(opts.portionLabel || 'serving').trim() || 'serving',
      grams: r1(opts.portionGrams)
    });
  }
  return {
    id: opts.id || nutritionUid('f'),
    name: trimmed,
    source: 'user',
    group: String(opts.group || '').trim(),
    aliases: '',
    brand: String(opts.brand || '').trim(),
    per100,
    portions,
    ts: num(opts.ts, Date.now())
  };
}

/**
 * Does a hand-entered food's stated energy match its macros?
 * Returns null when it is plausible, or a message when it is not.
 * ADVISORY ONLY — never blocks a save. Real labels disagree with Atwater for
 * real reasons (sugar alcohols, fibre, rounding), so this warns and moves on.
 */
export function energyMismatch(per100) {
  if (!per100) return null;
  const stated = num(per100.kcal);
  const computed = num(per100.p) * KCAL_PER_G.p +
                   num(per100.c) * KCAL_PER_G.c +
                   num(per100.f) * KCAL_PER_G.f;
  if (stated <= 0 && computed <= 0) return null;
  const diff = Math.abs(stated - computed);
  // Tolerate the larger of 25 kcal or 20% — below that the noise is normal.
  const tol = Math.max(25, computed * 0.2);
  if (diff <= tol) return null;
  return 'Macros work out to about ' + r0(computed) + ' kcal, not ' + r0(stated) +
         '. Saved anyway — check if that looks wrong.';
}

/**
 * Flat searchable index over the shipped database plus the user's own foods.
 * `usage` maps foodId → times logged, and is what makes the list get smarter.
 */
export function buildFoodIndex({ db, userFoods, usage } = {}) {
  const out = [];
  const use = usage && typeof usage === 'object' ? usage : {};

  for (const f of liveOnly(arrOf(userFoods, 'userFoods'))) {
    if (!f || !f.id) continue;
    out.push({
      id: f.id, name: f.name || '', source: 'user', group: f.group || '',
      brand: f.brand || '', aliases: '',
      per100: f.per100 || { kcal: 0, p: 0, c: 0, f: 0 },
      portions: Array.isArray(f.portions) ? f.portions : [],
      timesLogged: num(use[f.id])
    });
  }

  const rows = arrOf(db && db.foods ? db.foods : db, 'foods');
  for (const raw of rows) {
    const f = dbFoodToFood(raw);
    if (!f) continue;
    f.timesLogged = num(use[f.id]);
    out.push(f);
  }
  return out;
}

/* Source priority when everything else ties. IFCT first: this is an Indian
   household, and "Bajra" should not lose to "Millet, pearl, raw". Then
   as-consumed dishes, then raw generics, with the user's own foods above all. */
const SOURCE_RANK = { user: 0, ifct: 1, fndds: 2, sr: 3 };

/**
 * Ranked food search. Mirrors searchExercises' rank ladder, plus:
 *   - alias matching, so IFCT local names ("sajje", "kambu") find the food
 *   - source priority as a tie-break
 *   - times-logged ahead of alphabetical, so your foods surface first
 */
export function searchFoods(index, query, opts = {}) {
  if (!Array.isArray(index)) return [];
  const q = normText(query).trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const sourceFilter = opts.source ? String(opts.source) : null;

  const scored = [];
  for (const it of index) {
    if (!it || typeof it !== 'object') continue;
    if (sourceFilter && it.source !== sourceFilter) continue;
    const nName = normText(it.name);
    const nAlias = it.aliases ? normText(it.aliases) : '';
    const nBrand = it.brand ? normText(it.brand) : '';
    let rank;
    if (!q) rank = 0;
    else if (nName === q) rank = 1;
    else if (nName.startsWith(q)) rank = 2;
    // A word-start hit inside the name beats a mid-word one: searching "oat"
    // should surface "Rolled oats" before "Groats".
    else if (new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(nName)) rank = 3;
    else if (nAlias && (nAlias === q || nAlias.split(' ').some(a => a === q))) rank = 3;
    else if (nName.includes(q)) rank = 4;
    else if (nAlias.includes(q) || nBrand.includes(q)) rank = 5;
    else if (tokens.length > 1 && tokens.every(t => nName.includes(t) || nAlias.includes(t))) rank = 6;
    else continue;
    scored.push([rank, it]);
  }

  scored.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    const ta = num(a[1].timesLogged), tb = num(b[1].timesLogged);
    if (tb !== ta) return tb - ta;
    const sa = SOURCE_RANK[a[1].source] == null ? 9 : SOURCE_RANK[a[1].source];
    const sb = SOURCE_RANK[b[1].source] == null ? 9 : SOURCE_RANK[b[1].source];
    if (sa !== sb) return sa - sb;
    // Shorter names are more generic and usually what was meant:
    // "Oats" over "Oats, instant, fortified, plain, dry".
    const la = String(a[1].name || '').length, lb = String(b[1].name || '').length;
    if (la !== lb) return la - lb;
    return String(a[1].name || '').localeCompare(String(b[1].name || ''), undefined, { sensitivity: 'base' });
  });

  let res = scored.map(p => p[1]);
  if (Number.isFinite(opts.limit) && opts.limit >= 0) res = res.slice(0, Math.floor(opts.limit));
  return res;
}

/** Scale a food's per-100 g macros to an absolute amount. */
export function macrosFor(food, grams) {
  const per = (food && food.per100) || {};
  const g = num(grams) / 100;
  return {
    kcal: r1(num(per.kcal) * g),
    p: r1(num(per.p) * g),
    c: r1(num(per.c) * g),
    f: r1(num(per.f) * g),
    fib: per.fib == null ? null : r1(num(per.fib) * g),
    sug: per.sug == null ? null : r1(num(per.sug) * g)
  };
}

/* ------------------------------------------------------------------ */
/* Recipes                                                             */
/* ------------------------------------------------------------------ */

/**
 * A recipe is the bridge between an ingredient database and a real meal.
 * Neither IFCT nor USDA contains "the dal I actually make" — so you build it
 * once from ingredients, and thereafter log it in one tap.
 *
 * Items snapshot their macros for the same reason entries do.
 */
export function makeRecipe(name, opts = {}) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new Error('Recipe name is required.');
  const servings = num(opts.servings, 1);
  if (!(servings > 0)) throw new Error('A recipe must make at least a fraction of a serving.');
  return {
    id: opts.id || nutritionUid('r'),
    name: trimmed,
    servings,
    servingLabel: String(opts.servingLabel || 'serving').trim() || 'serving',
    items: [],
    ts: num(opts.ts, Date.now())
  };
}

export function recipeAddItem(recipe, food, grams, opts = {}) {
  const g = num(grams);
  if (!(g > 0)) throw new Error('Enter how many grams go in.');
  if (!food || !food.id) throw new Error('Pick a food first.');
  const m = macrosFor(food, g);
  const item = {
    id: nutritionUid('ri'),
    foodId: food.id,
    name: food.name || '',
    source: food.source || '',
    grams: r1(g),
    kcal: m.kcal, p: m.p, c: m.c, f: m.f, fib: m.fib, sug: m.sug
  };
  const next = Object.assign({}, recipe, {
    items: (recipe.items || []).concat([item]),
    ts: num(opts.ts, Date.now())
  });
  return next;
}

export function recipeRemoveItem(recipe, itemId, opts = {}) {
  return Object.assign({}, recipe, {
    items: (recipe.items || []).filter(i => i && i.id !== itemId),
    ts: num(opts.ts, Date.now())
  });
}

/** Total macros for the whole recipe (all servings). */
export function recipeTotals(recipe) {
  return sumMacros((recipe && recipe.items) || []);
}

/** Macros in ONE serving — what actually gets logged. */
export function recipePerServing(recipe) {
  const t = recipeTotals(recipe);
  const n = num(recipe && recipe.servings, 1) || 1;
  return {
    kcal: r1(t.kcal / n), p: r1(t.p / n), c: r1(t.c / n), f: r1(t.f / n),
    fib: t.fib == null ? null : r1(t.fib / n),
    sug: t.sug == null ? null : r1(t.sug / n)
  };
}

/** Total cooked grams, when every ingredient was weighed. */
export function recipeGrams(recipe) {
  return r1(((recipe && recipe.items) || []).reduce((a, i) => a + num(i.grams), 0));
}

/**
 * Present a recipe as if it were a food, so the picker, the logger and the
 * "log again" path can all treat recipes and foods identically.
 * per100 is derived from total grams — meaningful only if items were weighed.
 */
export function recipeAsFood(recipe) {
  if (!recipe || !recipe.id) return null;
  const grams = recipeGrams(recipe);
  const totals = recipeTotals(recipe);
  const scale = grams > 0 ? 100 / grams : 0;
  const per = recipePerServing(recipe);
  return {
    id: recipe.id,
    name: recipe.name || '',
    source: 'recipe',
    group: 'Your recipes',
    aliases: '',
    isRecipe: true,
    servings: num(recipe.servings, 1),
    per100: {
      kcal: r1(totals.kcal * scale), p: r1(totals.p * scale),
      c: r1(totals.c * scale), f: r1(totals.f * scale),
      fib: totals.fib == null ? null : r1(totals.fib * scale),
      sug: totals.sug == null ? null : r1(totals.sug * scale)
    },
    // The serving is the portion you actually log, so it leads.
    portions: grams > 0
      ? [{ label: '1 ' + (recipe.servingLabel || 'serving'), grams: r1(grams / (num(recipe.servings, 1) || 1)) }]
      : [],
    perServing: per
  };
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Log a food. `grams` is authoritative; macros are snapshotted from it.
 * For a recipe logged by servings, pass opts.servings and the caller supplies
 * the recipe's per-serving macros via `food.perServing`.
 */
export function makeEntry(food, grams, opts = {}) {
  if (!food) throw new Error('Pick a food first.');
  const ts = num(opts.ts, Date.now());
  let m, g = num(grams), servings = null;

  if (food.isRecipe && opts.servings != null) {
    servings = num(opts.servings);
    if (!(servings > 0)) throw new Error('Enter how many servings.');
    const per = food.perServing || recipePerServing(food);
    m = {
      kcal: r1(num(per.kcal) * servings), p: r1(num(per.p) * servings),
      c: r1(num(per.c) * servings), f: r1(num(per.f) * servings),
      fib: per.fib == null ? null : r1(num(per.fib) * servings),
      sug: per.sug == null ? null : r1(num(per.sug) * servings)
    };
    const one = (food.portions && food.portions[0]) ? num(food.portions[0].grams) : 0;
    g = one > 0 ? r1(one * servings) : 0;
  } else {
    if (!(g > 0)) throw new Error('Enter an amount greater than zero.');
    m = macrosFor(food, g);
  }

  return {
    id: opts.id || nutritionUid('e'),
    ts,
    day: startOfDayTs(ts),
    slot: opts.slot || slotForTime(ts),
    foodId: food.id || null,
    name: String(food.name || ''),
    source: food.source || '',
    grams: r1(g),
    servings,
    portionLabel: opts.portionLabel ? String(opts.portionLabel) : null,
    kcal: m.kcal, p: m.p, c: m.c, f: m.f, fib: m.fib, sug: m.sug
  };
}

/** Tombstone a record. Never removes it — see the header note on deletes. */
export function tombstone(rec, opts = {}) {
  if (!rec || !rec.id) return rec;
  return { id: rec.id, deleted: true, ts: num(opts.ts, Date.now()) };
}

/** Strip tombstones. For DISPLAY only — never feed the result into a merge. */
export function liveOnly(list) {
  return (Array.isArray(list) ? list : []).filter(r => r && r.id && !r.deleted);
}

export function sumMacros(items) {
  let kcal = 0, p = 0, c = 0, f = 0, fib = 0, sug = 0;
  let anyFib = false, anySug = false;
  for (const i of (Array.isArray(items) ? items : [])) {
    if (!i) continue;
    kcal += num(i.kcal); p += num(i.p); c += num(i.c); f += num(i.f);
    if (i.fib != null) { fib += num(i.fib); anyFib = true; }
    if (i.sug != null) { sug += num(i.sug); anySug = true; }
  }
  return {
    kcal: r1(kcal), p: r1(p), c: r1(c), f: r1(f),
    fib: anyFib ? r1(fib) : null,
    sug: anySug ? r1(sug) : null
  };
}

/** Every live entry on one calendar day, oldest first. */
export function entriesForDay(entries, dayTs) {
  const day = startOfDayTs(dayTs);
  return liveOnly(arrOf(entries, 'foodEntries'))
    .filter(e => startOfDayTs(e.day != null ? e.day : e.ts) === day)
    .sort((a, b) => num(a.ts) - num(b.ts));
}

/** A day grouped into meal slots, in eating order, with per-slot totals. */
export function dayBySlot(entries, dayTs) {
  const list = entriesForDay(entries, dayTs);
  return SLOTS.map(s => {
    const items = list.filter(e => (e.slot || 'snack') === s.id);
    return { id: s.id, label: s.label, items, totals: sumMacros(items) };
  });
}

export function dayTotals(entries, dayTs) {
  return sumMacros(entriesForDay(entries, dayTs));
}

/** How often each food has been logged — drives search ranking and Recents. */
export function foodUsage(entries) {
  const out = {};
  for (const e of liveOnly(arrOf(entries, 'foodEntries'))) {
    if (!e.foodId) continue;
    out[e.foodId] = (out[e.foodId] || 0) + 1;
  }
  return out;
}

/**
 * Distinct foods most recently logged, newest first.
 * This is the list that makes day-two logging fast, so it is deliberately
 * de-duplicated by food rather than by entry.
 */
export function recentFoods(entries, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 20;
  const seen = new Set();
  const out = [];
  const sorted = liveOnly(arrOf(entries, 'foodEntries')).slice().sort((a, b) => num(b.ts) - num(a.ts));
  for (const e of sorted) {
    const key = e.foodId || ('name:' + normText(e.name));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Re-log a whole day into another day. "Copy yesterday" — the single biggest
 * adherence lever there is, because most days repeat.
 * Returns NEW entries (fresh ids); it never mutates or moves the originals.
 */
export function copyDay(entries, fromDayTs, toDayTs, opts = {}) {
  const src = entriesForDay(entries, fromDayTs);
  const toDay = startOfDayTs(toDayTs);
  const onlySlot = opts.slot || null;
  return src
    .filter(e => !onlySlot || (e.slot || 'snack') === onlySlot)
    .map(e => {
      // Keep each entry's time-of-day, but on the target date.
      const orig = new Date(num(e.ts));
      const ts = toDay + (orig.getHours() * 3600 + orig.getMinutes() * 60) * 1000;
      return Object.assign({}, e, {
        id: nutritionUid('e'), ts, day: toDay
      });
    });
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Progress against daily targets. `over` is reported honestly rather than
 * clamped — being 300 kcal over is information, not an error state.
 */
export function targetProgress(totals, targets) {
  const t = targets || {};
  const out = {};
  for (const k of ['kcal', 'p', 'c', 'f']) {
    const goal = num(t[k]);
    const have = num(totals && totals[k]);
    out[k] = {
      have: r1(have),
      goal: goal > 0 ? r1(goal) : null,
      pct: goal > 0 ? Math.round((have / goal) * 100) : null,
      left: goal > 0 ? r1(goal - have) : null,
      over: goal > 0 && have > goal
    };
  }
  return out;
}

/** Share of energy from each macro, using Atwater factors. */
export function macroSplitPct(totals) {
  const p = num(totals && totals.p) * KCAL_PER_G.p;
  const c = num(totals && totals.c) * KCAL_PER_G.c;
  const f = num(totals && totals.f) * KCAL_PER_G.f;
  const sum = p + c + f;
  if (sum <= 0) return { p: 0, c: 0, f: 0 };
  return {
    p: Math.round((p / sum) * 100),
    c: Math.round((c / sum) * 100),
    f: Math.round((f / sum) * 100)
  };
}

/**
 * Mifflin-St Jeor BMR, then TDEE. Used only to SUGGEST a starting target;
 * the user's own number always wins. Returns null when inputs are missing —
 * it never guesses an age or a height.
 */
export function suggestTargets({ kg, cm, age, sex, activity, goal } = {}) {
  const w = num(kg), h = num(cm), a = num(age);
  if (!(w > 0) || !(h > 0) || !(a > 0)) return null;
  const s = sex === 'female' ? -161 : 5;
  const bmr = 10 * w + 6.25 * h - 5 * a + s;
  const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 }[activity] || 1.375;
  const tdee = bmr * mult;
  const adj = { lose: -0.2, maintain: 0, gain: 0.1 }[goal] || 0;
  const kcal = Math.round((tdee * (1 + adj)) / 10) * 10;
  // Protein 1.8 g/kg (upper end of the hypertrophy range, and protective in a
  // deficit), fat 25% of energy, carbs take the remainder.
  const p = Math.round(w * 1.8);
  const f = Math.round((kcal * 0.25) / KCAL_PER_G.f);
  const c = Math.max(0, Math.round((kcal - p * KCAL_PER_G.p - f * KCAL_PER_G.f) / KCAL_PER_G.c));
  return { kcal, p, c, f, bmr: Math.round(bmr), tdee: Math.round(tdee) };
}

/* ------------------------------------------------------------------ */
/* Merges — union + tombstone. See the header note.                    */
/* ------------------------------------------------------------------ */

/**
 * Union by id. A tombstone always wins over a live record regardless of which
 * side it came from, so a delete on any device propagates to all of them.
 * Between two live records the newer `ts` wins; local breaks a tie.
 * Inputs are never mutated. The result can never lose a record.
 */
function mergeById(local, remote, key) {
  const byId = new Map();
  const take = (rec, isLocal) => {
    if (!rec || typeof rec !== 'object' || !rec.id) return;
    const prev = byId.get(rec.id);
    if (!prev) { byId.set(rec.id, Object.assign({}, rec)); return; }
    // Tombstone beats live, always.
    if (prev.deleted && !rec.deleted) return;
    if (!prev.deleted && rec.deleted) { byId.set(rec.id, Object.assign({}, rec)); return; }
    const pt = num(prev.ts), rt = num(rec.ts);
    if (rt > pt || (rt === pt && isLocal)) byId.set(rec.id, Object.assign({}, rec));
  };
  for (const r of arrOf(remote, key)) take(r, false);
  for (const l of arrOf(local, key)) take(l, true);
  return Array.from(byId.values());
}

export function mergeFoodEntries(local, remote) {
  return mergeById(local, remote, 'foodEntries')
    .sort((a, b) => num(a.ts) - num(b.ts));
}

export function mergeUserFoods(local, remote) {
  return mergeById(local, remote, 'userFoods')
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}

export function mergeRecipes(local, remote) {
  return mergeById(local, remote, 'recipes')
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}

/* ------------------------------------------------------------------ */
/* Charts — no colour carries meaning (Aditya is red/green colourblind) */
/* ------------------------------------------------------------------ */

/**
 * Daily energy over the last N days as a bar chart, with an optional target
 * line. Bars are one hue; over/under target is carried by a CLASS the host
 * stylesheet renders as a pattern + luminance change, never by hue alone.
 */
export function kcalTrendSVG(entries, opts = {}) {
  const days = Number.isFinite(opts.days) ? Math.max(3, Math.floor(opts.days)) : 14;
  const endDay = startOfDayTs(Number.isFinite(opts.endTs) ? opts.endTs : Date.now());
  const goal = num(opts.goalKcal);
  const W = 320, H = 140, padL = 30, padR = 8, padT = 10, padB = 24;

  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = endDay - i * DAY_MS;
    buckets.push({ day, kcal: num(dayTotals(entries, day).kcal) });
  }
  const maxV = Math.max(goal, ...buckets.map(b => b.kcal), 1);
  const top = Math.ceil(maxV / 250) * 250 || 250;

  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bw = plotW / days;
  const y = v => padT + plotH - (v / top) * plotH;

  let bars = '';
  buckets.forEach((b, i) => {
    if (b.kcal <= 0) return;
    const x = padL + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const yy = y(b.kcal);
    const cls = goal > 0 && b.kcal > goal ? 'kc-bar kc-over' : 'kc-bar';
    bars += '<rect class="' + cls + '" x="' + r1(x) + '" y="' + r1(yy) +
            '" width="' + r1(w) + '" height="' + r1(padT + plotH - yy) +
            '" rx="2"><title>' + esc(new Date(b.day).toDateString() + ' — ' + r0(b.kcal) + ' kcal') +
            '</title></rect>';
  });

  let grid = '';
  for (let g = 0; g <= top; g += top / 2) {
    grid += '<line class="kc-grid" x1="' + padL + '" y1="' + r1(y(g)) + '" x2="' + (W - padR) +
            '" y2="' + r1(y(g)) + '"/>' +
            '<text class="kc-ax" x="' + (padL - 4) + '" y="' + r1(y(g) + 3) + '" text-anchor="end">' + r0(g) + '</text>';
  }

  // Dashed INLINE, not via the stylesheet: the dash is what distinguishes the
  // target from a grid line without relying on colour at all.
  const goalLine = goal > 0
    ? '<line class="kc-goal" stroke-dasharray="4 3" x1="' + padL + '" y1="' + r1(y(goal)) +
      '" x2="' + (W - padR) + '" y2="' + r1(y(goal)) + '"/>'
    : '';

  const first = new Date(buckets[0].day), last = new Date(buckets[buckets.length - 1].day);
  const fmt = d => d.getDate() + '/' + (d.getMonth() + 1);
  const labels =
    '<text class="kc-ax" x="' + padL + '" y="' + (H - 2) + '">' + esc(fmt(first)) + '</text>' +
    '<text class="kc-ax" x="' + (W - padR) + '" y="' + (H - 2) + '" text-anchor="end">' + esc(fmt(last)) + '</text>';

  const logged = buckets.filter(b => b.kcal > 0).length;
  if (!logged) {
    return '<svg class="kc-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
           'aria-label="No food logged yet"><text class="kc-empty" x="' + (W / 2) +
           '" y="' + (H / 2) + '" text-anchor="middle">No food logged yet</text></svg>';
  }

  return '<svg class="kc-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
    esc('Daily energy over the last ' + days + ' days') + '">' +
    grid + goalLine + bars + labels + '</svg>';
}

/**
 * Average daily macros across the days that actually have entries.
 * Days with nothing logged are EXCLUDED, not counted as zero — otherwise a
 * couple of unlogged days quietly halve the average and it reads as progress.
 */
export function averageDay(entries, opts = {}) {
  const days = Number.isFinite(opts.days) ? Math.max(1, Math.floor(opts.days)) : 7;
  const endDay = startOfDayTs(Number.isFinite(opts.endTs) ? opts.endTs : Date.now());
  const totals = [];
  for (let i = 0; i < days; i++) {
    const t = dayTotals(entries, endDay - i * DAY_MS);
    if (t.kcal > 0 || t.p > 0 || t.c > 0 || t.f > 0) totals.push(t);
  }
  if (!totals.length) return { days: 0, kcal: 0, p: 0, c: 0, f: 0 };
  const s = sumMacros(totals);
  const n = totals.length;
  return {
    days: n,
    kcal: r0(s.kcal / n), p: r1(s.p / n), c: r1(s.c / n), f: r1(s.f / n)
  };
}
