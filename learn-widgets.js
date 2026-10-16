/* Learn widgets: framework-free, scoped, and safe to unmount. */
import { BODY, PIECE_BOX, REGION_GEOM, REGIONS } from './bodymap.js';
const round = (n, step) => Number((Math.round(n / step) * step).toFixed(8));
export function mifflin({sex, age, height, weight}) {
  return 10 * weight + 6.25 * height - 5 * age + (sex === 'female' ? -161 : 5);
}
export function calculateMacros(person, activity, goal, fatPct) {
  const bmr = mifflin(person);
  const energy = bmr * activity * (1 + goal.kcalPct / 100);
  const floor = Math.max(bmr, person.sex === 'female' ? 1200 : 1500);
  if (goal.kcalPct < 0 && (energy < floor || round(energy,10) < floor)) return {belowFloor:true, feasible:false};
  const protein = goal.proteinPerKg.map(x => person.weight * x);
  const fat = fatPct.map(x => energy * x / 100 / 9);
  const carbs = [Math.max(0, (energy - protein[1] * 4 - fat[1] * 9) / 4), Math.max(0, (energy - protein[0] * 4 - fat[0] * 9) / 4)];
  return {bmr, kcal: round(energy, 10), protein: protein.map(n => round(n, 5)), fat: fat.map(n => round(n, 5)), carbs: carbs.map(n => round(n, 5)), feasible: protein[1] * 4 + fat[1] * 9 <= energy};
}

