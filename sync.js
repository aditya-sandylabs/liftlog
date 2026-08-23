/**
 * sync.js — best-effort Google Drive mirror for LiftLog.
 *
 * HARD RULES
 * - IndexedDB is the system of record. This module can never lose, block or
 *   corrupt local data: every exported async function resolves (never rejects)
 *   and failures are reported through onStatus instead of thrown.
 * - Records of record are UNIONED, never replaced. A sync cannot delete a workout.
 * - Access tokens live in memory only. Only two flags touch localStorage:
 *   `ll.driveConnected` (boolean) and `ll.driveLastSync` (ms epoch).
 */

// Substituted at deploy time by the build/deploy step.
const CLIENT_ID = '960885435346-8pgimoqlld32k8f92k1ufesq1ur4mjhv.apps.googleusercontent.com';

const SCOPES =
  'https://www.googleapis.com/auth/drive.appdata ' +
  'https://www.googleapis.com/auth/drive.file';

const BACKUP_NAME = 'liftlog-backup.json';
const CSV_NAME = 'LiftLog Workout History.csv';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const GSI_SRC = 'https://accounts.google.com/gsi/client';

// Treat tokens as expired 60s before their real expiry, to absorb clock skew
// and in-flight request time.
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

/* ------------------------------------------------------------------ */
/* In-memory state                                                     */
/* ------------------------------------------------------------------ */

let accessToken = null;      // never persisted anywhere
let tokenExpiresAt = 0;      // ms epoch, already reduced by the safety margin
let gsiLoadPromise = null;   // memoised script injection
let syncInFlight = null;     // debounce handle for syncNow

const listeners = new Set();
let idleResetTimer = null;

/* ------------------------------------------------------------------ */
/* Status broadcasting                                                 */
/* ------------------------------------------------------------------ */

function emitStatus(state, message) {
  const update = { state, message: message || '' };
  for (const cb of listeners) {
    // A broken UI listener must never break a sync.
    try { cb(update); } catch (_) { /* ignore */ }
  }
}

// After a terminal-looking state ('ok' | 'error' | 'offline') drift back to
// 'idle' so the UI does not get stuck showing a stale banner forever.
function emitTerminal(state, message) {
  emitStatus(state, message);
  if (idleResetTimer) clearTimeout(idleResetTimer);
  idleResetTimer = setTimeout(() => {
    idleResetTimer = null;
    emitStatus('idle');
  }, 5000);
}

/* ------------------------------------------------------------------ */
/* Small safe helpers                                                  */
/* ------------------------------------------------------------------ */

function lsGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* storage may be full/blocked */ }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
}

function describeError(err) {
  if (!err) return 'Unknown error';
  if (err.message === 'offline') return 'No network connection';
  if (typeof err.message === 'string' && err.message.indexOf('auth') === 0) {
    return 'Google sign-in failed';
  }
  return 'Sync problem — your local data is safe.';
}

/* ------------------------------------------------------------------ */
/* Google Identity Services — lazy loading and token lifecycle         */
/* ------------------------------------------------------------------ */

/**
 * Inject the GSI client script on first use only. Never at startup.
 * Resolves when loaded; rejects if offline or blocked, leaving the app
 * fully functional without it.
 */
function loadGsi() {
  if (typeof window !== 'undefined' && window.google &&
      window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (gsiLoadPromise) return gsiLoadPromise;
  gsiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Allow a retry on the next attempt (e.g. network came back).
      gsiLoadPromise = null;
      reject(new Error('gsi-load-failed'));
    };
    document.head.appendChild(script);
  });
  return gsiLoadPromise;
}

/**
 * Request an access token via the GIS token client.
 *
 * Token lifecycle rules:
 * - `interactive === false` -> `prompt: ''`, i.e. fully silent. Fails rather
 *   than showing UI (used for background syncs).
 * - `interactive === true`  -> default prompt, so the consent/account chooser
 *   may appear. Used only when the user explicitly triggered the action, or
 *   as a fallback after a silent request fails.
 *
 * A fresh token client is created per request so each call gets its own
 * callback/error_callback pair — this keeps the promise wiring simple and
 * avoids stale-callback bugs.
 */
function requestToken(interactive) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return; // GIS can fire callback after error_callback; take the first.
      settled = true;
      fn(arg);
    };

    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
          if (response && response.access_token) {
            accessToken = response.access_token;
            const seconds = Number(response.expires_in);
            tokenExpiresAt =
              Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 -
              TOKEN_SAFETY_MARGIN_MS;
            finish(resolve, accessToken);
          } else {
            finish(reject, new Error('auth-empty-response'));
          }
        },
        error_callback: (err) => {
          finish(reject, new Error('auth-' + ((err && err.type) || 'error')));
        },
      });
      client.requestAccessToken(interactive ? {} : { prompt: '' });
    } catch (err) {
      finish(reject, err);
    }
  });
}

