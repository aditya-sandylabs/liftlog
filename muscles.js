/* muscles.js — "Muscles worked": which regions an exercise trains and the SVG
 * body map that shows them. Pure: no DOM, no storage, no network — the SVG is
 * returned as a string, so it runs under node for the tests.
 *
 * Data comes from bodymap.js, which is GENERATED (build/build_bodymap.py) from
 * build/authored/muscles.json + MIT-licensed body paths. Edit the authored
 * file and regenerate; never hand-edit bodymap.js.
 *
 * Colourblind rule (Aditya is red/green colourblind): primary vs secondary is
 * never carried by hue. Primary = solid fill; secondary = diagonal hatch in the
 * same colour; and every highlighted region is also NAMED in text beside the
 * figure, with a ● / ◍ glyph that repeats the solid/hatched distinction.
 */
import { BODY, PIECE_BOX, REGION_GEOM, REGIONS, MOVEMENT_MUSCLES,
         SLUG_MOVEMENT, GROUP_FALLBACK } from './bodymap.js';

export { REGIONS };

/* Same algorithm as features.js slugify / build_guides.py slugify. */
const slugify = n => String(n == null ? '' : n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* -> { primary: [regionId], secondary: [regionId], bias: string|null,
 *      estimated: bool } or null when nothing honest can be said.
 * `name` is the display name, used when the id is a short data.json id.
 * `group` is the coarse muscle group the app already stores ('Chest', …) and is
 * only used for exercises with no authored record (custom / Strong-imported).
 * Those come back `estimated: true` with no bias — a guessed bias would be an
 * invented one. */
export function musclesFor(exId, group, name) {
  /* The 21 PDF main lifts carry short data.json ids ('pull-up') while the
     authored tables key on slugify(name) ('pull-ups'), so try both. */
  const mv = (exId && SLUG_MOVEMENT[exId]) || (name && SLUG_MOVEMENT[slugify(name)]);
  const r = mv && MOVEMENT_MUSCLES[mv];
  if (r) return { primary: r.p.slice(), secondary: (r.s || []).slice(), bias: r.bias || null, estimated: false };
  const fb = group && GROUP_FALLBACK[group];
  if (fb && fb.length) return { primary: fb.slice(), secondary: [], bias: null, estimated: true };
  return null;
}

export function regionLabel(id) {
  return (REGIONS[id] && REGIONS[id].label) || id;
}

const escA = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = n => Math.round(n * 10) / 10;

/* Which views a set of regions needs, in display order. */
export function viewsFor(regionIds) {
  const need = new Set();
  for (const id of regionIds) for (const g of (REGION_GEOM[id] || [])) need.add(g.v);
  return ['front', 'back'].filter(v => need.has(v));
}

/* Spread label y positions so no two are closer than `gap`, staying as near
 * their anchors as possible (simple forward/backward sweep). */
function spread(ys, gap, lo, hi) {
  const out = ys.slice();
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out.length && out[out.length - 1] > hi) out[out.length - 1] = hi;
  for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  if (out.length && out[0] < lo) { const d = lo - out[0]; for (let i = 0; i < out.length; i++) out[i] += d; }
  return out;
}

let uid = 0;

/* Midlines of the two source figures. Every trained muscle here is bilateral,
 * so the map is ONE split figure: the viewer-left half of the front view
 * joined to the viewer-right half of the back view. One figure at twice the
 * scale of two side-by-side ones is what makes the labels legible on a phone. */
const MID_F = 362, MID_B = 1086, SHIFT_B = MID_F - MID_B;   // back half moves left by 724

/* Box of a region on the half of the split figure it is drawn on, in split
 * coordinates. Front pieces are kept only if left of the midline, back pieces
 * only if right of it. */
