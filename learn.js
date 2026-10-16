/* Learn: no raw content HTML is ever inserted. Only this renderer makes tags. */
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function inlineMarkup(value, exerciseName = () => null) {
  const text = String(value ?? '');
  const pattern = /\[\[([^\]\n]+)\]\]|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let result = '', last = 0;
  for (const m of text.matchAll(pattern)) {
    result += escapeHTML(text.slice(last, m.index));
    if (m[1]) {
      const [target, ...words] = m[1].split('|');
      let label = words.join('|') || target;
      if (target.startsWith('ex:')) {
        const slug = target.slice(3); label = exerciseName(slug) || label;
        result += `<button type="button" class="ln-inline ln-ex-link" data-ex="${escapeHTML(slug)}">${escapeHTML(label)}</button>`;
      } else if (target.startsWith('lesson:')) {
        result += `<button type="button" class="ln-inline" data-route="${escapeHTML(target)}">${escapeHTML(label)}</button>`;
      } else {
        result += `<button type="button" class="ln-inline ln-term" data-term="${escapeHTML(target)}">${escapeHTML(label)}</button>`;
      }
    } else if (m[2]) result += `<strong>${escapeHTML(m[2])}</strong>`;
    else result += `<em>${escapeHTML(m[3])}</em>`;
    last = m.index + m[0].length;
  }
  return result + escapeHTML(text.slice(last));
}