const obj = p => !!p && typeof p === 'object' && !Array.isArray(p);
const num = Number.isFinite;
const text = s => typeof s === 'string' && s.trim().length > 0;
const list = (a, fn, min = 1, max = 100) => Array.isArray(a) && a.length >= min && a.length <= max && a.every(fn);
const pair = (a, lo = 0, hi = Infinity) => list(a, n => num(n) && n >= lo && n <= hi, 2, 2) && a[0] <= a[1];
export function plateSharesValid(p) {
  return obj(p) && list(p.variants, v => obj(v) && list(v.wedges, w => obj(w) && num(w.share) && w.share > 0 && w.share <= 1) && Math.abs(v.wedges.reduce((s, w) => s + w.share, 0) - 1) < 0.000001);
}
const keys = {
  'body-atlas': ['view','focus','prompt','tours'], sarcomere: [],
  chart: ['kind','title','xLabel','yLabel','x','series','note','hypothetical'],
  'slider-explainer': ['label','stops','initial'], plate: ['title','variants','hypothetical'],
  'macro-calc': ['activity','goals','fatPctKcal','sources_note','hypothetical'],
  'food-compare': ['foods','metric','labels'], 'energy-balance': ['intake','burn','step','labels','note','hypothetical'],
  'tier-list': ['tiers'], checklist: ['title','groups','persistKey'], tempo: ['phases','reps']
};
export function validateParams(type, p) {
  if (obj(p) && p.hypothetical !== undefined && typeof p.hypothetical !== 'boolean') return false;
  if (!obj(p) || !keys[type] || Object.keys(p).some(k => !keys[type].includes(k))) return false;
  switch (type) {
    case 'body-atlas': return (p.view === undefined || ['front','back','both'].includes(p.view)) && (p.focus === undefined || list(p.focus, id => text(id) && Object.hasOwn(REGIONS,id), 0)) && (p.prompt === undefined || text(p.prompt)) && (p.tours === undefined || list(p.tours,t => obj(t) && text(t.name) && list(t.focus,id => text(id) && Object.hasOwn(REGIONS,id)),1,12));
    case 'sarcomere': return true;
    case 'chart': return ['line','bar'].includes(p.kind) && [p.title,p.xLabel,p.yLabel].every(text) && list(p.x, x => text(x) || num(x), 1, 24) && list(p.series, s => obj(s) && text(s.name) && list(s.values,num,p.x.length,p.x.length) && (s.style === undefined || ['solid','dashed','dotted'].includes(s.style)),1,6) && (p.note === undefined || text(p.note)) && (p.hypothetical === undefined || typeof p.hypothetical === 'boolean');
    case 'slider-explainer': return text(p.label) && list(p.stops, s => obj(s) && num(s.value) && text(s.title) && text(s.text) && (s.tag === undefined || text(s.tag)),2) && new Set(p.stops.map(s => s.value)).size === p.stops.length && (p.initial === undefined || num(p.initial));
    case 'plate': return text(p.title) && plateSharesValid(p) && p.variants.every(v => text(v.name) && list(v.wedges, w => text(w.label) && text(w.why) && list(w.examples,text),1,12));
    case 'macro-calc': return list(p.activity, a => obj(a) && text(a.label) && num(a.factor) && a.factor > 0 && a.factor <= 5) && list(p.goals, g => obj(g) && text(g.label) && num(g.kcalPct) && g.kcalPct > -100 && g.kcalPct <= 200 && pair(g.proteinPerKg,0,10)) && pair(p.fatPctKcal,0,100) && text(p.sources_note);
    case 'food-compare': return list(p.foods,text,1,20) && obj(p.labels) && p.foods.every(id=>Object.hasOwn(p.labels,id)&&text(p.labels[id])) && Object.values(p.labels).every(text) && (p.metric === undefined || ['per100g','per100kcal'].includes(p.metric));
    case 'energy-balance': {
      const range = a => list(a,num,3,3) && a[0] >= 0 && a[0] < a[1] && a[2] >= a[0] && a[2] <= a[1];
      return range(p.intake) && range(p.burn) && num(p.step) && p.step > 0 && obj(p.labels) && [p.labels.gain,p.labels.maintain,p.labels.lose,p.note].every(text);
    }
    case 'tier-list': return list(p.tiers,t => obj(t) && text(t.name) && text(t.blurb) && list(t.items,i => obj(i) && text(i.name) && text(i.what) && (i.dose === undefined || text(i.dose)) && (i.note === undefined || text(i.note)) && (i.caution === undefined || text(i.caution))));
    case 'checklist': return text(p.title) && list(p.groups,g => obj(g) && text(g.title) && list(g.items,text)) && (p.persistKey === undefined || text(p.persistKey));
    case 'tempo': return list(p.phases,f => obj(f) && text(f.name) && num(f.sec) && f.sec > 0 && f.sec <= 600,1,12) && (p.reps === undefined || Number.isInteger(p.reps) && p.reps > 0 && p.reps <= 100);
    default: return false;
  }
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The lesson renderer owns supported links. Without it, escape plain text.
const plain = s => String(s ?? '').replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g,'$1').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\*([^*]+)\*/g,'$1');
const renderInline = (s, ctx) => typeof ctx?.inline === 'function' ? ctx.inline(String(s ?? '')) : esc(plain(s));
const renderButton = (label, attrs = '', ctx) => `<button type="button" class="lw-btn" ${attrs}>${renderInline(label,ctx)}</button>`;
const svg = (body, box, label) => `<svg class="lw-svg" viewBox="${box}" role="group" aria-label="${esc(label)}">${body}</svg>`;
const renderNote = (s,ctx) => `<p class="lw-note">${renderInline(s,ctx)}</p>`;
const status = s => `<div class="lw-status" aria-live="polite">${s}</div>`;
const patterns = id => `<defs>${['diagonal','dots','grid','horizontal'].map((_,i) => `<pattern id="${id}-${i}" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" class="lw-pattern-bg"/>${i % 4 === 0 ? '<path d="M-3 3L3-3M0 12L12 0M9 15L15 9"/>' : i % 4 === 1 ? '<circle cx="6" cy="6" r="1.8"/>' : i % 4 === 2 ? '<path d="M0 0H12M0 0V12"/>' : '<path d="M0 6H12"/>'}</pattern>`).join('')}</defs>`;
let uid = 0;
function unavailable(el, type, error, ctx) {
  console.warn('[Learn widget] ' + type + ': Diagram unavailable', error || 'Invalid params');
  if (el) el.innerHTML = (type === 'macro-calc' ? '<div class="lw-banner">An estimate to start from, not a prescription. Adjust by your weekly weight trend.</div>' : '') + renderNote('Diagram unavailable',ctx);
}
function scope(el, ctx) {
  const listeners = [], timers = new Set();
  let alive = true;
  return {
    motion: !!ctx.reducedMotion || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    get alive() {return alive;},
    on(event, fn) {el.addEventListener(event,fn); listeners.push([event,fn]);},
    every(fn, ms) {const t = setInterval(fn, ms); timers.add(t); return t;},
    stop(t) {clearInterval(t); timers.delete(t);},
    cleanup() {alive = false; for (const [event,fn] of listeners) el.removeEventListener(event,fn); for(const t of timers) clearInterval(t); timers.clear();}
  };
}

