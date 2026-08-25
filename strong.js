// strong.js — Strong app CSV export importer (vanilla ES module, pure functions)

export function slugify(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normHeader(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectDelimiter(headerLine) {
  let semi = 0;
  let comma = 0;
  for (let i = 0; i < headerLine.length; i++) {
    const c = headerLine.charAt(i);
    if (c === ';') semi++;
    else if (c === ',') comma++;
  }
  return semi >= comma ? ';' : ',';
}

// Character-by-character RFC-4180 parser: quoted fields, "" escapes,
// delimiters and newlines inside quotes.
function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
      i += 1;
    } else if (c === delim) {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (c === '\r' && text.charAt(i + 1) === '\n') i += 2;
      else i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// 'YYYY-MM-DD HH:MM:SS' local time -> ms epoch, or null.
function parseStrongDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function parseNum(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return NaN;
  return parseFloat(s);
}

function parseWeight(raw, isLbs) {
  let v = parseNum(raw);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) v = 0;
  if (isLbs) v = v / 2.2046226218;
  return Math.round(v * 1000) / 1000;
}

function fmtSuffix(v) {
  return String(Math.round(v * 1000) / 1000);
}

// Stable djb2-style hash, hex — used for ids when Workout # is absent.
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function emptyResult() {
  return {
    workouts: [],
    customExercises: [],
    stats: {
      rows: 0,
      sets: 0,
      restRowsSkipped: 0,
      noteRows: 0,
      workouts: 0,
      exercises: 0,
      skipped: 0,
      firstDate: null,
      lastDate: null,
    },
    error: null,
  };
}

export function parseStrongCsv(text, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const res = emptyResult();

  try {
    if (typeof text !== 'string' || text.length === 0) {
      res.error = 'input must be a non-empty string';
      return res;
    }

    const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

    const nl = t.indexOf('\n');
    const headerLine = nl === -1 ? t : t.slice(0, nl);
    const delim = detectDelimiter(headerLine);

    const records = parseCsv(t, delim);
    if (records.length === 0) {
      res.error = 'no header row found';
      return res;
    }

    const header = records[0].map(normHeader);
    const idxOf = (...names) => {
      for (let k = 0; k < names.length; k++) {
        const i = header.indexOf(names[k]);
        if (i !== -1) return i;
      }
      return -1;
    };

    const ix = {
      workoutNumber: idxOf('workout'),
      date: idxOf('date'),
      workoutName: idxOf('workoutname', 'name'),
      duration: idxOf('durationsec', 'duration'),
      exerciseName: idxOf('exercisename', 'exercise'),
      setOrder: idxOf('setorder'),
      reps: idxOf('reps'),
      rpe: idxOf('rpe'),
      distance: idxOf('distancemeters', 'distance'),
      seconds: idxOf('seconds'),
      notes: idxOf('notes'),
      workoutNotes: idxOf('workoutnotes'),
    };

    // Weight alias chain; remember whether the matched header is pounds.
    let weightIdx = idxOf('weightkg', 'weightlbs', 'weight');
    let weightIsLbs = false;
    if (weightIdx !== -1 && header[weightIdx].indexOf('lbs') !== -1) weightIsLbs = true;

    if (ix.date === -1 || ix.exerciseName === -1) {
      res.error = 'missing required columns (Date / Exercise Name)';
      return res;
    }

    const workouts = new Map(); // wkey -> workout record (+ internal bookkeeping)
    const pendingNotes = new Map(); // wkey -> Map(exerciseId -> note text awaiting a set)
    const exerciseNames = new Map(); // exerciseId -> display name

    const getCell = (rec, i) => (i >= 0 && i < rec.length ? String(rec[i] == null ? '' : rec[i]) : '');

    const makeIdentity = (rec) => {
      const dateStr = getCell(rec, ix.date).trim();
      const wName = getCell(rec, ix.workoutName).trim();
      const wNumRaw = getCell(rec, ix.workoutNumber).trim();
      if (wNumRaw !== '' && /^\d+$/.test(wNumRaw)) {
        return { key: 'n' + wNumRaw, id: 'strong-' + wNumRaw, name: wName };
      }
      const id = 'strong-' + hashId(dateStr + '|' + wName);
      return { key: 'd' + id, id: id, name: wName };
    };

    const ensureWorkout = (ident, dateMs) => {
      let w = workouts.get(ident.key);
      if (!w) {
        const dur = parseNum(getCell(records[0], -1)); // placeholder, replaced below
        w = {
          id: ident.id,
          templateId: null,
          templateName: ident.name,
          startTime: dateMs,
          endTime: dateMs,
          durationSec: 0,
          volumeKg: 0,
          setCount: 0,
          imported: 'strong',
          sets: [],
          _apps: new Map(), // exerciseId -> appearance order
          _appSeq: 0,
        };
        workouts.set(ident.key, w);
      }
      return w;
    };

    for (let r = 1; r < records.length; r++) {
      const rec = records[r];
      if (rec.length === 1 && String(rec[0]).trim() === '') continue; // stray blank line

      res.stats.rows++;

      const exerciseName = getCell(rec, ix.exerciseName).trim();
      const dateMs = parseStrongDate(getCell(rec, ix.date));

      if (exerciseName !== '') {
        const exId = slugify(exerciseName);
        if (exId !== '' && !exerciseNames.has(exId)) exerciseNames.set(exId, exerciseName);
      }

      if (exerciseName === '' || dateMs === null) {
        res.stats.skipped++;
        continue;
      }

      const ident = makeIdentity(rec);
      const orderRaw = getCell(rec, ix.setOrder).trim().toLowerCase();

      if (orderRaw === 'rest timer') {
        res.stats.restRowsSkipped++;
        continue;
      }

      if (orderRaw === 'note') {
        res.stats.noteRows++;
        const noteText = getCell(rec, ix.notes).trim();
        if (noteText === '') continue;
        const exId = slugify(exerciseName);
        const w = workouts.get(ident.key);
        if (w) {
          let target = null;
          for (const s of w.sets) {
            if (s.exerciseId === exId && (target === null || s.setNumber < target.setNumber)) target = s;
          }
          if (target) {
            target.note = target.note ? target.note + '; ' + noteText : noteText;
            continue;
          }
        }
        let pm = pendingNotes.get(ident.key);
        if (!pm) {
          pm = new Map();
          pendingNotes.set(ident.key, pm);
        }
        pm.set(exId, pm.has(exId) ? pm.get(exId) + '; ' + noteText : noteText);
        continue;
      }

      const setNumber = parseInt(orderRaw, 10);
      if (!Number.isFinite(setNumber)) {
        res.stats.skipped++;
        continue;
      }

      const w = ensureWorkout(ident, dateMs);

      // Duration (sec) is already seconds; refresh from whichever row carries it.
      const durRaw = parseNum(getCell(rec, ix.duration));
      if (Number.isFinite(durRaw) && durRaw > 0) {
        w.durationSec = Math.round(durRaw);
        w.endTime = w.startTime + w.durationSec * 1000;
      }

      const exId = slugify(exerciseName);
      let app = w._apps.get(exId);
      if (app === undefined) {
        app = w._appSeq++;
        w._apps.set(exId, app);
      }

      const weightKg = parseWeight(weightIdx >= 0 ? getCell(rec, weightIdx) : '', weightIsLbs);
      const repsRaw = parseNum(getCell(rec, ix.reps));
      const reps = Number.isFinite(repsRaw) && repsRaw > 0 ? Math.round(repsRaw) : 0;

      let note = getCell(rec, ix.notes).trim();

      const pm = pendingNotes.get(ident.key);
      if (pm && pm.has(exId)) {
        const p = pm.get(exId);
        note = note ? note + '; ' + p : p;
        pm.delete(exId);
      }

      const dist = parseNum(getCell(rec, ix.distance));
      const secs = parseNum(getCell(rec, ix.seconds));
      const suffixes = [];
      if (Number.isFinite(dist) && dist > 0) suffixes.push(fmtSuffix(dist) + ' m');
      if (Number.isFinite(secs) && secs > 0) suffixes.push(fmtSuffix(secs) + ' s');
      if (suffixes.length > 0) note = note ? note + '; ' + suffixes.join('; ') : suffixes.join('; ');

      w.sets.push({
        exerciseId: exId,
        exerciseName: exerciseName,
        setNumber: setNumber,
        weightKg: weightKg,
        reps: reps,
        isWarmup: false,
        note: note,
        pr: false,
      });
      res.stats.sets++;
    }

    // Finalize workouts.
    const list = [];
    let firstDate = null;
    let lastDate = null;
    for (const w of workouts.values()) {
      const apps = w._apps;
      w.sets.sort((a, b) => {
        const oa = apps.get(a.exerciseId);
        const ob = apps.get(b.exerciseId);
        if (oa !== ob) return oa - ob;
        return a.setNumber - b.setNumber;
      });
      let vol = 0;
      for (const s of w.sets) {
        if (!s.isWarmup) vol += s.weightKg * s.reps;
      }
      w.volumeKg = Math.round(vol * 100) / 100;
      w.setCount = w.sets.length;
      delete w._apps;
      delete w._appSeq;
      if (firstDate === null || w.startTime < firstDate) firstDate = w.startTime;
      if (lastDate === null || w.startTime > lastDate) lastDate = w.startTime;
      list.push(w);
    }
    list.sort((a, b) => b.startTime - a.startTime);

    const customExercises = Array.from(exerciseNames.entries())
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([id, name]) => ({
        id: id,
        name: name,
        muscle: '',
        custom: true,
        bodyweight: false,
        createdAt: now,
      }));

    res.workouts = list;
    res.customExercises = customExercises;
    res.stats.workouts = list.length;
    res.stats.exercises = customExercises.length;
    res.stats.firstDate = firstDate;
    res.stats.lastDate = lastDate;
    return res;
  } catch (e) {
    res.workouts = [];
    res.customExercises = [];
    res.stats = emptyResult().stats;
    res.error = String((e && e.message) || e);
    return res;
  }
}