function splitBoxes(id) {
  const out = [];
  for (const g of (REGION_GEOM[id] || [])) {
    const b0 = PIECE_BOX[g.v][g.p];
    let b = b0;
    if (g.clip) {
      const [cx, cy, cw, ch] = g.clip;
      const x0 = Math.max(b0[0], cx), y0 = Math.max(b0[1], cy);
      const x1 = Math.min(b0[0] + b0[2], cx + cw), y1 = Math.min(b0[1] + b0[3], cy + ch);
      b = [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
    }
    if (!b[2] || !b[3]) continue;
    const cx = b[0] + b[2] / 2;
    if (g.v === 'front' && cx < MID_F) out.push({ v: 'front', b });
    if (g.v === 'back' && cx > MID_B) out.push({ v: 'back', b: [b[0] + SHIFT_B, b[1], b[2], b[3]] });
  }
  return out;
}

/* The body map. `info` is musclesFor()'s result. Cropped to the band the
 * highlighted muscles occupy (plus context) — "a portion of the body", not a
 * whole mannequin with a small coloured patch.
 *
 * opts.labels (default true): name each region in a gutter with a leader line
 * to it — front muscles in the left gutter, back muscles in the right. */
export function muscleMapSVG(info, opts = {}) {
  if (!info || !info.primary || !info.primary.length) return '';
  const labels = opts.labels !== false;
  const prim = info.primary.filter(id => REGION_GEOM[id]);
  const sec = (info.secondary || []).filter(id => REGION_GEOM[id] && !prim.includes(id));
  const all = prim.concat(sec);
  if (!all.length) return '';
  const id = 'mm' + (++uid);

  // Each region is named once, on the half where it shows the most area —
  // forearms appear on both halves, but two "Forearms" labels is noise.
  const home = new Map();
  for (const rid of all) {
    const area = { front: 0, back: 0 };
    for (const s of splitBoxes(rid)) area[s.v] += s.b[2] * s.b[3];
    home.set(rid, area.back > area.front ? 'back' : 'front');
  }
  const FS = 40, GAP = FS * 1.55;             // label pitch; the ● / ◍ glyphs
                                              // come from a fallback font with a tall line box
  const perSide = Math.max(...['front', 'back'].map(v => all.filter(r => home.get(r) === v).length));

  // Crop to the highlighted boxes, padded, with a minimum size so a lone
  // biceps still reads as an arm — and tall enough to stack the labels.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const rid of all) for (const { b } of splitBoxes(rid)) {
    x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[0] + b[2]);
    y0 = Math.min(y0, b[1]); y1 = Math.max(y1, b[1] + b[3]);
  }
  if (!isFinite(x0)) return '';
  const PAD = 50, MIN_W = 420, MIN_H = Math.max(460, perSide * GAP + 110);
  x0 -= PAD; x1 += PAD; y0 -= PAD + 40; y1 += PAD;       // +40: room for FRONT/BACK
  if (y1 - y0 < MIN_H) { const c = (y0 + y1) / 2; y0 = c - MIN_H / 2; y1 = c + MIN_H / 2; }
  // Keep the midline inside the crop, and roughly central, so the split reads.
  x0 = Math.min(x0, MID_F - MIN_W / 2); x1 = Math.max(x1, MID_F + MIN_W / 2);
  x0 = Math.max(20, x0); x1 = Math.min(704, x1);
  // Clamp to the figure, pushing any lost height to the other end so the
  // minimum (and so the label stack) survives a crop near the head or feet.
  if (y0 < 70) { y1 += 70 - y0; y0 = 70; }
  if (y1 > 1400) { y0 = Math.max(70, y0 - (y1 - 1400)); y1 = 1400; }
  const GUT = labels ? 400 : 0;
  const vx = x0 - GUT, vw = (x1 - x0) + 2 * GUT, vh = y1 - y0;

  let defs = `<pattern id="${id}h" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="16" height="16" class="mm-sec-bg"/><line x1="0" y1="0" x2="0" y2="16" class="mm-sec-line"/></pattern>` +
    `<clipPath id="${id}F"><rect x="-10" y="0" width="${MID_F + 10}" height="1448"/></clipPath>` +
    `<clipPath id="${id}B"><rect x="${MID_B}" y="0" width="400" height="1448"/></clipPath>`;
  let clipN = 0;

  const half = (v) => {
    const src = BODY[v];
    const role = new Map();                    // piece idx -> [{cls, clip}]
    for (const rid of all) {
      const cls = prim.includes(rid) ? 'p' : 's';
      for (const g of REGION_GEOM[rid]) if (g.v === v) {
        if (!role.has(g.p)) role.set(g.p, []);
        role.get(g.p).push({ cls, clip: g.clip });
      }
    }
    let g = `<g clip-path="url(#${id}${v === 'front' ? 'F' : 'B'})">`;
    g += `<path d="${src.outline}" class="mm-outline"/>`;
    for (const d of src.pieces) g += `<path d="${d}" class="mm-base"/>`;
    // Secondary first, primary on top, so a piece split between the two keeps
    // its primary band crisp.
    for (const want of ['s', 'p']) for (const [p, rs] of role) for (const r of rs) {
      if (r.cls !== want) continue;
      const fill = want === 'p' ? 'class="mm-pri"' : `class="mm-sec" fill="url(#${id}h)"`;
      if (r.clip) {
        const cid = `${id}c${clipN++}`;
        defs += `<clipPath id="${cid}"><rect x="${r.clip[0]}" y="${r.clip[1]}" width="${r.clip[2]}" height="${r.clip[3]}"/></clipPath>`;
        g += `<path d="${src.pieces[p]}" ${fill} clip-path="url(#${cid})"/>`;
      } else {
        g += `<path d="${src.pieces[p]}" ${fill}/>`;
      }
    }
    return g + '</g>';
  };

  defs += `<clipPath id="${id}K"><rect x="${r1(x0)}" y="${r1(y0)}" width="${r1(x1 - x0)}" height="${r1(vh)}"/></clipPath>`;
  let body = `<g clip-path="url(#${id}K)">` + half('front') +
    `<g transform="translate(${SHIFT_B} 0)">${half('back')}</g></g>`;
  body += `<line x1="${MID_F}" y1="${r1(y0 + 50)}" x2="${MID_F}" y2="${r1(y1)}" class="mm-mid"/>`;
  body += `<text x="${MID_F - 14}" y="${r1(y0 + 34)}" text-anchor="end" class="mm-view">FRONT</text>` +
          `<text x="${MID_F + 14}" y="${r1(y0 + 34)}" text-anchor="start" class="mm-view">BACK</text>`;

  let lab = '';
  if (labels) for (const side of ['front', 'back']) {
    const items = [];
    for (const rid of all) {
      if (home.get(rid) !== side) continue;
      const bs = splitBoxes(rid).filter(s => s.v === side).map(s => s.b);
      if (!bs.length) continue;
      // Anchor on the piece nearest the label's gutter, at its centre.
      const pick = bs.reduce((a, b) => side === 'front'
        ? (b[0] < a[0] ? b : a) : (b[0] + b[2] > a[0] + a[2] ? b : a));
      const ax = pick[0] + pick[2] / 2;
      const ay = Math.min(Math.max(pick[1] + pick[3] / 2, y0 + 60), y1 - 20);
      items.push({ rid, ax, ay, cls: prim.includes(rid) ? 'p' : 's' });
    }
    items.sort((a, b) => a.ay - b.ay);
    const ys = spread(items.map(i => i.ay), GAP, y0 + 70, y1 - 20);
    const gx = side === 'front' ? x0 - 8 : x1 + 8;
    const ta = side === 'front' ? 'end' : 'start';
    items.forEach((it, k) => {
      const ty = ys[k];
      const glyph = it.cls === 'p' ? '\u25CF' : '\u25CD';      // ● solid / ◍ hatched
      lab += `<polyline points="${r1(it.ax)},${r1(it.ay)} ${r1(gx)},${r1(ty)}" class="mm-lead"/>` +
        `<circle cx="${r1(it.ax)}" cy="${r1(it.ay)}" r="7" class="mm-dot"/>` +
        `<text x="${r1(side === 'front' ? gx - 8 : gx + 8)}" y="${r1(ty + FS * 0.35)}" text-anchor="${ta}" ` +
        `class="mm-lab mm-lab-${it.cls}">${side === 'front' ? '' : glyph + ' '}${escA(regionLabel(it.rid))}${side === 'front' ? ' ' + glyph : ''}</text>`;
    });
  }

  const title = 'Muscles worked. Primary: ' + prim.map(regionLabel).join(', ') +
    (sec.length ? '. Secondary: ' + sec.map(regionLabel).join(', ') : '') + '.';
  return `<svg class="mm" viewBox="${r1(vx)} ${r1(y0)} ${r1(vw)} ${r1(vh)}" role="img" aria-label="${escA(title)}" ` +
    `preserveAspectRatio="xMidYMid meet" style="font-size:${FS}px"><defs>${defs}</defs>${body}${lab}</svg>`;
}