function atlas(el, p, ctx, s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  let view = p.view === 'back' ? 'back' : 'front', selected = null;
  let tour = p.tours ? 0 : -1, focus = p.tours?.[0].focus || p.focus || [];
  const id = 'lwa' + ++uid;
  if(p.tours) view=REGION_GEOM[focus[0]][0].v;
  const name = rid => ctx.regions?.[rid]?.name || REGIONS[rid].label;
  el.innerHTML = `<p class="lw-prompt">${inline(p.prompt || 'Tap a muscle to explore.')}</p><div class="lw-tabs lw-tour-tabs">${(p.tours||[]).map((t,i)=>button(t.name,`data-tour="${i}"`)).join('')}</div><div class="lw-tabs">${button('Front','data-view="front"')}${button('Back','data-view="back"')}</div>${note('● Selected = solid · ◍ Focus = hatch')}<div class="lw-body"></div><div class="lw-atlas-result" aria-live="polite"></div><div class="lw-panel"></div><div class="lw-region-picker"></div>`;
  function panel() {
    const target = el.querySelector('.lw-panel'), result=el.querySelector('.lw-atlas-result');
    const r = ctx.regions?.[selected] || {};
    result.innerHTML = selected ? `<strong>● ${inline(name(selected))}</strong><p>${inline(r.does || r.plain || 'Anatomy details unavailable.')}</p>` : note('Choose a muscle above. You can also use the named buttons.');
    if (!selected) {target.innerHTML = note('Choose a muscle above. You can also use the named buttons.'); return;}
    target.innerHTML = `<h3>● ${inline(name(selected))}</h3><p>${inline(r.plain || 'Anatomy details unavailable.')}</p>${r.does ? `<p><strong>What it does</strong> ${inline(r.does)}</p>` : ''}${r.fact ? `<p class="lw-fact">${inline(r.fact)}</p>` : ''}<div class="lw-chips">${(Array.isArray(r.train) ? r.train : []).filter(text).map(slug => button(ctx.exerciseName?.(slug) || slug,`data-exercise="${esc(slug)}"`)).join('')}</div>`;
  }
  function draw() {
    let defs = patterns(id), body = `<path class="lw-outline" d="${BODY[view].outline}"/>` + BODY[view].pieces.map(d => `<path class="lw-body-base" d="${d}"/>`).join('');
    for (const [rid, geoms] of Object.entries(REGION_GEOM)) for (const [index, g] of geoms.entries()) {
      if (g.v !== view) continue;
      let clip = '';
      if (g.clip) {
        const cid = `${id}-${rid}-${index}`;
        defs += `<defs><clipPath id="${cid}"><rect x="${g.clip[0]}" y="${g.clip[1]}" width="${g.clip[2]}" height="${g.clip[3]}"/></clipPath></defs>`;
        clip = `clip-path="url(#${cid})"`;
      }
      const b = g.clip || PIECE_BOX[view][g.p];
      body += `<path role="button" tabindex="0" aria-label="${esc(name(rid))}" aria-pressed="${selected === rid}" data-region="${rid}" data-box="${b.join(',')}" class="lw-region${selected === rid ? ' lw-selected' : ''}" fill="${selected === rid ? 'var(--accent)' : focus.includes(rid) ? `url(#${id}-0)` : 'var(--surface2)'}" ${clip} d="${BODY[view].pieces[g.p]}"/>`;
    }
    // One view at a time: the source's full viewBox preserves real anatomy.
    el.querySelector('.lw-body').innerHTML = svg(defs + body, BODY[view].viewBox.join(' '), view + ' anatomy. Tap a muscle.');
    el.querySelectorAll('[data-tour]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.tour===tour)));
    el.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.view === view)));
    el.querySelector('.lw-region-picker').innerHTML = `<details class="lw-details"><summary>Choose by name (all 23 muscles)</summary><div class="lw-chips">${Object.keys(REGIONS).map(rid => button(name(rid),`data-pick="${rid}" aria-pressed="${selected === rid}"`)).join('')}</div></details>`;
    panel();
  }
  function select(rid) {selected = rid; draw();}
  s.on('click', e => {
    const t = e.target.closest('[data-tour]'); if(t){tour=+t.dataset.tour;focus=p.tours[tour].focus;view=REGION_GEOM[focus[0]][0].v;selected=null;draw();return;}
    const v = e.target.closest('[data-view]'); if (v) {view = v.dataset.view;tour=-1;focus=p.focus||[];selected=null;draw();return;}
    const r = e.target.closest('[data-region],[data-pick]');
    if (r) {
      const rid = r.dataset.region || r.dataset.pick;
      if (r.dataset.pick && !REGION_GEOM[rid].some(g => g.v === view)) view = REGION_GEOM[rid][0].v;
      select(rid); return;
    }
    const ex = e.target.closest('[data-exercise]'); if (ex) ctx.openExercise?.(ex.dataset.exercise);
  });
  s.on('keydown', e => {if (e.target.matches('[data-region]') && ['Enter',' '].includes(e.key)) {e.preventDefault(); const rid = e.target.dataset.region; select(rid); el.querySelector(`[data-region="${rid}"]`)?.focus();}});
  draw();
}
function sarcomere(el, p, ctx, s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  let n = 0, timer;
  el.innerHTML = `<h3>Slide, don't shrink</h3><div class="lw-filaments"></div><label class="lw-control">Contraction <input type="range" min="0" max="100" value="0" aria-label="Contraction"/></label><div class="lw-row"><span>Relaxed</span><span>Contracted</span></div>${s.motion ? note('Reduced motion: explore with the slider.') : button('Play','data-play')}${status('Relaxed · 0% contraction')}`;
  function draw() {
    const shift = n * .6, left = 25 + shift, right = 335 - shift;
    el.querySelector('.lw-filaments').innerHTML = svg(`<line x1="${left}" y1="35" x2="${left}" y2="145" class="lw-z"/><line x1="${right}" y1="35" x2="${right}" y2="145" class="lw-z"/><path d="M${left} 65h110 M${left} 115h110 M${right} 65h-110 M${right} 115h-110" class="lw-actin"/><path d="M120 90H240" class="lw-myosin"/>${Array.from({length:7},(_,i) => `<path d="M${125+i*18} 90l-7 -18 M${125+i*18} 90l7 18" class="lw-bridge"/>`).join('')}<text x="${left}" y="23" text-anchor="middle">Z-line</text><text x="80" y="163">Actin — thin</text><text x="205" y="163">Myosin — thick</text><text x="180" y="43" text-anchor="middle">Cross-bridges</text>`, '0 0 360 180','Sarcomere. Actin slides past myosin; Z-lines approach.');
    el.querySelector('.lw-status').textContent = `${n === 0 ? 'Relaxed' : n === 100 ? 'Contracted' : 'Sliding together'} · ${n}% contraction`;
  }
  s.on('input',e => {if(e.target.matches('input')) {n=+e.target.value; draw();}});
  s.on('click',e => {if(!e.target.closest('[data-play]')) return; const b=el.querySelector('[data-play]'); if(timer) {s.stop(timer); timer=null; b.textContent='Play';} else {if(n>=100)n=0; b.textContent='Pause'; timer=s.every(()=>{n=Math.min(n+2,100); el.querySelector('input').value=n; draw(); if(n===100){s.stop(timer);timer=null;b.textContent='Play';}},40);}});
  draw();
}
const dash = (style, index) => style === 'dashed' ? '10 5' : style === 'dotted' ? '2 5' : style === 'solid' ? '' : ['', '10 5', '2 5', '12 4 2 4', '5 4', '12 4 2 4 2 4'][index];
function chart(el, p, ctx, s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  const id='lwc'+ ++uid, width=320, left=42, right=298, top=24, bottom=215;
  const used=new Set(), choices=['','10 5','2 5','12 4 2 4','5 4','12 4 2 4 2 4'];
  const styles=p.series.map((a,i)=>{let d=dash(a.style,i);if(used.has(d))d=choices.find(x=>!used.has(x));used.add(d);return d;});
  const values=p.series.flatMap(a=>a.values), lo=Math.min(0,...values), hi=Math.max(1,...values);
  const X=i=>left+(p.x.length===1 ? .5 : i/(p.x.length-1))*(right-left), Y=v=>bottom-(v-lo)/(hi-lo)*(bottom-top);
  const wordX=p.x.every(x=>text(x)&&!Number.isFinite(Number(x)));
  const xEnds=/week|time|session|day/i.test(p.xLabel)?['early','later']:['less','more'];
  const position=i=>p.hypothetical ? (wordX?p.x[i]:i===0?xEnds[0]:i===p.x.length-1?xEnds[1]:'middle') : p.x[i];
  const pointLabel=(a,i)=>p.hypothetical ? `${a.name} · ${position(i)} — Illustration, not measured data` : `${a.name} · ${p.x[i]}: ${a.values[i]} ${p.yLabel}`;
  let body = patterns(id) + `<path d="M${left} ${top}V${bottom}H${right}" class="lw-axis"/>`;
  for(let i=0;i<=4;i++){
    const v=lo+(hi-lo)*i/4,y=Y(v);
    body+=`<path d="M${left} ${y}H${right}" class="lw-grid"/>`;
    if(!p.hypothetical || i===0 || i===4)body+=`<text class="lw-y-tick" x="${left-6}" y="${y+4}" text-anchor="end">${p.hypothetical ? (i===0?'less':'more') : round(v,1)}</text>`;
  }
  p.series.forEach((a,si)=>{
    const stroke=`stroke-dasharray="${styles[si]}"`;
    if(p.kind==='line') body+=`<polyline points="${a.values.map((v,i)=>`${X(i)},${Y(v)}`).join(' ')}" class="lw-series" ${stroke}/>`;
    a.values.forEach((v,i)=>{
      const attrs=`role="button" tabindex="0" aria-label="${esc(pointLabel(a,i))}" data-point="${si},${i}"`;
      if(p.kind==='line') body+=`<g ${attrs}><circle cx="${X(i)}" cy="${Y(v)}" r="24" class="lw-hit"/><circle cx="${X(i)}" cy="${Y(v)}" r="4" class="lw-point"/></g>`;
      else {const bw=(right-left)/(p.x.length*p.series.length+1),bx=left+(i*p.series.length+si+.2)*bw; body+=`<g ${attrs}><rect x="${bx}" y="${Math.min(Y(0),Y(v))}" width="${bw*.8}" height="${Math.max(2,Math.abs(Y(0)-Y(v)))}" fill="url(#${id}-${si%4})" class="lw-bar" ${stroke}/></g>`;}
    });
  });
  el.innerHTML=`<h3>${inline(p.title)}</h3><p class="lw-chart-axis-label">${inline(p.yLabel)}${p.hypothetical?' · less → more':''}</p>${svg(body,`0 0 ${width} 242`,p.title)}<div class="lw-chart-x-ticks">${(p.hypothetical?(wordX?p.x:xEnds):p.x).map(x=>`<span>${inline(x)}</span>`).join('')}</div><p class="lw-chart-axis-label">${inline(p.xLabel)}</p><div class="lw-legend">${p.series.map((a,i)=>`<span><svg class="lw-swatch" viewBox="0 0 40 10" aria-hidden="true"><path class="lw-series" d="M0 5H40" stroke="currentColor" stroke-width="3" stroke-dasharray="${styles[i]}"/></svg>${inline(a.name)}</span>`).join('')}</div>${status(p.hypothetical?'Tap a point or bar to explore the illustration.':'Tap a point or bar to inspect its value.')}<details class="lw-details"><summary>Explore by name</summary><div class="lw-chips">${p.series.flatMap((a,si)=>a.values.map((v,i)=>button(pointLabel(a,i),`data-point="${si},${i}"`))).join('')}</div></details>${p.note ? note(p.note) : ''}`;
  const choose=e=>{const t=e.target.closest('[data-point]'); if(t){const [a,i]=t.dataset.point.split(',').map(Number); el.querySelector('.lw-status').innerHTML=inline(pointLabel(p.series[a],i));}};
  s.on('click',choose); s.on('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.closest('[data-point]')){e.preventDefault();choose(e);}});
}
function slider(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  const stops=[...p.stops].sort((a,b)=>a.value-b.value);
  let index=stops.reduce((best,x,i)=>Math.abs(x.value-(p.initial??stops[0].value))<Math.abs(stops[best].value-(p.initial??stops[0].value)) ? i : best,0);
  el.innerHTML=`<label class="lw-control">${inline(p.label)}<input type="range" min="0" max="${stops.length-1}" step="1" value="${index}" aria-label="${esc(p.label)}"/></label><div class="lw-row"><span>${esc(stops[0].value)}</span><span>${esc(stops.at(-1).value)}</span></div><div class="lw-stop" aria-live="polite"></div>`;
  function draw(){const stop=stops[index];el.querySelector('input').setAttribute('aria-valuetext',`${stop.value}: ${stop.title}`);el.querySelector('.lw-stop').innerHTML=`${stop.tag?`<span class="lw-tag">${inline(stop.tag)}</span>`:''}<h3>${esc(stop.value)} · ${inline(stop.title)}</h3><p>${inline(stop.text)}</p>`;}
  s.on('input',e=>{if(e.target.matches('input')){index=+e.target.value;draw();}});draw();
}
function plate(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  let variant=0, selected=0; const id='lwp'+ ++uid;
  el.innerHTML=`<h3>${inline(p.title)}</h3><div class="lw-tabs">${p.variants.map((v,i)=>button(v.name,`data-variant="${i}"`)).join('')}</div><div class="lw-plate-figure"></div><div class="lw-wedges"></div><div class="lw-panel" aria-live="polite"></div>`;
  function draw(){
    const v=p.variants[variant];let angle=-Math.PI/2,body=patterns(id);
    v.wedges.forEach((w,i)=>{const end=angle+w.share*2*Math.PI,point=a=>[160+125*Math.cos(a),160+125*Math.sin(a)],a=point(angle),b=point(end),mid=(angle+end)/2;
      const path=w.share===1 ? 'M160 35A125 125 0 1 1 159.999 35Z' : `M160 160L${a}A125 125 0 ${w.share>.5?1:0} 1 ${b}Z`;
      body+=`<path d="${path}" fill="url(#${id}-${i%4})" class="lw-wedge${i===selected?' lw-wedge-on':''}" data-wedge="${i}" role="button" tabindex="0" aria-label="${esc(w.label)}" aria-pressed="${i===selected}"/><text x="${160+82*Math.cos(mid)}" y="${165+82*Math.sin(mid)}" text-anchor="middle" class="lw-wedge-label">${i+1}</text>`;angle=end;
    });
    el.querySelector('.lw-plate-figure').innerHTML=svg(body,'0 0 320 320',p.title+' — '+v.name);
    el.querySelectorAll('[data-variant]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.variant===variant)));
    el.querySelector('.lw-wedges').innerHTML=v.wedges.map((w,i)=>button(`${i+1}. ${w.label} · ${round(w.share*100,1)}%`,`data-wedge="${i}" aria-pressed="${i===selected}"`)).join('');
    const w=v.wedges[selected];el.querySelector('.lw-panel').innerHTML=`<h3>${inline(w.label)}</h3><p>${inline(w.why)}</p><p class="lw-note">${inline('Try: ')}${w.examples.map(x=>inline(x)).join(', ')}</p>`;
  }
  const choose=e=>{const v=e.target.closest('[data-variant]'),w=e.target.closest('[data-wedge]');if(v){variant=+v.dataset.variant;selected=0;draw();}else if(w){selected=+w.dataset.wedge;draw();}};
  s.on('click',choose);s.on('keydown',e=>{if(e.target.matches('path[data-wedge]')&&['Enter',' '].includes(e.key)){e.preventDefault();const i=e.target.dataset.wedge;choose(e);el.querySelector(`path[data-wedge="${i}"]`)?.focus();}});draw();
}
function macro(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  const optionText=text=>{const span=document.createElement('span');span.innerHTML=inline(text);return esc(span.textContent);};
  const select=(label,key,options)=>`<label class="lw-control" ${key==='goal'?'data-goal-control':''}>${inline(label)}<select data-field="${key}" aria-label="${label}">${`<option value="">${key==='goal'?'Choose your goal':'Choose…'}</option>`}${options.map((o,i)=>`<option value="${i}">${optionText(o.label)}</option>`).join('')}</select>${key==='goal'?'<span class="lw-selected-goal" aria-live="polite"></span>':''}</label>`;
  const input=(label,key,value,min,max)=>`<label class="lw-control">${label}<input type="number" data-field="${key}" value="${value}" min="${min}" max="${max}" step="${key==='weight'?'0.1':'1'}" inputmode="decimal" aria-label="${label}"/></label>`;
  el.innerHTML=`<div class="lw-banner">An estimate to start from, not a prescription. Adjust by your weekly weight trend.</div><div class="lw-form"><label class="lw-control">Sex (formula)<select data-field="sex" aria-label="Sex (formula)"><option value="male">Male</option><option value="female">Female</option></select></label>${input('Age (years)','age','',18,100)}${input('Height (cm)','height','',100,250)}${input('Weight (kg)','weight','',30,350)}${select('Activity','activity',p.activity)}${select('Goal','goal',p.goals)}</div><p class="lw-how-to"><strong>${inline("Pick a protein amount and a fat amount inside these ranges; carbs fill the rest of your calories. Don't add up all the top ends.")}</strong></p><div class="lw-macro-output" aria-live="polite"></div>${note(p.sources_note)}${note('Adult estimate. Carbohydrate range is the remainder after the protein and fat ranges; these endpoints are not separate simultaneous targets.')}`;
  function draw(){
    const fields=Object.fromEntries([...el.querySelectorAll('[data-field]')].map(i=>[i.dataset.field,i.value]));
    el.querySelector('.lw-selected-goal').innerHTML=fields.goal===''?'':inline(p.goals[+fields.goal].label);
    const out=el.querySelector('.lw-macro-output'),person={sex:fields.sex,age:+fields.age,height:+fields.height,weight:+fields.weight};
    if([...el.querySelectorAll('input')].some(i=>i.value==='')||fields.activity===''||fields.goal===''){out.innerHTML=note('Enter your details and choose a goal to see an estimate');return;}
    if([...el.querySelectorAll('input')].some(i=>!i.checkValidity())){out.innerHTML=note('Enter valid adult age, height in cm and weight in kg.');return;}
    const r=calculateMacros(person,p.activity[+fields.activity].factor,p.goals[+fields.goal],p.fatPctKcal);
    if(r.belowFloor){out.innerHTML=`<p class="lw-floor"><strong>${inline('Your estimate falls below a safe minimum for dieting on your own. Please talk to a doctor or registered dietitian before cutting calories.')}</strong></p>`;return;}
    out.innerHTML=`<p class="lw-big">${r.kcal.toLocaleString('en-US')} <span>kcal/day</span></p><dl class="lw-macros">${['protein','fat','carbs'].map(k=>`<div><dt>${k==='carbs'?'Carbs':k[0].toUpperCase()+k.slice(1)}</dt><dd>${r[k].join('–')} g</dd></div>`).join('')}</dl>${note('Estimated BMR: '+round(r.bmr,10)+' kcal/day')}${!r.feasible ? note('These ranges exceed the energy estimate. Review the lesson inputs rather than treating this as a target.') : ''}`;
  }
  s.on('input',draw);s.on('change',draw);draw();
}
function foodCompare(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  let metric=p.metric||'per100g',foods=[],sort=false;
  el.innerHTML=`<div class="lw-tabs">${button('Per 100 g','data-metric="per100g"')}${button('Per 100 kcal','data-metric="per100kcal"')}</div>${button('Sort by protein ↓','data-sort aria-pressed="false"')}<p class="lw-food-basis">${inline('Per 100 g of the food as listed — not equal meal portions.')}</p><div class="lw-foods" aria-live="polite">${note('Loading food data…')}</div>`;
  const quantity=f=>metric==='per100kcal'?100/f.k:1;
  function draw(){
    el.querySelector('.lw-food-basis').innerHTML=inline(metric==='per100g'?'Per 100 g of the food as listed — not equal meal portions.':'Per 100 kcal of the food as listed — not equal meal portions.');
    el.querySelectorAll('[data-metric]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.metric===metric)));
    el.querySelector('[data-sort]').setAttribute('aria-pressed',String(sort));
    const sorted=sort ? [...foods].sort((a,b)=>b.p*quantity(b)-a.p*quantity(a)) : foods;
    const max=Math.max(1,...foods.map(f=>f.p*quantity(f)));
    el.querySelector('.lw-foods').innerHTML=sorted.length ? sorted.map(f=>{const q=quantity(f),protein=round(f.p*q,.1),label=`${p.labels[f.i]}: ${protein} g protein ${metric==='per100g'?'per 100 g':'per 100 kcal'}`;return `<div class="lw-food" data-food="${esc(f.i)}"><strong>${inline(p.labels[f.i])}</strong><span class="lw-food-db lw-note">${inline(f.n)}</span>${svg(`<rect x="0" y="8" width="${protein/max*230}" height="20" class="lw-food-bar"/><text x="245" y="24">${protein} g</text>`,'0 0 330 38',label)}<p class="lw-note">${round(f.k*q,.1)} kcal · ${round(f.c*q,.1)} g carbs · ${round(f.f*q,.1)} g fat</p></div>`;}).join('') : note('No matching food records available.');
  }
  s.on('click',e=>{const m=e.target.closest('[data-metric]');if(m){metric=m.dataset.metric;if(foods.length)draw();}if(e.target.closest('[data-sort]')){sort=!sort;if(foods.length)draw();}});
  Promise.resolve().then(()=>ctx.loadFoods()).then(data=>{
    if(!s.alive)return;
    if(!Array.isArray(data))throw new Error('Expected food array');
    const byId=new Map(data.map(f=>[f.i,f]));
    foods=[...new Set(p.foods)].map(id=>{const f=byId.get(id);if(!f||![f.k,f.p,f.c,f.f].every(n=>num(n)&&n>=0)||f.k===0||!text(f.n)){console.warn('[Learn widget] Unknown or invalid food id: '+id);return null;}return f;}).filter(Boolean);draw();
  }).catch(e=>{if(s.alive){console.warn('[Learn widget] Food data unavailable',e);el.querySelector('.lw-foods').innerHTML=note('Diagram unavailable — food data could not be loaded.');}});
}
function energy(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  el.innerHTML=`${[['intake','Energy in (kcal/day)'],['burn','Energy out (kcal/day)']].map(([key,label])=>`<label class="lw-control">${label}<output data-output="${key}"></output><input type="range" data-energy="${key}" min="${p[key][0]}" max="${p[key][1]}" step="${p.step}" value="${p[key][2]}" aria-label="${label}"/></label>`).join('')}<div class="lw-seesaw"></div>${status('')}${note(p.note)}`;
  function draw(){const a=+el.querySelector('[data-energy="intake"]').value,b=+el.querySelector('[data-energy="burn"]').value,d=a-b,angle=Math.max(-18,Math.min(18,d/40));
    for(const key of ['intake','burn'])el.querySelector(`[data-output="${key}"]`).textContent=el.querySelector(`[data-energy="${key}"]`).value+' kcal';
    el.querySelector('.lw-seesaw').innerHTML=svg(`<path d="M155 110L175 145H135Z" class="lw-fulcrum"/><g transform="rotate(${angle} 155 110)"><path d="M35 110H275" class="lw-beam"/><rect x="30" y="70" width="75" height="35" rx="8" class="lw-weight"/><rect x="205" y="70" width="75" height="35" rx="8" class="lw-weight"/><text x="67" y="92" text-anchor="middle">IN</text><text x="242" y="92" text-anchor="middle">OUT</text></g>`,'0 0 310 170','Energy balance: '+p.labels[d>0?'gain':d<0?'lose':'maintain']);
    el.querySelector('.lw-status').innerHTML=`<strong>${inline(p.labels[d>0?'gain':d<0?'lose':'maintain'])}</strong><p class="lw-big">${d>0?'+':d<0?'−':''}${Math.abs(d)} <span>kcal/day</span></p>`;
  }
  s.on('input',draw);draw();
}
function tier(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  el.innerHTML=p.tiers.map((t,i)=>`<section class="lw-tier"><h3>${i+1}. ${inline(t.name)}</h3><p>${inline(t.blurb)}</p>${t.items.map(x=>`<details class="lw-details"><summary>${inline(x.name)}</summary><div class="lw-tier-detail">${x.caution?`<p class="lw-caution"><strong>⚠ ${inline(x.caution)}</strong></p>`:''}<p>${inline(x.what)}</p>${x.dose?`<p><strong>What studies used</strong> ${inline(x.dose)}</p>`:''}${x.note?note(x.note):''}</div></details>`).join('')}</section>`).join('');
}
function checklist(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  const key=p.persistKey?'liftlog.learn.ck.'+p.persistKey:null;let checks={};
  try {const saved=key&&JSON.parse(localStorage.getItem(key)||'{}');if(obj(saved))checks=saved;}catch(e){console.warn('[Learn widget] Checklist storage unavailable',e);}
  el.innerHTML=`<h3>${inline(p.title)}</h3>${p.groups.map((g,i)=>`<fieldset class="lw-check-group"><legend>${inline(g.title)}</legend>${g.items.map((label,j)=>`<label class="lw-check"><input type="checkbox" data-check="${i}-${j}" ${checks[`${i}-${j}`]===true?'checked':''}/><span>${inline(label)}</span></label>`).join('')}</fieldset>`).join('')}${status('')}${button('Reset','data-reset')}`;
  const tally=()=>{const inputs=[...el.querySelectorAll('[data-check]')];el.querySelector('.lw-status').textContent=`${inputs.filter(i=>i.checked).length} of ${inputs.length} checked`+(key?' · saved on this device':'');};
  function save(){if(key)try{localStorage.setItem(key,JSON.stringify(checks));}catch(e){console.warn('[Learn widget] Checklist not saved',e);el.querySelector('.lw-status').textContent='Storage unavailable — ticks last for this visit only.';}}
  s.on('change',e=>{if(e.target.matches('[data-check]')){checks[e.target.dataset.check]=e.target.checked;tally();save();}});
  s.on('click',e=>{if(e.target.closest('[data-reset]')){checks={};el.querySelectorAll('[data-check]').forEach(i=>i.checked=false);tally();save();}});tally();
}
function tempo(el,p,ctx,s) {
  const inline = text => renderInline(text,ctx), note = text => renderNote(text,ctx), button = (label,attrs='') => renderButton(label,attrs,ctx);
  let phase=0, rep=1,remaining=p.phases[0].sec,timer,last;const reps=p.reps||3;
  const seconds=n=>`${n} ${n===1?'second':'seconds'}`;
  let weight=0;
  el.innerHTML=`<p class="lw-prompt">${inline('Practise with no weight first')}</p><div class="lw-tempo-motion">${svg(`<path d="M45 25V135" class="lw-weight-track"/><g data-weight transform="translate(0 0)"><rect x="26" y="15" width="38" height="20" rx="4" class="lw-weight"/></g><text x="80" y="85">weight</text>`,'0 0 160 160','Weight marker: down while lowering, hold while paused, up while lifting.')}</div><div class="lw-tempo-phases">${svg(p.phases.map((f,i)=>`<rect x="${i*300/p.phases.length}" y="5" width="${300/p.phases.length-4}" height="42" rx="5" class="lw-phase-box"/><text x="${(i+.5)*300/p.phases.length}" y="30" text-anchor="middle">${i+1} · ${f.sec}s</text>`).join(''),'0 0 300 55','Tempo phases: '+p.phases.map(f=>f.name+' '+seconds(f.sec)).join(', '))}<ol>${p.phases.map(f=>`<li>${inline(f.name)} · ${seconds(f.sec)}</li>`).join('')}</ol></div>${status('')}${s.motion?note('Reduced motion: follow the labelled phases at your own pace.'):button('Start','data-start')}`;
  function draw(done=false){
    if(!s.motion){
      const progress=Math.max(0,Math.min(1,1-remaining/p.phases[phase].sec));
      const name=p.phases[phase].name.toLowerCase();
      if(/lower|eccentric|down/.test(name)||phase===0)weight=progress;
      else if(/lift|raise|concentric|up/.test(name))weight=1-progress;
      else {for(let i=phase-1;i>=0;i--){const previous=p.phases[i].name.toLowerCase();if(/lift|raise|concentric|up/.test(previous)){weight=0;break;}if(/lower|eccentric|down/.test(previous)||i===0){weight=1;break;}}}
      if(done)weight=0;
      el.querySelector('[data-weight]').setAttribute('transform',`translate(0 ${round(weight*110,.1)})`);
    }
    el.querySelector('.lw-status').innerHTML=done?'<strong>Complete ✓</strong>':`<strong class="lw-big">${inline(p.phases[phase].name)}</strong><p>${seconds(Math.ceil(remaining))} · Rep ${rep} of ${reps}</p>`;el.querySelectorAll('.lw-phase-box').forEach((b,i)=>b.classList.toggle('lw-phase-on',i===phase));}
  s.on('click',e=>{if(!e.target.closest('[data-start]'))return;const b=el.querySelector('[data-start]');if(timer){s.stop(timer);timer=null;b.textContent='Start';return;}phase=0;rep=1;remaining=p.phases[0].sec;last=performance.now();b.textContent='Stop';draw();timer=s.every(()=>{const now=performance.now();remaining-=(now-last)/1000;last=now;while(remaining<=0){phase++;if(phase>=p.phases.length){phase=0;rep++;}if(rep>reps){s.stop(timer);timer=null;b.textContent='Start';draw(true);return;}remaining+=p.phases[phase].sec;}draw();},100);});draw();
}
const renderers={'body-atlas':atlas,sarcomere,chart,'slider-explainer':slider,plate,'macro-calc':macro,'food-compare':foodCompare,'energy-balance':energy,'tier-list':tier,checklist,tempo};
export const WIDGETS=Object.fromEntries(Object.entries(renderers).map(([type,render])=>[type,(el,p,ctx={})=>{
  if(!validateParams(type,p)){unavailable(el,type,undefined,ctx);return;}
  let s;
  try {
    ctx=ctx||{};s=scope(el,ctx);el.classList.add('lw','lw-'+type);if(s.motion)el.classList.add('lw-reduced');
    render(el,p,ctx,s);
    if(p.hypothetical){const tag=document.createElement('p');tag.className='lw-tag';tag.innerHTML=renderInline('Illustration — not real data',ctx);el.prepend(tag);}
    return s.cleanup;
  } catch(e){s?.cleanup();unavailable(el,type,e,ctx);}
}]));