const KEY = 'liftlog.learn.v1';
const CALLOUTS = {tip:'💡 Tip', myth:'✕ Myth', science:'🧪 Science', safety:'⚠ Safety', try:'🏋 Try it'};
function textValues(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValues).join(' ');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).filter(([k]) => ['text','title','items','front','back','left','right','cards','why','caption','labels'].includes(k)).map(([,v]) => textValues(v)).join(' ');
}
export function readMinutes(lesson) {
  const text = [lesson.title, lesson.summary, textValues(lesson.blocks || []), ...(lesson.takeaways || [])].filter(Boolean).join(' ').replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g,'$2').replace(/\*/g,'');
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 180 + (lesson.blocks || []).filter(b => b.t === 'widget' || b.t === 'video' || b.t === 'exanim').length));
}
export function isLessonDone(seen, answers, total) {
  return seen && total > 0 && answers.length === total && answers.every(a => Number.isInteger(a) && a >= 0);
}
export function lessonSequence(index, pathId) {
  const all = index.sections.flatMap(s => s.lessons);
  const path = index.paths?.find(p => p.id === pathId);
  return path ? path.lessons.map(id => all.find(l => l.id === id)).filter(Boolean) : all;
}
export function nextUnfinished(index, done, last, pathId) {
  const all = lessonSequence(index,null), previous = all.find(l => l.id === last);
  if (previous && !done[last]) return previous;
  const ordered = lessonSequence(index,pathId), pos = ordered.findIndex(l => l.id === last);
  const next = [...ordered.slice(pos+1),...ordered.slice(0,pos+1)].find(l => !done[l.id]);
  return next || all.find(l => !done[l.id]) || null;
}
export function backRoute(route, index) {
  if (route === 'home') return null;
  if (route.startsWith('lesson:')) {
    const section = index.sections.find(s => s.lessons.some(l => l.id === route.slice(7)));
    return section ? 'section:' + section.id : 'home';
  }
  return 'home';
}
export function searchLessons(index, files, query) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q) return [];
  const details = new Map(files.flatMap(f => (f?.lessons || []).map(l => [l.id,l])));
  const results = index.sections.flatMap(s => s.lessons.flatMap(l => {
    const full = details.get(l.id) || {};
    return [l.title,full.title,full.summary,...(full.takeaways || [])].join(' ').toLocaleLowerCase().includes(q) ? [{route:'lesson:' + l.id,title:full.title || l.title,detail:s.title}] : [];
  }));
  const terms = new Set();
  for (const f of files) for (const g of f?.glossary || []) {
    const key = g.term.toLocaleLowerCase();
    if (!terms.has(key) && [g.term,g.def].join(' ').toLocaleLowerCase().includes(q)) {
      terms.add(key); results.push({route:'glossary:' + g.term,title:g.term,detail:g.def});
    }
  }
  return results;
}
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    return {done:p?.done && typeof p.done === 'object' ? p.done : {},quiz:p?.quiz && typeof p.quiz === 'object' ? p.quiz : {},last:typeof p?.last === 'string' ? p.last : null};
  } catch { return {done:{},quiz:{},last:null}; }
}
export function resetLearnProgress() {
  try { localStorage.removeItem(KEY); } catch { /* Private browsing may block storage. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('liftlog-learn-reset'));
}
function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

export function mountLearn(rootEl, ctx = {}) {
  if (!rootEl) throw new TypeError('Learn needs a root element');
  const base = new URL(ctx.base || './', document.baseURI);
  const dataRoot = new URL(ctx.dataRoot || rootEl.dataset.root || 'learn/', base);
  if (!dataRoot.pathname.endsWith('/')) dataRoot.pathname += '/';
  let index = null, route = 'home', epoch = 0, destroyed = false, widgetsPromise, pathId = null, lastPath = null;
  let progress = loadProgress(), cleanups = [], observer = null, active = null, popup = null, popupTrigger = null;
  const files = new Map(), backStack = [];
  let suspended = null, lastScroll = 0;
  function rememberScroll() { if (rootEl.getClientRects().length && rootEl.offsetHeight && !suspended) lastScroll = window.scrollY; }
  function captureState(scroll = window.scrollY) {
    return {route,pathId,scroll,search:rootEl.querySelector('.ln-search')?.value || '',searchHTML:rootEl.querySelector('.ln-search-results')?.innerHTML || '',
      answers:active?.answers.slice(),seen:active?.seen,
      details:[...rootEl.querySelectorAll('details')].map(el => el.open),
      flips:[...rootEl.querySelectorAll('[data-flip]')].filter(el => el.getAttribute('aria-pressed') === 'true').map(el => el.dataset.flip),
      steps:[...rootEl.querySelectorAll('[data-step]')].map(el => [el.dataset.step,+el.dataset.at])};
  }
  function openExercise(slug) { suspended = captureState(); lastScroll = suspended.scroll; ctx.openExercise?.(slug); }
  async function resume() {
    if (destroyed) return;
    const state = suspended || captureState(lastScroll); suspended = null;
    await open(state.route,{restore:state});
  }
  function restoreControls(state) {
    rootEl.querySelectorAll('details').forEach((el,i) => { el.open = !!state.details?.[i]; });
    for (const [i,at] of state.steps || []) {
      const box = rootEl.querySelector(`[data-step="${i}"]`), b = active?.lesson.blocks[+i];
      if (!box || !b?.items[at]) continue;
      box.dataset.at = at; box.querySelector('.ln-step-body').innerHTML = stepBody(b,at);
      box.querySelector('[data-step-back]').disabled = at === 0; box.querySelector('[data-step-next]').disabled = at >= b.items.length-1;
    }
    for (const id of state.flips || []) {
      const el = rootEl.querySelector(`[data-flip="${id}"]`); if (!el) continue;
      const [i,j] = id.split(':').map(Number), card = active?.lesson.blocks[i]?.cards[j]; if (!card) continue;
      el.setAttribute('aria-pressed','true'); const box = el.closest('.ln-flip-card');
      box.querySelector('.ln-eyebrow').textContent = 'ANSWER'; box.querySelector('.ln-flip-content').innerHTML = inline(card.back); el.textContent = '↻ Turn back to question';
    }
  }
  const esc = escapeHTML;
  const name = slug => { try { return ctx.exerciseName?.(slug) || null; } catch { return null; } };
  const inline = text => inlineMarkup(text, name);
  const button = (r,label,cls='ln-btn') => `<button type="button" class="${cls}" data-route="${esc(r)}">${esc(label)}</button>`;
  const save = () => { try { localStorage.setItem(KEY,JSON.stringify(progress)); } catch { /* Progress still works in memory. */ } };
  async function fetchData(file) {
    try { const res = await fetch(new URL(file,dataRoot)); if (!res.ok) return null; return await res.json(); } catch { return null; }
  }
  let indexPromise;
  async function getIndex() {
    if (!indexPromise) indexPromise = fetchData('index.json').then(data => {
      if (!data || !Array.isArray(data.sections) || data.sections.some(s => !Array.isArray(s.lessons))) return null;
      return index = data;
    });
    return indexPromise;
  }
  function sectionFor(id) { return index.sections.find(s => s.lessons.some(l => l.id === id)); }
  async function getSection(section) {
    if (!section) return null;
    if (!files.has(section.id)) files.set(section.id,fetchData((section.file || section.id + '.json').split('/').pop()).then(f => f && Array.isArray(f.lessons) ? f : null));
    return files.get(section.id);
  }
  async function allSections() { return Promise.all(index.sections.map(getSection)); }
  function closePopup(restore = true) {
    if (!popup) return;
    popup.remove(); popup = null;
    if (restore && popupTrigger?.isConnected) popupTrigger.focus({preventScroll:true});
    popupTrigger = null;
  }
  function cleanupPage() {
    closePopup(false); observer?.disconnect(); observer = null; active = null;
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* A diagram must not break navigation. */ } }
  }
  function shell(title, content, ready = true) {
    rootEl.innerHTML = `<div class="ln-root"><header class="ln-header"><button type="button" class="ln-back" data-back aria-label="${route === 'home' ? 'Back to LiftLog' : 'Back'}">‹</button><div><span class="ln-eyebrow">LIFTLOG / LEARN</span><h1>${esc(title)}</h1></div></header><div class="ln-main" data-ready="${ready}">${content}</div></div>`;
  }
  const notReady = () => `<div class="ln-empty"><span aria-hidden="true">🧩</span><h2>This section isn't ready yet</h2><p>Your place is safe. Try another topic for now.</p>${button('home','Explore other topics')}</div>`;
  function lessonRows(section, file) {
    return section.lessons.map((meta,i) => {
      const lesson = file?.lessons.find(l => l.id === meta.id);
      return `<button type="button" class="ln-lesson-row" data-route="lesson:${esc(meta.id)}"><span class="ln-number">${i+1}</span><span><strong>${esc(meta.title)}</strong><span class="ln-meta">${lesson ? readMinutes(lesson) + ' min read' : 'Coming soon'}${progress.done[meta.id] ? ' · ✓ Done' + (progress.quiz[meta.id] ? ' · ' + progress.quiz[meta.id].correct + '/' + progress.quiz[meta.id].total : '') : ''}</span></span><span aria-hidden="true">›</span></button>`;
    }).join('');
  }
  function home() {
    const pathsHTML = (index.paths || []).map(path => {
      const done = path.lessons.filter(id => progress.done[id]).length;
      return `<aside class="ln-path"><span class="ln-eyebrow">${esc(path.emoji)} YOUR FIRST-WORKOUT PATH</span><h2>${esc(path.title)}</h2><p>${esc(path.blurb)}</p><span class="ln-meta">${done} of ${path.lessons.length} done</span>${done === path.lessons.length ? '<strong>Path complete ✓</strong>' : button('path:' + path.id,done ? 'Continue →' : 'Start →')}</aside>`;
    }).join('');
    const recommendedPath = lastPath || index.paths?.find(p => p.lessons.includes(progress.last))?.id;
    const lastLesson = progress.last ? nextUnfinished(index,progress.done,progress.last,recommendedPath) : null;
    const cards = index.sections.map(s => {
      const done = s.lessons.filter(l => progress.done[l.id]).length;
      return `<button type="button" class="ln-section-card" data-route="section:${esc(s.id)}"><span class="ln-emoji" aria-hidden="true">${esc(s.emoji)}</span><span class="ln-card-body"><strong>${esc(s.title)}</strong><span class="ln-blurb">${esc(s.blurb)}</span><span class="ln-progress-track" aria-hidden="true"><span style="width:${Math.round(done / Math.max(1,s.lessons.length)*100)}%"></span></span><span class="ln-meta">${done} of ${s.lessons.length} done</span></span><span aria-hidden="true">›</span></button>`;
    }).join('');
    shell('Learn',`${pathsHTML}<label class="ln-search-label">Find something you're curious about<input class="ln-search" type="search" placeholder="Try protein, sleep or muscle…" autocomplete="off"></label><div class="ln-search-results" aria-live="polite"></div>${lastLesson ? `<button type="button" class="ln-continue" data-path="${esc(index.paths?.find(p => p.id === recommendedPath)?.lessons.includes(lastLesson.id) ? recommendedPath : '')}" data-route="lesson:${esc(lastLesson.id)}"><span class="ln-eyebrow">PICK UP WHERE YOU LEFT OFF</span><strong>Continue: ${esc(lastLesson.title)}</strong><span>One small step at a time →</span></button>` : ''}<div class="ln-section-heading"><h2>Explore the topics</h2>${button('glossary','A–Z Glossary','ln-glossary-link')}</div><div class="ln-section-grid">${cards}</div><p class="ln-footnote">Your progress stays on this device. No pressure, no streaks.</p>`);
  }
  function renderBlock(b,i) {
    const wrap = html => `<div class="ln-block" data-block="${esc(b.t)}">${html}</div>`;
    const list = (items,ordered=false) => { const tag = ordered ? 'ol' : 'ul'; return `<${tag} class="ln-list">${(items || []).map(item => `<li>${inline(item)}</li>`).join('')}</${tag}>`; };
    switch(b.t) {
      case 'p': return wrap(`<p>${inline(b.text)}</p>`);
      case 'h': return wrap(`<h2 class="ln-subheading">${esc(b.text)}</h2>`);
      case 'list': return wrap(list(b.items,b.ordered));
      case 'callout': return wrap(`<aside class="ln-callout"><span class="ln-eyebrow">${esc(CALLOUTS[b.kind] || 'Note')}</span><h3>${esc(b.title)}</h3><p>${inline(b.text)}</p></aside>`);
      case 'compare': return wrap(`<div class="ln-compare">${[b.left,b.right].map(side => `<div><h3>${esc(side?.title)}</h3>${list(side?.items)}</div>`).join('')}</div>`);
      case 'steps': return wrap(`<div class="ln-steps" data-step="${i}" data-at="0"><div class="ln-step-body">${stepBody(b,0)}</div><div class="ln-controls"><button type="button" class="ln-btn" data-step-back disabled>← Back</button><button type="button" class="ln-btn" data-step-next ${(b.items || []).length <= 1 ? 'disabled' : ''}>Next →</button></div></div>`);
      case 'flip': return wrap(`<div class="ln-flips">${(b.cards || []).map((c,j) => `<div class="ln-flip-card"><span class="ln-eyebrow">QUESTION</span><div class="ln-flip-content">${inline(c.front)}</div><button type="button" class="ln-flip" data-flip="${i}:${j}" aria-pressed="false">↻ Reveal answer</button></div>`).join('')}</div>`);
      case 'exercises': return wrap(`<h3>${esc(b.title || 'Explore the exercises')}</h3><div class="ln-chips">${(b.slugs || []).map(slug => `<button type="button" class="ln-chip" data-ex="${esc(slug)}">↗ ${esc(name(slug) || slug)}</button>`).join('')}</div>`);
      case 'exanim': return wrap(`<figure class="ln-exanim" data-exanim="${i}"><p class="ln-widget-note">Loading demonstrations…</p></figure>`);
      case 'video': return wrap(`<div class="ln-video"><button type="button" class="ln-video-facade" data-video="${i}"><span class="ln-play" aria-hidden="true">▶</span><strong>${esc(b.title)}</strong><span class="ln-meta">${esc(b.channel)}</span><span>${esc(b.why)}</span><span class="ln-meta">Tap to load YouTube · uses internet</span></button></div>`);
      case 'widget': return wrap(`<figure class="ln-figure"><div class="lw lw-${esc(String(b.w).replace(/[^a-z0-9-]/g,''))}" data-widget="${i}"><p class="ln-widget-note">Loading diagram…</p></div>${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ''}</figure>`);
      default: return wrap('<p class="ln-muted">This explanation is unavailable.</p>');
    }
  }
  function stepBody(block,at) {
    const items = block.items || [], item = items[at] || {};
    return `<span class="ln-eyebrow">Step ${Math.min(at+1,items.length)} of ${items.length}</span><h3>${esc(item.title)}</h3><p>${inline(item.text)}</p>`;
  }
  function renderQuiz() {
    const {lesson,answers} = active;
    const target = rootEl.querySelector('.ln-quiz');
    target.innerHTML = `<h2>Check yourself</h2><p class="ln-muted">Not a test. Just a chance to make it stick.</p>${(lesson.quiz || []).map((q,i) => {
      const answered = Number.isInteger(answers[i]), correct = answered && answers[i] === q.answer;
      return `<fieldset class="ln-question"><legend>${i+1}. ${esc(q.q)}</legend>${q.options.map((opt,j) => `<button type="button" class="ln-option${answered && j === q.answer ? ' ln-answer' : ''}${answered && j === answers[i] ? ' ln-selected' : ''}" data-q="${i}" data-option="${j}" ${answered ? 'disabled' : ''}>${answered && j === q.answer ? '✓ ' : answered && j === answers[i] ? '✕ ' : ''}${esc(opt)}${answered && j === q.answer ? '<span class="ln-option-label">Correct answer</span>' : ''}</button>`).join('')}${answered ? `<div class="ln-feedback" data-feedback="${i}" role="status"><strong>${correct ? '✓ Correct' : '✕ Not quite'}</strong><p>${inline(q.why)}</p></div>` : ''}</fieldset>`;
    }).join('')}<button type="button" class="ln-btn" data-quiz-reset>↻ Try again</button>`;
  }
  function checkCompletion() {
    if (!active) return;
    const {lesson,answers,seen} = active;
    const complete = isLessonDone(seen,answers,(lesson.quiz || []).length);
    const correct = answers.filter((a,i) => a === lesson.quiz[i]?.answer).length;
    if (answers.some(Number.isInteger) || !progress.done[lesson.id]) progress.quiz[lesson.id] = {correct,total:(lesson.quiz || []).length};
    if (complete && !progress.done[lesson.id]) progress.done[lesson.id] = Date.now();
    save();
    const banner = rootEl.querySelector('.ln-complete');
    if (banner) {
      banner.hidden = !progress.done[lesson.id];
      const score = progress.quiz[lesson.id] || {correct:0,total:(lesson.quiz || []).length};
      const ordered = lessonSequence(index,pathId), pos = ordered.findIndex(l => l.id === lesson.id), next = ordered[pos+1];
      banner.innerHTML = `Lesson complete ✓<span>You got ${score.correct} of ${score.total} — the explanations above show why</span>${next ? button('lesson:' + next.id,'Next lesson →') : button('home','Keep exploring →')}`;
    }
    const pathCard = rootEl.querySelector('.ln-path-complete');
    const path = index.paths?.find(p => p.id === pathId);
    if (pathCard) pathCard.hidden = !path?.lessons.every(id => progress.done[id]);
  }
  let guidesPromise;
  function getGuides() {
    if (!guidesPromise) guidesPromise = fetch(new URL('guides.json',base)).then(r => r.ok ? r.json() : null).catch(() => null);
    return guidesPromise;
  }
  async function initExanim(lesson,token) {
    const blocks = (lesson.blocks || []).map((b,i) => ({b,i})).filter(({b}) => b.t === 'exanim');
    if (!blocks.length) return;
    const guides = await getGuides(); if (destroyed || token !== epoch) return;
    const reduced = ctx.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const {b,i} of blocks) {
      const target = rootEl.querySelector(`[data-exanim="${i}"]`); if (!target) continue;
      const slugs = Array.isArray(b.slugs) ? b.slugs.slice(0,3) : [];
      target.innerHTML = `<div class="ln-exanim-grid" style="--ln-exanim-cols:${Math.max(1,slugs.length)}">${slugs.map((slug,j) => {
        const guide = guides?.exercises?.[slug], media = guide?.media, label = b.labels?.[j] || guide?.name || slug;
        return `<div class="ln-exanim-card"><button type="button" class="ln-exanim-open" data-ex="${esc(slug)}" aria-label="Open exercise: ${esc(guide?.name || slug)}"><span class="ln-exanim-media" data-slug="${esc(slug)}"><span class="ln-muted">Loading demonstration…</span></span><span class="ln-exanim-label">${esc(label)} ↗</span></button>${media?.closest ? `<span class="ln-meta">Closest available: ${esc(media.closest)}</span>` : ''}</div>`;
      }).join('')}</div>${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ''}`;
      await Promise.all(slugs.map(async slug => {
        const media = guides?.exercises?.[slug]?.media;
        const box = [...target.querySelectorAll('.ln-exanim-media')].find(el => el.dataset.slug === slug);
        const label = guides?.exercises?.[slug]?.name || slug;
        try {
          if (media?.type !== 'gif' || !media.src) throw new Error('no animation');
          const src = new URL(media.src,base); if (src.origin !== base.origin || !/\.gif$/i.test(src.pathname)) throw new Error('invalid media');
          if (reduced) {
            // Decode the GIF's first frame before displaying any pixels. No live GIF is placed in the DOM until Play.
            const response = await fetch(src); if (!response.ok) throw new Error('missing media');
            const bitmap = await createImageBitmap(await response.blob());
            if (destroyed || token !== epoch) { bitmap.close(); return; }
            const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
            canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',label + ' — first-frame still');
            canvas.getContext('2d').drawImage(bitmap,0,0); bitmap.close(); box.replaceChildren(canvas);
            const play = document.createElement('button'); play.type = 'button'; play.className = 'ln-btn ln-exanim-play';
            play.dataset.exanimPlay = src.href; play.dataset.label = label; play.textContent = '▶ Play'; play.setAttribute('aria-label','Play animation: ' + label);
            box.closest('.ln-exanim-card').append(play);
          } else {
            const img = document.createElement('img'); img.src = src.href; img.alt = label + ' — animated demonstration'; img.decoding = 'async'; box.replaceChildren(img);
          }
        } catch {
          if (token === epoch && !destroyed) box.innerHTML = '<span class="ln-muted">Demonstration unavailable. Open the exercise guide.</span>';
        }
      }));
    }
  }
  async function initWidgets(lesson,token) {
    const blocks = (lesson.blocks || []).map((b,i) => ({b,i})).filter(({b}) => b.t === 'widget');
    if (!blocks.length) return;
    if (!widgetsPromise) widgetsPromise = import('./learn-widgets.js').then(m => m.WIDGETS).catch(() => null);
    const [registry,body] = await Promise.all([widgetsPromise, blocks.some(({b}) => b.w === 'body-atlas') ? getSection(index.sections.find(s => s.id === 'body')) : Promise.resolve(null)]);
    if (destroyed || token !== epoch) return;
    for (const {b,i} of blocks) {
      const el = rootEl.querySelector(`[data-widget="${i}"]`);
      if (!el) continue;
      el.replaceChildren();
      try {
        if (!registry || typeof registry[b.w] !== 'function') throw new Error('missing widget');
        const clean = registry[b.w](el,b.params || {},{regions:body?.regions || {},loadFoods:ctx.loadFoods || (() => Promise.resolve([])),openExercise,exerciseName:name,reducedMotion:ctx.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches,inline,inlineMarkup:inline});
        if (typeof clean === 'function') cleanups.push(clean);
      } catch { el.innerHTML = '<p class="ln-widget-note">Diagram unavailable</p>'; }
    }
  }
  async function open(next = 'home', options = {}) {
    if (destroyed) return;
    const token = ++epoch; suspended = null; cleanupPage();
    route = String(next); shell('Learn','<p class="ln-muted" role="status">Opening your next small step…</p>',false);
    await getIndex();
    if (destroyed || token !== epoch) return;
    if (!index) { shell('Learn',`<div class="ln-empty"><h2>Learn isn't available yet</h2><p>Connect once to load your lessons, then try again.</p><button type="button" class="ln-btn" data-retry>Try again</button></div>`); return; }
    if (options.restore) pathId = options.restore.pathId;
    else if (route.startsWith('path:')) {
      pathId = route.slice(5); lastPath = pathId;
      const ordered = lessonSequence(index,pathId);
      route = ordered.length ? 'lesson:' + (ordered.find(l => !progress.done[l.id]) || ordered[0]).id : 'home';
    } else if (!route.startsWith('lesson:') || !index.paths?.find(p => p.id === pathId)?.lessons.includes(route.slice(7))) pathId = null;
    if (route === 'home') home();
    else if (route === 'glossary' || route.startsWith('glossary:')) {
      const all = await allSections(); if (destroyed || token !== epoch) return;
      const terms = new Map();
      for (const f of all) for (const g of f?.glossary || []) if (!terms.has(g.term.toLocaleLowerCase())) terms.set(g.term.toLocaleLowerCase(),g);
      shell('Glossary',`<div class="ln-intro"><h2>Big words, plain meanings.</h2><p>A pocket dictionary for your training.</p></div><dl class="ln-glossary">${Array.from(terms.values()).sort((a,b) => a.term.localeCompare(b.term)).map(g => `<div data-glossary-term="${esc(g.term)}" tabindex="-1"><dt>${esc(g.term)}</dt><dd>${esc(g.def)}</dd></div>`).join('') || '<p>No terms available yet.</p>'}</dl>`);
    } else if (route.startsWith('section:')) {
      const section = index.sections.find(s => s.id === route.slice(8));
      if (!section) return open('home');
      const file = await getSection(section); if (destroyed || token !== epoch) return;
      shell(section.title,`<div class="ln-intro"><span class="ln-hero-emoji" aria-hidden="true">${esc(section.emoji)}</span><h2>${esc(section.title)}</h2><p>${esc(section.blurb)}</p></div>${file ? `<div class="ln-lesson-list">${lessonRows(section,file)}</div>` : notReady()}`);
    } else if (route.startsWith('lesson:')) {
      const id = route.slice(7), section = sectionFor(id);
      if (!section) return open('home');
      const file = await getSection(section); if (destroyed || token !== epoch) return;
      const lesson = file?.lessons.find(l => l.id === id);
      if (!lesson) { shell(section.title,notReady()); return; }
      progress.last = id; save();
      const ordered = lessonSequence(index,pathId), pos = ordered.findIndex(l => l.id === id);
      const path = index.paths?.find(p => p.id === pathId);
      active = {lesson,file,answers:options.restore?.answers?.length === (lesson.quiz || []).length ? options.restore.answers.slice() : Array((lesson.quiz || []).length).fill(null),seen:!!options.restore?.seen};
      shell(section.title,`<article class="ln-lesson"><div class="ln-lesson-intro">${path ? `<span class="ln-eyebrow ln-path-eyebrow">Path: ${esc(path.title)} · ${pos+1} of ${ordered.length}</span>` : ''}<span class="ln-eyebrow">${esc(section.emoji)} ${esc(section.title)} · ${readMinutes(lesson)} min read</span><h2 class="ln-title" tabindex="-1">${esc(lesson.title)}</h2><div class="ln-summary"><span class="ln-eyebrow">IN SHORT</span><p>${inline(lesson.summary)}</p></div></div><div class="ln-blocks">${(lesson.blocks || []).map(renderBlock).join('')}</div><aside class="ln-takeaways"><span class="ln-eyebrow">THE PART TO REMEMBER</span><h2>✦ Key takeaways</h2><ul class="ln-list">${(lesson.takeaways || []).map(t => `<li>${inline(t)}</li>`).join('')}</ul></aside><div class="ln-quiz"></div><div class="ln-complete" role="status" hidden></div>${path ? `<aside class="ln-path ln-path-complete" hidden><strong>Path complete ✓</strong><p>You have finished ${esc(path.title)}.</p>${button('home','Keep exploring →')}</aside>` : ''}<details class="ln-sources"><summary>The science behind this</summary><ul>${(lesson.sources || []).map(s => { const url = safeURL(s.url); return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)} ↗</a>` : esc(s.label)}<span class="ln-meta">Checked ${esc(s.checked)}</span></li>`; }).join('')}</ul></details><nav class="ln-prevnext" aria-label="Lesson navigation">${pos > 0 ? button('lesson:' + ordered[pos-1].id,'← Previous: ' + ordered[pos-1].title) : ''}${pos < ordered.length-1 ? button('lesson:' + ordered[pos+1].id,'Next: ' + ordered[pos+1].title + ' →') : button('home','Back to all topics →')}</nav></article>`);
      renderQuiz();
      if (progress.done[id]) {
        const score = progress.quiz[id];
        const banner = rootEl.querySelector('.ln-complete'); banner.hidden = false;
        banner.innerHTML = `Lesson complete ✓<span>${score ? `You got ${score.correct} of ${score.total} — the explanations above show why` : 'You have completed this lesson.'}</span>${ordered[pos+1] ? button('lesson:' + ordered[pos+1].id,'Next lesson →') : button('home','Keep exploring →')}`;
        const pathCard = rootEl.querySelector('.ln-path-complete'); if (pathCard) pathCard.hidden = !path.lessons.every(id => progress.done[id]);
      }
      observer = new IntersectionObserver(entries => {
        if (token === epoch && active && entries.some(e => e.isIntersecting)) { active.seen = true; checkCompletion(); observer?.disconnect(); }
      },{rootMargin:'-70px 0px 0px 0px',threshold:0.01});
      observer.observe(rootEl.querySelector('.ln-takeaways'));
      await Promise.all([initWidgets(lesson,token),initExanim(lesson,token)]);
      if (destroyed || token !== epoch) return;
    } else return open('home');
    if (!ctx.reducedMotion) { /* Navigation is deliberately instantaneous even without reduced motion. */ }
    window.scrollTo({top:0,behavior:'instant'});
    rootEl.querySelector('.ln-title')?.focus({preventScroll:true});
    if (options.restore) {
      const state = options.restore;
      restoreControls(state);
      if (active) checkCompletion();
      const search = rootEl.querySelector('.ln-search');
      if (search) { search.value = state.search; rootEl.querySelector('.ln-search-results').innerHTML = state.searchHTML; }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (token === epoch && !destroyed) { window.scrollTo({top:state.scroll,behavior:'instant'}); lastScroll = state.scroll; }
    } else if (route.startsWith('glossary:')) {
      const term = route.slice(9).toLocaleLowerCase();
      const target = [...rootEl.querySelectorAll('[data-glossary-term]')].find(el => el.dataset.glossaryTerm.toLocaleLowerCase() === term);
      if (target) {
        target.classList.add('ln-glossary-target','ln-glossary-highlight');
        const marker = document.createElement('span'); marker.className = 'ln-meta'; marker.textContent = '◀ you searched this'; target.append(marker);
        target.scrollIntoView({block:'start',behavior:'instant'}); target.focus({preventScroll:true});
        const timer = setTimeout(() => target.classList.remove('ln-glossary-highlight'),6000); cleanups.push(() => clearTimeout(timer));
      }
    }
  }
  function showTerm(trigger) {
    const term = trigger.dataset.term;
    const definition = active?.file?.glossary?.find(g => g.term.toLocaleLowerCase() === term.toLocaleLowerCase());
    closePopup(false); popupTrigger = trigger;
    popup = document.createElement('div'); popup.className = 'ln-popover'; popup.setAttribute('role','dialog'); popup.setAttribute('aria-modal','true'); popup.setAttribute('aria-label',term);
    popup.innerHTML = `<span class="ln-eyebrow">PLAIN WORDS</span><h2>${esc(definition?.term || term)}</h2><p>${esc(definition?.def || 'This definition is not available yet.')}</p><button type="button" class="ln-btn" data-close-term>Got it ✓</button>`;
    rootEl.append(popup); popup.querySelector('button').focus({preventScroll:true});
  }
  function click(event) {
    const el = event.target.closest('button'); if (!el || !rootEl.contains(el)) return;
    if (el.hasAttribute('data-close-term')) return closePopup();
    if (el.hasAttribute('data-back')) {
      const state = backStack.pop(); if (state) return void open(state.route,{restore:state});
      const back = index ? backRoute(route,index) : null; if (back) return void open(back); suspended = captureState(); return ctx.exit?.();
    }
    if (el.hasAttribute('data-retry')) { indexPromise = null; files.clear(); return void open(route); }
    if (el.dataset.route) {
      if (el.matches('.ln-inline, .ln-search-hit')) backStack.push(captureState());
      else backStack.length = 0;
      if (el.hasAttribute('data-path')) pathId = el.dataset.path || null;
      return void open(el.dataset.route);
    }
    if (el.hasAttribute('data-exanim-play')) {
      const img = document.createElement('img'); img.src = el.dataset.exanimPlay; img.alt = el.dataset.label + ' — animated demonstration';
      el.closest('.ln-exanim-card').querySelector('.ln-exanim-media').replaceChildren(img); el.remove(); return;
    }
    if (el.dataset.ex) return openExercise(el.dataset.ex);
    if (el.dataset.term) return showTerm(el);
    if (!active) return;
    if (el.hasAttribute('data-q')) {
      const q = +el.dataset.q, option = +el.dataset.option;
      if (active.answers[q] !== null) return;
      active.answers[q] = option; renderQuiz(); checkCompletion();
      rootEl.querySelector(`[data-feedback="${q}"]`)?.setAttribute('tabindex','-1');
      rootEl.querySelector(`[data-feedback="${q}"]`)?.focus({preventScroll:true});
    } else if (el.hasAttribute('data-quiz-reset')) {
      active.answers.fill(null); renderQuiz(); checkCompletion(); rootEl.querySelector('.ln-option')?.focus({preventScroll:true});
    } else if (el.hasAttribute('data-step-next') || el.hasAttribute('data-step-back')) {
      const box = el.closest('.ln-steps'), b = active.lesson.blocks[+box.dataset.step];
      const at = Math.max(0,Math.min(b.items.length-1,+box.dataset.at + (el.hasAttribute('data-step-next') ? 1 : -1)));
      box.dataset.at = at; box.querySelector('.ln-step-body').innerHTML = stepBody(b,at);
      box.querySelector('[data-step-back]').disabled = at === 0; box.querySelector('[data-step-next]').disabled = at >= b.items.length-1;
    } else if (el.hasAttribute('data-flip')) {
      const [i,j] = el.dataset.flip.split(':').map(Number), card = active.lesson.blocks[i].cards[j];
      const flipped = el.getAttribute('aria-pressed') !== 'true'; el.setAttribute('aria-pressed',String(flipped));
      const box = el.closest('.ln-flip-card');
      box.querySelector('.ln-eyebrow').textContent = flipped ? 'ANSWER' : 'QUESTION';
      box.querySelector('.ln-flip-content').innerHTML = inline(flipped ? card.back : card.front);
      el.textContent = flipped ? '↻ Turn back to question' : '↻ Reveal answer';
    } else if (el.hasAttribute('data-video')) {
      const b = active.lesson.blocks[+el.dataset.video], box = el.closest('.ln-video');
      if (navigator.onLine === false) { box.innerHTML = '<p class="ln-widget-note" role="status">Videos need an internet connection</p>'; return; }
      if (!/^[a-zA-Z0-9_-]{11}$/.test(b.id)) { box.innerHTML = '<p class="ln-widget-note">Video unavailable</p>'; return; }
      const frame = document.createElement('iframe'); frame.className = 'ln-video-frame'; frame.title = b.title;
      frame.src = `https://www.youtube-nocookie.com/embed/${b.id}?start=${Math.max(0,Math.floor(Number(b.start) || 0))}&autoplay=1`;
      frame.allow = 'autoplay; encrypted-media; picture-in-picture'; frame.loading = 'lazy'; frame.allowFullscreen = true; box.replaceChildren(frame);
    }
  }
  let searchSeq = 0;
  async function input(event) {
    if (!event.target.matches('.ln-search')) return;
    const query = event.target.value, seq = ++searchSeq, token = epoch;
    const results = rootEl.querySelector('.ln-search-results');
    if (!query.trim()) { results.replaceChildren(); return; }
    results.textContent = 'Looking through your lessons…';
    const all = await allSections(); if (destroyed || token !== epoch || seq !== searchSeq) return;
    const found = searchLessons(index,all,query);
    results.innerHTML = `<p class="ln-meta">${found.length} ${found.length === 1 ? 'match' : 'matches'}</p>${found.map(hit => `<button type="button" class="ln-search-hit" data-route="${esc(hit.route)}"><strong>${esc(hit.title)}</strong><span class="ln-meta">${esc(hit.detail)}</span></button>`).join('') || '<p class="ln-muted">No matches yet. Try a shorter word.</p>'}`;
  }
  function outside(event) { if (popup && !popup.contains(event.target) && !popupTrigger?.contains(event.target)) closePopup(); }
  function keydown(event) {
    if (!popup) return;
    if (event.key === 'Escape') { event.preventDefault(); closePopup(); }
    if (event.key === 'Tab') { event.preventDefault(); popup.querySelector('button').focus(); }
  }
  function reset() { progress = loadProgress(); void open(route); }
  rootEl.addEventListener('click',click); rootEl.addEventListener('input',input);
  document.addEventListener('pointerdown',outside); document.addEventListener('keydown',keydown); window.addEventListener('liftlog-learn-reset',reset); window.addEventListener('scroll',rememberScroll,{passive:true});
  void open('home');
  return {open,resume,current:() => route,destroy() { destroyed = true; ++epoch; cleanupPage(); rootEl.removeEventListener('click',click); rootEl.removeEventListener('input',input); document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',keydown); window.removeEventListener('liftlog-learn-reset',reset); window.removeEventListener('scroll',rememberScroll); rootEl.replaceChildren(); }};
}