/**
 * Return a usable access token, refreshing silently when possible.
 * Throws on failure; callers below catch everything.
 */
async function ensureToken(interactive) {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  try {
    return await requestToken(false); // silent first, always
  } catch (silentErr) {
    if (!interactive) throw silentErr;
    // Interactive fallback only for user-initiated actions.
    return await requestToken(true);
  }
}

/* ------------------------------------------------------------------ */
/* Drive REST plumbing                                                 */
/* ------------------------------------------------------------------ */

/**
 * fetch wrapper that always sends the Bearer token and, on HTTP 401,
 * drops the cached token, gets a fresh silent one and retries exactly once.
 * Any other failure surfaces as a non-ok Response (or a thrown network error)
 * for the caller to give up quietly on.
 */
async function driveFetch(url, options, token) {
  const opts = options || {};
  const sendWith = (tok) =>
    fetch(url, Object.assign({}, opts, {
      headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + tok }),
    }));

  let response = await sendWith(token);
  if (response.status === 401) {
    accessToken = null; // token revoked or hard-expired server-side
    const fresh = await ensureToken(false);
    response = await sendWith(fresh);
  }
  return response;
}

/**
 * Find a file by Drive query. `space` is 'appDataFolder' or null (My Drive).
 * Returns the id of the most recently modified match, or null if none exist.
 * Throws on HTTP/network failure.
 */