/* The block that sits on an exercise screen: map + primary/secondary lists +
 * the bias sentence. `esc` is the app's HTML escaper. Returns '' when there is
 * nothing to show, so callers can drop it in unconditionally. */
export function musclesBlockHTML(info, opts = {}) {
  if (!info) return '';
  const svg = muscleMapSVG(info, opts);
  if (!svg) return '';
  const list = (ids, glyph) => ids.map(r => {
    const a = REGIONS[r] && REGIONS[r].anatomy;
    return `<li><span class="mm-g" aria-hidden="true">${glyph}</span>${escA(regionLabel(r))}` +
      (a ? ` <span class="muted small">${escA(a)}</span>` : '') + `</li>`;
  }).join('');
  const sec = (info.secondary || []).filter(r => !info.primary.includes(r));
  const bias = info.bias
    ? `<p class="mm-bias"><strong>Bias</strong>${escA(info.bias)}</p>` : '';
  const est = info.estimated
    ? `<p class="muted small">Estimated from the muscle group you gave this exercise — no bias recorded.</p>` : '';
  return `<div class="mm-wrap">${svg}</div>
    <div class="mm-lists">
      <div><h4>Primary</h4><ul>${list(info.primary, '\u25CF')}</ul></div>
      ${sec.length ? `<div><h4>Secondary</h4><ul>${list(sec, '\u25CD')}</ul></div>` : ''}
    </div>${bias}${est}`;
}