async function findFileId(query, space, token) {
  let url = DRIVE_API + '/files?q=' + encodeURIComponent(query) +
            '&fields=files(id,modifiedTime)&pageSize=10';
  if (space) url += '&spaces=' + space;

  const response = await driveFetch(url, {}, token);
  if (!response.ok) throw new Error('drive-list-failed-' + response.status);

  const data = await response.json().catch(() => null);
  const files = data && Array.isArray(data.files) ? data.files : [];
  if (files.length === 0) return null;

  files.sort((a, b) =>
    String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  return files[0].id;
}

/**
 * Build a multipart/related body for uploadType=multipart.
 *
 * Layout (CRLF line endings are required by the API):
 *   --<boundary>
 *   Content-Type: application/json; charset=UTF-8
 *
 *   <metadata JSON>
 *   --<boundary>
 *   Content-Type: <payload mime>
 *
 *   <payload bytes as string>
 *   --<boundary>--
 *
 * All newlines are written as explicit \r
 escape sequences — never literal
 * line breaks inside string literals.
 */
function buildMultipartBody(metadata, payload, payloadMime) {
  const boundary = 'liftlog' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const crlf = '\r\n';
  const body =
    '--' + boundary + crlf +
    'Content-Type: application/json; charset=UTF-8' + crlf + crlf +
    metadata + crlf +
    '--' + boundary + crlf +
    'Content-Type: ' + payloadMime + crlf + crlf +
    payload + crlf +
    '--' + boundary + '--';
  return {
    contentType: 'multipart/related; boundary=' + boundary,
    body: body,
  };
}

/** Create (multipart) or update (media PATCH) a file, depending on whether it exists. */
async function upsertFile(fileId, metadata, payload, payloadMime, token) {
  if (fileId) {
    // Existing file: PATCH with uploadType=media replaces content only.
    const response = await driveFetch(
      DRIVE_UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=media',
      { method: 'PATCH', headers: { 'Content-Type': payloadMime }, body: payload },
      token
    );
    if (!response.ok) throw new Error('drive-update-failed-' + response.status);
  } else {
    // New file: multipart so we can send metadata (name, parents) alongside content.
    const mp = buildMultipartBody(JSON.stringify(metadata), payload, payloadMime);
    const response = await driveFetch(
      DRIVE_UPLOAD + '/files?uploadType=multipart',
      { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body },
      token
    );
    if (!response.ok) throw new Error('drive-create-failed-' + response.status);
  }
}

/* ------------------------------------------------------------------ */
/* Pull                                                                */
/* ------------------------------------------------------------------ */

/** Download and parse liftlog-backup.json from appDataFolder. Null if absent. */
async function pullImpl() {
  const token = await ensureToken(false);
  const fileId = await findFileId(
    "name='" + BACKUP_NAME + "' and trashed=false", 'appDataFolder', token);
  if (!fileId) return null; // nothing backed up yet — not an error

  const response = await driveFetch(
    DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?alt=media', {}, token);
  if (!response.ok) throw new Error('drive-download-failed-' + response.status);

  const text = await response.text();
  const parsed = JSON.parse(text); // caller catches parse errors
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

/** Upload both artifacts: hidden JSON backup + visible CSV. */
async function pushImpl(payload) {
  const token = await ensureToken(false);
  const json = JSON.stringify(payload);

  // 1. Machine-readable restore point in the hidden per-app folder.
  const backupId = await findFileId(
    "name='" + BACKUP_NAME + "' and trashed=false", 'appDataFolder', token);
  await upsertFile(
    backupId,
    { name: BACKUP_NAME, parents: ['appDataFolder'] },
    json,
    'application/json',
    token
  );

  // 2. Human-readable CSV in the user's visible Drive (no parents -> root).
  //    Created by this app, hence covered by the narrow drive.file scope.
  const csv = toCsv(payload.workouts);
  const csvId = await findFileId(
    "name='" + CSV_NAME + "' and trashed=false", null, token);
  await upsertFile(
    csvId,
    { name: CSV_NAME }, // deliberately NO parents
    csv,
    'text/csv',
    token
  );

  return true;
}

/* ------------------------------------------------------------------ */
/* CSV generation                                                      */
/* ------------------------------------------------------------------ */

/** RFC-4180 field escaping: quote fields containing comma, quote or newline. */
function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function isoDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  try { return new Date(n).toISOString().slice(0, 10); } catch (_) { return ''; }
}

/**
 * Flatten workouts -> one row per set, header row first.
 *
 * A saved workout record is FLAT -- its `sets` array sits directly on the
 * workout and each set carries its own `exerciseName`. There is no
 * `workout.exercises` level. Walking a nested shape here silently produced a
 * header-only file, which looked like a broken upload but was actually a
 * correct upload of nothing.
 *
 *   { id, templateName, startTime, endTime, durationSec, volumeKg, setCount,
 *     sets: [ { exerciseId, exerciseName, setNumber, weightKg, reps,
 *               isWarmup, note, pr } ] }
 */
export function toCsv(workouts) {
  const header = 'date,workout,exercise,set_number,is_warmup,weight_kg,reps,estimated_1rm,notes';
  const lines = [header];

  const list = Array.isArray(workouts) ? workouts.slice() : [];
  // Oldest first: a spreadsheet reads better chronologically.
  list.sort((a, b) => (Number(a && a.startTime) || 0) - (Number(b && b.startTime) || 0));

  for (const workout of list) {
    if (!workout || typeof workout !== 'object') continue;
    const date = isoDate(workout.startTime);
    const workoutName = String(workout.templateName || '');
    const sets = Array.isArray(workout.sets) ? workout.sets : [];

    for (const set of sets) {
      if (!set || typeof set !== 'object') continue;
      const weight = Number(set.weightKg) || 0;
      const reps = Number(set.reps) || 0;
      // Epley estimated 1RM: w * (1 + reps / 30), blank when weight is 0.
      const estimated1rm = weight > 0 ? (weight * (1 + reps / 30)).toFixed(2) : '';

      lines.push([
        date,
        workoutName,
        String(set.exerciseName || ''),
        String(set.setNumber != null ? set.setNumber : ''),
        set.isWarmup ? 'true' : 'false',
        String(weight),
        String(reps),
        estimated1rm,
        String(set.note || ''),
      ].map(csvEscape).join(','));
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Merge — pure, union-only                                            */
/* ------------------------------------------------------------------ */

/**
 * Union of `local` and `remote` keyed by workout id.
 *
 * Semantics (must never change):
 * - Every workout present on either side is present in the result. Never dropped.
 * - Same id on both sides: the copy with the GREATER endTime wins.
 * - Exact endTime tie: LOCAL wins (local is seeded into the map first, and we
 *   only overwrite on strictly-greater endTime).
 * - Result sorted by startTime descending.
 * - Pure: neither input array nor its members are mutated.
 * - Tolerates remote being null/undefined/malformed; entries without an id
 *   (on either side) are skipped.
 */
export function mergeWorkouts(local, remote) {
  const byId = new Map();

  const ingest = (list) => {
    // Tolerate the wrapper form ({workouts:[...]}) as well as a bare array.
    // The call site unwraps already, but a future caller passing the payload
    // straight through must not silently drop every record.
    if (list && !Array.isArray(list) && Array.isArray(list.workouts)) list = list.workouts;
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || entry.id == null) continue;
      const existing = byId.get(entry.id);
      if (!existing) {
        byId.set(entry.id, entry);
        continue;
      }
      const existingEnd = Number(existing.endTime) || 0;
      const incomingEnd = Number(entry.endTime) || 0;
      if (incomingEnd > existingEnd) {
        byId.set(entry.id, entry); // replace reference, never mutate either object
      }
      // Equal (or unparseable) endTime -> keep what is already stored.
      // Local is ingested first, so ties naturally keep local.
    }
  };

  ingest(local);
  ingest(remote);

  return Array.from(byId.values()).sort((a, b) =>
    (Number(b.startTime) || 0) - (Number(a.startTime) || 0));
}

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

export const sync = {

  isConnected() {
    return lsGet('ll.driveConnected') === 'true';
  },

  lastSync() {
    const raw = lsGet('ll.driveLastSync');
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  },

  /**
   * Interactive consent flow. User-initiated only.
   * Resolves true on success, false on any failure. Never rejects.
   */
  async connect() {
    try {
      emitStatus('syncing', 'Connecting to Google Drive…');
      await loadGsi(); // lazy; throws when offline or blocked
      await requestToken(true); // interactive consent
      lsSet('ll.driveConnected', 'true');
      emitTerminal('ok', 'Google Drive connected');
      return true;
    } catch (err) {
      emitTerminal('error', describeError(err));
      return false;
    }
  },

  /**
   * Revoke the token if possible and clear the flags.
   * Does NOT touch local data or anything already stored in Drive.
   */
  async disconnect() {
    try {
      if (accessToken && typeof window !== 'undefined' && window.google &&
          window.google.accounts && window.google.accounts.oauth2 &&
          typeof window.google.accounts.oauth2.revoke === 'function') {
        window.google.accounts.oauth2.revoke(accessToken, () => {});
      }
    } catch (_) { /* best effort */ }
    accessToken = null;
    tokenExpiresAt = 0;
    lsRemove('ll.driveConnected');
    lsRemove('ll.driveLastSync');
    emitStatus('idle', 'Disconnected from Google Drive');
  },

  /**
   * Fetch the remote backup. Returns the parsed object ({ workouts: [...] })
   * or null (nothing stored / not connected / any failure). Never rejects.
   */
  async pull() {
    if (!this.isConnected()) return null;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      emitTerminal('offline', 'No network connection');
      return null;
    }
    try {
      emitStatus('syncing', 'Checking Google Drive…');
      const result = await pullImpl();
      emitStatus('idle');
      return result;
    } catch (err) {
      emitTerminal('error', describeError(err));
      return null;
    }
  },

  /**
   * Upload the payload (JSON backup + CSV). Resolves true/false. Never rejects.
   * payload = { workouts, exportedAt, schemaVersion }
   */
  async push(payload) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      emitTerminal('offline', 'No network connection');
      return false;
    }
    try {
      emitStatus('syncing', 'Backing up to Google Drive…');
      const ok = await pushImpl(payload);
      lsSet('ll.driveLastSync', String(Date.now()));
      emitTerminal('ok', 'Backup saved to Google Drive');
      return ok;
    } catch (err) {
      emitTerminal('error', describeError(err));
      return false;
    }
  },

  /**
   * Pull + merge + push in one step.
   * Rapid calls while one is in flight collapse into that in-flight request
   * (debounce) instead of racing each other.
   * Returns { merged, added, pushed, error }. Never rejects.
   */
  syncNow(payload) {
    if (syncInFlight) return syncInFlight;
    syncInFlight = this._runSync(payload).finally(() => { syncInFlight = null; });
    return syncInFlight;
  },

  /** Internal worker for syncNow — exposed as a method only for testability. */
  async _runSync(payload) {
    const result = { merged: null, added: 0, pushed: false, error: null };

    if (!this.isConnected()) {
      result.error = 'not-connected';
      return result;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      result.error = 'offline';
      emitTerminal('offline', 'No network connection');
      return result;
    }

    try {
      emitStatus('syncing', 'Syncing…');

      const remote = await pullImpl(); // may be null on first ever sync
      const localWorkouts =
        payload && Array.isArray(payload.workouts) ? payload.workouts : [];

      // Union, never replace: workouts that exist only on Drive survive,
      // workouts that exist only locally survive.
      const merged = mergeWorkouts(localWorkouts,
        remote && Array.isArray(remote.workouts) ? remote.workouts : []);

      result.merged = merged;
      result.added = Math.max(0, merged.length - localWorkouts.length);

      const outgoing = {
        workouts: merged,
        exportedAt: new Date().toISOString(),
        schemaVersion: payload && payload.schemaVersion != null
          ? payload.schemaVersion
          : 1,
      };

      result.pushed = await pushImpl(outgoing);
      if (result.pushed) {
        lsSet('ll.driveLastSync', String(Date.now()));
        emitTerminal('ok', 'Synced to Google Drive');
      } else {
        result.error = result.error || 'push-failed';
      }
    } catch (err) {
      result.error = (err && err.message) ? err.message : 'sync-failed';
      emitTerminal('error', describeError(err));
      // Local data untouched — IndexedDB remains the system of record.
    }

    return result;
  },

  /** Subscribe to {state, message} updates. Returns an unsubscribe function. */
  onStatus(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};
