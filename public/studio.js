// Shared page helpers (loaded in <head>, before each page's own script): model table, total-cost lines, the
// "this costs money" confirmation, form memory, job progress (stage + elapsed time, no fake countdown), presets,
// templates and the Help / About / Privacy / Spend texts. Everything hangs off window.studio.
// ---------- the shell: every page runs inside /shell, a page that never reloads, so the radio keeps playing when you
// change tabs. A page opened on its own sends itself into the shell (add ?noshell to the address to skip that). Inside
// the shell a page reports its address and title to it, takes the safe-area padding it measured (a frame may not be
// given the notch / home-bar numbers), and opens outside links in a new tab (they refuse to be framed). ----------
(function () {
  const root = document.documentElement;
  let sh = null;
  try { sh = window.parent !== window && window.parent.__shell && window.parent.document.body.hasAttribute('data-shell') ? window.parent.__shell : null; } catch {}
  if (!sh) {
    if (window.parent === window && !root.hasAttribute('data-shell') && !/[?&]noshell(=|&|$)/.test(location.search)) {
      window.__shellRedirect = true; // app.js stands down, the page is about to be replaced
      root.style.visibility = 'hidden';
      try { location.replace('/shell?to=' + encodeURIComponent(location.pathname + location.search + location.hash)); } catch { root.style.visibility = ''; window.__shellRedirect = false; }
    }
    return;
  }
  window.__inShell = true;
  const setInsets = (i) => { if (!i) return; root.style.setProperty('--sat', i.t + 'px'); root.style.setProperty('--sar', i.r + 'px'); root.style.setProperty('--sab', i.b + 'px'); root.style.setProperty('--sal', i.l + 'px'); };
  setInsets(sh.insets); // before the first paint
  addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.shell === 'insets') setInsets(e.data.insets); });
  const report = () => { try { sh.page(location.pathname + location.search + location.hash, document.title, window); } catch {} };
  addEventListener('DOMContentLoaded', report); addEventListener('hashchange', report); addEventListener('pageshow', report);
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin !== location.origin) { e.preventDefault(); window.open(u.href, '_blank', 'noopener'); return; }
    // another page of the app: the shell switches to it and keeps this one alive (nothing typed or running is lost)
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (/^\/api\//.test(u.pathname) || /\.(?!html$)[a-z0-9]+$/i.test(u.pathname) || u.searchParams.has('download')) return; // files, not pages
    if (u.pathname === location.pathname && u.search === location.search) return; // same page / #anchor
    if (sh.go && sh.go(u.href)) e.preventDefault();
  }, true);
})();

// ---------- Hinglish mode (hidden: a gesture in app.js switches it on or off) ----------
// When it is on, every call this app makes to its own /api/ says so (header X-Lang: hinglish), and the server then writes,
// speaks and captions everything in modern Hinglish (never Devanagari) and turns off the models and voices that can't.
// A few subtitles and hint lines get a Hinglish version here; buttons, labels, headings and tab names never change.
(function () {
  let on = false; try { on = localStorage.getItem('hinglish') === '1'; } catch {}
  window.__hinglish = on;
  if (!on) return;
  const sameApi = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.indexOf('/api/') === 0; } catch { return false; } };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (sameApi(typeof input === 'string' ? input : input && input.url)) {
      const h = new Headers((init && init.headers) || (typeof input !== 'string' && input && input.headers) || {});
      h.set('X-Lang', 'hinglish'); init = Object.assign({}, init, { headers: h });
    }
    return realFetch(input, init);
  };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const r = realOpen.apply(this, arguments);
    if (sameApi(url)) { try { this.setRequestHeader('X-Lang', 'hinglish'); } catch {} }
    return r;
  };
  const HING = {
    'The details behind each tool, in one place.': 'Har tool ki details, ek hi jagah.',
    'Everything you made.': 'Jo bhi tumne banaya, sab yahin.',
    'One prompt, one video.': 'Ek prompt, ek video.',
    'Your AI influencers.': 'Tumhare AI influencers.',
    'Poses for TikTok, or copy any motion.': 'TikTok ke liye poses, ya koi bhi motion copy karo.',
    'Rom-com, comedy, kids and new-gen stories.': 'Rom-com, comedy, kids aur new-gen kahaniyan.',
    'Models, spending cap and storage.': 'Models, spending cap aur storage.',
    'A video or a few pictures in, ready-to-post Short out.': 'Video ya kuch pictures daalo, post-ready Short nikalo.',
    'Paste a story, get one finished video.': 'Story paste karo, ek ready video le jao.',
    'Your influencer reviews your product.': 'Tumhara influencer tumhare product ka review karega.',
    'The Director picks the best model for your budget': 'Director tumhare budget ke hisaab se best model chun leta hai',
    'Clips are silent; narration and music are added when stitching.': 'Clips silent hain; narration aur music stitching ke time add hote hain.',
    'Tap an idea or describe your own below.': 'Koi idea tap karo ya neeche apna idea likho.',
    'Pick an influencer and poses, then generate. One short clip per pose.': 'Influencer aur poses chuno, phir generate karo. Har pose ka ek chhota clip.',
    'Add a description, or the video comes back unchanged.': 'Ek description daalo, warna video waisa hi wapas aayega.',
    'Video models block real photos, so this makes a new AI character with your look.': 'Video models real photos block karte hain, isliye ye tumhare look ka naya AI character banata hai.',
    'Hook, story voiceover and music.': 'Hook, story voiceover aur music.',
    'Use only footage you have the rights to.': 'Sirf wahi footage use karo jiske rights tumhare paas hain.',
    'If a link fails, upload the file instead.': 'Link na chale to file upload kar do.',
    'Paid steps stop once the monthly cap is reached. Making videos also stops at the daily and weekly video limits.': 'Monthly cap poora hote hi paid steps ruk jaate hain. Video banana daily aur weekly limit pe bhi ruk jaata hai.',
  };
  const SKIP = 'button,a,label,h1,h2,h3,h4,summary,option,select,textarea,input,script,style,.chip,.btn,.tabbar,.sb,.radial,.radial-scrim,.model b';
  function walk(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim(), h = HING[t];
      if (!h) continue;
      const p = n.parentElement;
      if (!p || p.closest(SKIP)) continue;
      n.nodeValue = n.nodeValue.replace(t, h);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    walk(document.body);
    new MutationObserver((ms) => { for (const m of ms) for (const a of m.addedNodes) walk(a.nodeType === 1 ? a : a.parentElement || document.body); })
      .observe(document.body, { childList: true, subtree: true });
  });
})();

// ---------- page changes: a quick blur between pages, about 0.03 s in all. Tapping a tab blurs the screen (0.015 s), the
// next page opens under the same blur and it clears (0.015 s). It is a screen overlay (a filter on the page itself
// would make the fixed tab bar jump) and runs first, in <head>, so the new page is blurred before its first paint.
// Nothing happens on a first visit, with reduced motion, or for outside links. ----------
(function () {
  const doc = document.documentElement;
  if (!doc || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const OUT_MS = 15, IN_MS = 15, BLUR = 9, FLAG = 'pxNav';
  const flag = (v) => { try { v ? sessionStorage.setItem(FLAG, String(Date.now())) : sessionStorage.removeItem(FLAG); } catch {} };
  const flagged = () => { try { return Date.now() - Number(sessionStorage.getItem(FLAG) || 0) < 6000; } catch { return false; } };
  let el = null, safety = 0;
  const set = (blur, ms) => {
    const f = `blur(${blur}px)`, bg = blur ? 'rgba(5,6,13,.22)' : 'rgba(5,6,13,0)';
    el.style.transition = ms ? `backdrop-filter ${ms}ms linear,-webkit-backdrop-filter ${ms}ms linear,background-color ${ms}ms linear` : 'none';
    el.style.backdropFilter = el.style.webkitBackdropFilter = f; el.style.backgroundColor = bg;
  };
  function make(blur) {
    if (el) return;
    el = document.createElement('div'); el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    set(blur, 0); doc.appendChild(el); void el.offsetWidth; // painted at this strength before any change
  }
  function remove() { clearTimeout(safety); if (el) { el.remove(); el = null; } }

  // arriving after a tab change: start blurred, then clear
  if (flagged()) {
    flag(false); make(BLUR);
    const clear = () => { if (!el) return; set(0, IN_MS); setTimeout(remove, IN_MS + 30); };
    const go = () => (document.readyState === 'loading' ? addEventListener('DOMContentLoaded', clear, { once: true }) : clear());
    if (document.prerendering) document.addEventListener('prerenderingchange', go, { once: true }); else go();
    safety = setTimeout(remove, 2500); // never leave the screen blurred
  }
  // coming back from the back/forward cache: never show a stale blur
  addEventListener('pageshow', (e) => { if (e.persisted) { remove(); flag(false); } });

  // leaving: a tap on an inside link blurs the screen first, then the page changes
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin !== location.origin || /^\/api\//.test(u.pathname)) return;
    if (u.pathname === location.pathname && u.search === location.search) return; // same page / #anchor
    if (el) return; // already going somewhere
    e.preventDefault();
    flag(true); make(0); set(BLUR, OUT_MS);
    setTimeout(() => { location.href = u.href; }, OUT_MS + 3);
    safety = setTimeout(() => { remove(); flag(false); }, 5000); // navigation didn't happen: clear the blur
  }, false);
})();

(function () {
  const S = (window.studio = {});
  const esc = (S.esc = window.escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  // money is shown in dollars; the credits dialog can switch the whole app to credits (1 credit = $1)
  const asCredits = () => { try { return localStorage.getItem('units') !== 'usd'; } catch { return true; } }; // credits by default (1 credit = $1); dollars when switched in the credits dialog
  const creditNum = (usd) => { const c = usd; return !isFinite(c) ? '—' : c > 0 && c < 0.001 ? '<0.001' : c >= 100 ? Math.round(c).toLocaleString('en-US') : c >= 10 ? String(+c.toFixed(1)) : c >= 1 ? String(+c.toFixed(2)) : String(+c.toFixed(3)); };
  // Credits mode, the rest of the page: any "$1.50", "~$0.02/s", "($)" in text, options, placeholders and titles (also the ones the page
  // writes later) reads in credits. 1 credit = $1, so typed numbers (caps, budgets) stay exactly the same; only the unit changes.
  if (asCredits() && typeof document.addEventListener === 'function') {
    const reUsd = /\$(\d[\d,]*(?:\.\d+)?)/g;
    const fixCr = (t) => (t.indexOf('$') < 0 ? t : t.replace(/\(\$\)/g, '(credits)').replace(/ in \$( |$)/g, ' in credits$1').replace(reUsd, (m, n) => creditNum(parseFloat(n.replace(/,/g, ''))) + ' cr'));
    const skipEl = (el) => !el || el.closest('script,style,textarea,input,code,pre,[data-keep]');
    const fixNode = (n) => {
      if (n.nodeType === 3) { if (!skipEl(n.parentElement)) { const t = fixCr(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; } return; }
      if (n.nodeType !== 1 || skipEl(n)) return;
      for (const a of ['title', 'placeholder', 'aria-label']) { const v = n.getAttribute(a); if (v && v.indexOf('$') >= 0) n.setAttribute(a, fixCr(v)); }
      for (const c of n.childNodes) fixNode(c);
    };
    const start = () => {
      fixNode(document.body);
      new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') fixNode(m.target); else for (const n of m.addedNodes) fixNode(n); } })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }
  // Play a finished video on the page itself: a full-screen player with a Back button (also Esc, and the phone's own back gesture closes it)
  S.playVideo = (url, title = '') => {
    let dlg = document.getElementById('play-dlg');
    if (!dlg) {
      dlg = document.createElement('dialog'); dlg.id = 'play-dlg'; dlg.className = 'play-dlg'; dlg.setAttribute('aria-label', 'Video player');
      dlg.innerHTML = '<div class="pd-bar"><button type="button" class="pd-back" aria-label="Back"><svg class=ic aria-hidden=true><use href=#i-chevron></use></svg> Back</button><span class="pd-title"></span></div><video controls playsinline autoplay></video>';
      document.body.append(dlg);
      const v = dlg.querySelector('video');
      const close = () => { try { v.pause(); } catch {} v.removeAttribute('src'); v.load(); if (dlg.open) dlg.close(); };
      dlg.querySelector('.pd-back').onclick = close;
      dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
      dlg.addEventListener('close', () => { try { v.pause(); } catch {} });
      window.addEventListener('popstate', () => { if (dlg.open) close(); });
    }
    dlg.querySelector('.pd-title').textContent = title;
    const v = dlg.querySelector('video'); v.src = url;
    if (!dlg.open) dlg.showModal();
    try { history.pushState({ player: 1 }, ''); } catch {} // so the phone's back swipe closes the player instead of leaving the page
    v.play().catch(() => {});
  };
  const money = (S.money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : asCredits() ? creditNum(n) + ' cr' : n > 0 && n < 0.5 * 10 ** -d ? '<$' + (10 ** -d).toFixed(d) : '$' + Number(n).toFixed(d)));
  const ls = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  S.store = ls;

  // ---------- models (GET /api/models: live lengths, resolutions and prices per model) ----------
  let modelsP = null;
  S.models = () => (modelsP ||= fetch('/api/models' + (window.__hinglish && /^\/(?:ugc|index)?(?:\.html)?$/.test(location.pathname) ? '?speech=1' : '')).then((r) => r.json()).then((j) => {
    const map = {};
    for (const m of j.models || []) map[m.id] = m;
    return { map, list: j.models || [], def: j.default, providers: j.providers || {} };
  }).catch(() => ({ map: {}, list: [], def: null, providers: {} })));
  const TIER = { draft: 'Draft', regular: 'Regular', hero: 'Hero' };
  S.tierLabel = (t) => TIER[t] || '';
  S.rate = (m, res, audio = true) => { const p = m && m.price && (m.price[res] || m.price[m.res[0]]); return p ? p[audio && m.audio ? 0 : 1] : 0; };
  // "$0.40 for 4 s" (+ how Auto picks the length). n = how many clips (variations, poses)
  S.costLine = (m, { res, dur, audio = true, n = 1 } = {}) => {
    if (!m) return { total: 0, text: '—' };
    const auto = !(+dur > 0), d = auto ? m.defaultDur : +dur, rate = S.rate(m, res, audio), total = rate * d * n;
    const range = m.durs.length < 6 ? m.durs.join(' / ') + ' s' : `${m.durs[0]}–${m.durs[m.durs.length - 1]} s`;
    const text = `≈ ${money(total)} for ${n > 1 ? n + ' × ' : ''}${d} s` + (auto ? ` · Auto: ${d} s default, may pick ${range}` : '') + ` · ${money(rate, 3)}/s`;
    return { total, text, d, rate };
  };
  S.durOptions = (m, cur) => '<option value="">Auto</option>' + (m ? m.durs : []).map((d) => `<option value="${d}"${+cur === d ? ' selected' : ''}>${d} s</option>`).join('');
  S.notesHTML = (m) => (m && m.notes && m.notes.length ? '<span aria-hidden="true">ℹ</span> ' + m.notes.map(esc).join(' · ') : '');

  // ---------- confirmation before anything is charged ----------
  let settingsP = null;
  const settings = () => (settingsP ||= fetch('/api/settings').then((r) => r.json()).then((j) => j.settings || {}).catch(() => ({})));
  S.settings = settings;
  // Confirmations show inline, right under the button that asked for them (or in the page's #confirmHost), never as
  // a pop-up. One at a time; Esc or Cancel closes it.
  let lastBtn = null;
  if (typeof addEventListener === 'function') addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button, a.btn'); if (b && !b.closest('.inline-confirm')) lastBtn = b; }, true);
  function inlinePanel(cls, title) {
    document.querySelectorAll('.inline-confirm').forEach((x) => x._cancel ? x._cancel() : x.remove());
    const el = document.createElement('div');
    el.className = 'inline-confirm ' + (cls || '');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', title);
    const host = document.getElementById('confirmHost');
    if (host) host.append(el);
    else if (lastBtn && lastBtn.isConnected) {
      // A page can say where a button's confirmation goes (data-confirm-anchor on an ancestor, e.g. a card in a grid). A button in a
      // ⋯ menu never hosts it: the menu closes right after the click and would hide the confirmation inside it.
      const menu = lastBtn.closest('[role="menu"]');
      const at = lastBtn.closest('[data-confirm-anchor]') || (menu && menu.parentElement) || lastBtn;
      at.insertAdjacentElement('afterend', el);
    }
    else (document.querySelector('.wrap') || document.body).append(el);
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    return el;
  }
  // rows: [[label, value], ...]; total: dollars. Resolves true (go) or false.
  S.confirmSpend = async ({ title = 'Start this generation?', rows = [], total = 0, note = '' } = {}) => {
    const st = await settings();
    const first = !ls.get('paidOk', false);
    if (!first && total > 0 && total < (+st.confirmUnder || 0)) return true;
    return new Promise((resolve) => {
      const d = inlinePanel('', title);
      d.innerHTML = `<h3>${esc(title)}</h3>` +
        `<dl class="cf-rows">${rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}` +
        `<dt>Estimated total</dt><dd class="cf-total">${money(total)}</dd></dl>` +
        (note ? `<p class="sd-note">${esc(note)}</p>` : '') +
        (first ? '<p class="cf-warn" role="alert"><b>Heads up:</b> this will eat part of your credits. Your monthly cap in Settings stops spending once it is reached.</p>' : '') +
        `<div class="cf-act"><button class="btn primary" data-yes type="button">Confirm · ${money(total)}</button><button class="btn" data-no type="button">Cancel</button></div>`;
      const done = (v) => { d.remove(); if (v) ls.set('paidOk', true); resolve(v); };
      d._cancel = () => done(false);
      d.querySelector('[data-yes]').onclick = () => done(true);
      d.querySelector('[data-no]').onclick = () => done(false);
      d.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
      d.querySelector('[data-yes]').focus({ preventScroll: true });
    });
  };

  // ---------- the Director: asks the app's brain for the model and process, shows its plan, returns the approved one ----------
  S.AUTO = '__auto';
  S.director = async (req) => {
    const r = await fetch('/api/director', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'The Director could not make a plan');
    return j;
  };
  S.directorBudget = async (page) => { const st = await settings(); return ((st.directorBudget || {})[page]) || ({ clip: 0.5, story: 2, ugc: 0.8, poses: 0.15, motion: 1 })[page]; };
  // single clip / UGC / poses / motion: shows the choice, why, alternatives (one tap to switch) and the total vs budget
  // n = how many clips the plan is used for (variations, poses). Resolves the approved plan, or null.
  S.confirmPlan = async (res, { n = 1, title = 'The Director’s plan' } = {}) => {
    const { map } = await S.models();
    const first = !ls.get('paidOk', false);
    let plan = { ...res.plan };
    const totalOf = (p) => { const m = map[p.model]; return (m ? S.rate(m, p.resolution, p.audio) * p.duration : 0) * n + (p.pictureFirst ? 0.02 * n : 0); };
    return new Promise((resolve) => {
      const d = inlinePanel('director-dlg', title);
      const paint = () => {
        const m = map[plan.model] || { name: plan.model }, total = totalOf(plan), over = res.budget && total > res.budget + 1e-9;
        d.innerHTML = `<h3><svg class=ic aria-hidden=true><use href=#i-brain></use></svg> ${esc(title)}</h3>
          <p class="dir-why">${esc(plan.reason || '')}</p>
          <dl class="cf-rows"><dt>Model</dt><dd>${esc(m.name)} <span class="tier ${esc(m.tier || '')}">${S.tierLabel(m.tier)}</span> · quality ${m.q || '?'}/10</dd>
          <dt>Length</dt><dd>${plan.duration} s${n > 1 ? ' × ' + n : ''}</dd><dt>Resolution</dt><dd>${esc(plan.resolution)}</dd>
          <dt>Sound</dt><dd>${plan.audio ? 'On' : 'Off'}</dd><dt>Picture first</dt><dd>${plan.pictureFirst ? 'Yes: draws a still, then animates it (keeps the face)' : 'No'}</dd>
          <dt>After</dt><dd>${plan.enhance ? 'Enhance to ' + esc(plan.enhance.upscale) + ' (free)' : 'Nothing'}</dd>
          <dt>Estimated total</dt><dd class="cf-total">${money(total)}${res.budget ? ` <small>of your ${money(res.budget)} budget</small>` : ''}</dd></dl>
          ${over ? '<p class="cf-warn">This choice is over your budget.</p>' : ''}
          ${(res.warnings || []).length ? `<p class="meta">${res.warnings.map(esc).join('<br>')}</p>` : ''}
          ${(plan.alternatives || []).length ? `<div class="dir-alts"><span class="meta">Or switch to:</span>${plan.alternatives.map((a, i) => `<button type="button" class="btn" data-alt="${i}">${esc(a.name || a.model)} · ${money(totalOf({ ...plan, model: a.model, resolution: (map[a.model] || {}).res && map[a.model].res.includes(plan.resolution) ? plan.resolution : ((map[a.model] || {}).res || [])[0] }))}<small>${esc(a.why || '')}</small></button>`).join('')}</div>` : ''}
          <p class="meta">Decided by ${res.source === 'rules' ? 'the built-in rules (the AI brain did not answer)' : esc(res.brain || 'the AI') + (res.cached ? ' (same plan as a moment ago, free)' : ` (${money(res.brainCost, 4)})`)} from ${res.candidates} models.</p>
          ${first ? '<p class="cf-warn" role="alert"><b>Heads up:</b> this will eat part of your credits. Your monthly cap in Settings stops spending once it is reached.</p>' : ''}
          <div class="cf-act"><button class="btn primary" data-yes type="button">Confirm · ${money(total)}</button><button class="btn" data-no type="button">Cancel</button></div>`;
        d.querySelectorAll('[data-alt]').forEach((b) => (b.onclick = () => {
          const a = plan.alternatives[+b.dataset.alt], am = map[a.model];
          const prev = { model: plan.model, name: (map[plan.model] || {}).name, why: 'The Director’s first choice' };
          plan = { ...plan, model: a.model, duration: am && am.durs.length ? am.durs.reduce((x, y) => (Math.abs(y - plan.duration) < Math.abs(x - plan.duration) ? y : x), am.durs[0]) : plan.duration,
            resolution: am && am.res.includes(plan.resolution) ? plan.resolution : am ? (am.res.includes('720p') ? '720p' : am.res[0]) : plan.resolution,
            audio: am ? plan.audio && !!am.audio : plan.audio, pictureFirst: plan.pictureFirst && am && (am.frames || []).includes('first_frame'),
            reason: `You switched to ${am ? am.name : a.model}: ${a.why || ''}`, alternatives: [prev, ...plan.alternatives.filter((x) => x.model !== a.model)].slice(0, 2) };
          paint();
        }));
        d.querySelector('[data-yes]').onclick = () => done(plan);
        d.querySelector('[data-no]').onclick = () => done(null);
      };
      const done = (v) => { d.remove(); if (v) ls.set('paidOk', true); resolve(v); };
      d._cancel = () => done(null);
      d.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
      paint();
    });
  };

  // A page's own model <select> with a "Auto" option: when Auto is picked, ask the Director, show its plan, then
  // set the page's model / length / resolution / sound fields to the approved plan. Resolves:
  //   { ok: true, plan: null }  → not on Auto, the page carries on as before (with its own confirmation)
  //   { ok: true, plan }        → approved; fields are set, the page skips its own confirmation
  //   { ok: false }             → cancelled or failed (message already shown)
  S.addAutoOption = (sel) => {
    if (!sel || sel.querySelector(`option[value="${S.AUTO}"]`)) return;
    sel.insertAdjacentHTML('afterbegin', `<option value="${S.AUTO}">Auto: the Director picks the best within budget</option>`);
    sel.addEventListener('change', (e) => { if (e.isTrusted) delete sel.dataset.auto; }); // picked by hand: stays picked
  };
  S.autoSelect = async (sel, { page, prompt, aspect, budget, n = 1, startPicture, durSel, resSel, audioSel, title } = {}) => {
    // the last run was Auto (the dropdown shows the Director's pick): ask the Director again
    if (sel && sel.dataset.auto === '1') { sel.value = S.AUTO; delete sel.dataset.auto; sel.dispatchEvent(new Event('change')); }
    if (!sel || sel.value !== S.AUTO) return { ok: true, plan: null };
    let res;
    try { res = await S.director({ page, prompt, aspect, budget, startPicture, audio: audioSel ? audioSel.value === 'true' : undefined }); }
    catch (e) { toast(e.message, 'err'); return { ok: false }; }
    window.dispatchEvent(new Event('spend-changed'));
    const plan = await S.confirmPlan(res, { n, title });
    if (!plan) return { ok: false };
    const { map } = await S.models();
    const setOpt = (s, v, label) => { if (!s) return; if (![...s.options].some((o) => o.value === String(v))) s.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(label || v)}</option>`); s.value = String(v); };
    setOpt(sel, plan.model, (map[plan.model] || {}).name); sel.dataset.auto = '1';
    setOpt(durSel, plan.duration, plan.duration + ' s'); setOpt(resSel, plan.resolution);
    if (audioSel) audioSel.value = plan.audio ? 'true' : 'false';
    [sel, durSel, resSel, audioSel].forEach((s) => s && s.dispatchEvent(new Event('change')));
    return { ok: true, plan };
  };

  // ---------- form memory: fields come back after leaving the page ----------
  S.persistForm = (key, ids, { onRestore } = {}) => {
    const saved = ls.get('form:' + key, {});
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (saved[id] != null) {
        if (el.type === 'checkbox') el.checked = !!saved[id];
        else if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === saved[id])) el.dataset.pending = saved[id];
        else el.value = saved[id];
      }
      const save = () => { const all = ls.get('form:' + key, {}); all[id] = el.type === 'checkbox' ? el.checked : el.value; ls.set('form:' + key, all); };
      el.addEventListener('input', save);
      el.addEventListener('change', save);
    }
    onRestore && onRestore(saved);
    return saved;
  };
  S.saveField = (key, id, v) => { const all = ls.get('form:' + key, {}); all[id] = v; ls.set('form:' + key, all); };
  S.formValue = (key, id) => ls.get('form:' + key, {})[id];

  // ---------- job progress: stage + elapsed time (OpenRouter gives no percentage, so no countdown) ----------
  const STAGES = [['queued', 'Queued'], ['generating', 'Generating'], ['done', 'Done']];
  S.stageHTML = (j = {}) => {
    const st = j.stage || 'queued', k = STAGES.findIndex((s) => s[0] === st);
    const ty = j.typical ? ` · usually ${j.typical[0]}–${j.typical[1]} s` : '';
    const msg = j.msg || (st === 'queued' ? 'Waiting at the provider' : st === 'generating' ? 'Making your video' : 'Done');
    return `<div class="prog" role="status" aria-live="polite"><ol class="stages">${STAGES.map((s, i) => `<li class="${i < k || st === 'done' ? 'past' : i === k ? 'now' : ''}">${s[1]}</li>`).join('')}</ol>` +
      `<div class="bar indet${st === 'done' ? ' full' : ''}"><div class="fill"></div></div>` +
      `<div class="meta">${esc(msg)}${j.elapsed != null ? ` · ${j.elapsed} s elapsed${ty}` : ''}</div></div>`;
  };

  // ---------- job id check (Fetch by job ID) ----------
  S.validJobId = (id) => /^(gen-|fal_|bp_)?[\w-]{8,}$/.test(String(id || '').trim());

  // ---------- presets: one tap for the usual formats ----------
  S.PRESETS = {
    reels: { label: 'Reels 9:16 · 15 s', aspect: '9:16', len: 15, res: '720p', model: 'google/veo-3.1-lite', voice: 'af_heart', shortsLen: '15-30' },
    yt: { label: 'YouTube Short 9:16 · 30 s', aspect: '9:16', len: 30, res: '720p', model: 'google/veo-3.1-lite', voice: 'am_michael', shortsLen: '15-30' },
    tiktok: { label: 'TikTok 9:16 · 15 s', aspect: '9:16', len: 15, res: '720p', model: 'x-ai/grok-imagine-video-1.5-lite', voice: 'am_adam', shortsLen: '15-30' },
  };
  // the Reels / YouTube Short / TikTok preset chips were removed from the UI to keep pages simple
  S.presetChips = (el) => { if (el) el.remove(); };

  // ---------- templates: a starting point instead of a blank box ----------
  S.TEMPLATES = [
    { id: 'passport', name: 'Passport photo story', pages: ['clip'], prompt: 'A traveller rushes into a small photo studio the night before a flight, sits for a passport photo, blinks at the flash, gets the photo strip and laughs at it, then runs out to catch a taxi. Warm evening light, handheld feel.' },
    { id: 'unboxing', name: 'Product unboxing', pages: ['clip', 'ugc'], prompt: 'Close-up of hands opening a sleek matte box on a wooden desk, lifting the product out slowly, turning it in soft window light, then a satisfied smile at the camera. Clean, bright, smartphone-style footage.' },
    { id: 'poses', name: 'Influencer pose pack', pages: ['clip'], prompt: 'A confident creator in a sunny street does three quick poses for the camera: a hand-on-hip look over the shoulder, a laugh while fixing sunglasses, and a slow spin. Golden hour, shallow depth of field.' },
    { id: 'beforeafter', name: 'Before and after', pages: ['clip'], prompt: 'A messy cluttered room transforms into a clean bright minimalist space: the camera pushes in slowly as items disappear and the light warms up. One continuous shot, satisfying reveal at the end.' },
    { id: 'testimonial', name: 'Testimonial', pages: ['ugc', 'clip'], prompt: 'A friendly person sits on a sofa holding the product, looks into the phone camera and says how it fixed their problem in one week, nodding and smiling. Natural daylight, authentic selfie video.' },
  ];
  S.templatePicker = (el, page, onPick) => {
    if (!el) return;
    const list = S.TEMPLATES.filter((t) => t.pages.includes(page));
    el.innerHTML = `<label class="tpl"><span>Start from a template</span><select aria-label="Start from a template"><option value="">Choose a template…</option>${list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>`;
    el.querySelector('select').onchange = (e) => { const t = list.find((x) => x.id === e.target.value); if (t) onPick(t); e.target.value = ''; };
  };

  // ---------- Help / About / Privacy / Spend & refunds ----------
  S.INFO = {
    help: ['Help', `<p><a href="/guide">How it works</a>: the details behind every tool.</p><h3>How paying works</h3><p>This app uses your own <b>OpenRouter</b> account. OpenRouter is a service that gives one key access to many AI models (video, pictures, voices). Every time you make something, OpenRouter charges your credit for it. The app never charges you itself.</p>
      <h3>What the numbers mean</h3><ul><li><b>This month</b>: what your OpenRouter key spent this calendar month (UTC), straight from OpenRouter.</li><li><b>Credit left</b>: money still on your OpenRouter account.</li><li><b>Cap left</b>: how much more this app may spend this month before it refuses paid calls (Settings → monthly cap, $10 by default).</li><li><b>API key limit</b>: an optional limit you can set on the key itself at openrouter.ai. It is separate from the app's cap.</li><li><b>App log (estimate)</b>: what this app recorded, by feature. Voice costs there are estimates.</li></ul>
      <h3>Before anything is charged</h3><p>Every paid button shows the model, length, resolution and total first. Nothing is charged until you press Confirm.</p>
      <h3>Saving money</h3><ul><li>Draft on cheap models (marked Draft), keep Hero models for the one shot that matters.</li><li>720p looks the same as 1080p on a phone.</li><li>Short clips (2–4 s) stitched together drift less than one long clip.</li><li>Make a picture first, then animate it: pictures cost about 1–3 cents.</li></ul>`],
    about: ['About', '<p>VD0 makes AI clips, stories, UGC reviews, poses and Shorts with your OpenRouter key. It runs on your own server; only you (behind the site password) can use it.</p><p>Fonts: Anton (SIL Open Font License). Video, picture and voice models are provided through OpenRouter and, if you add their keys, fal.ai and BytePlus.</p>'],
    privacy: ['Privacy', '<p>This is a single-user app. What it stores, and where:</p><ul><li><b>On your server</b> (DATA_DIR): your settings, influencer pictures, story drafts, the history list, the spend log and finished videos (deleted after the days set in Settings → Storage).</li><li><b>In this browser</b>: unsent form fields, the last model you picked and dismissed tips.</li><li><b>Sent to AI providers</b>: your prompts, pictures and videos you choose to use, only when you press Confirm.</li></ul><p>Nothing is shared with anyone else, and there are no trackers.</p>'],
    refunds: ['Spend & refunds', '<p>All charges are made by <b>OpenRouter</b> (or fal.ai / BytePlus if you added their keys) to your own account. This app cannot refund them.</p><ul><li>If a generation failed but you were charged, contact the provider\'s support with the job ID from History.</li><li>The monthly cap (Settings) stops this app from starting paid work once this month\'s spend reaches it.</li><li>For a hard limit, also set a spending limit on the key at openrouter.ai.</li></ul>'],
  };
  S.openInfo = (k) => {
    const [title, body] = S.INFO[k] || S.INFO.help;
    const d = document.createElement('dialog');
    d.className = 'spend-dlg info-dlg';
    d.setAttribute('aria-label', title);
    d.innerHTML = `<div class="sd-head"><h2>${title}</h2><button class="btn sd-x" data-x aria-label="Close"><svg class=ic aria-hidden=true><use href=#i-x></use></svg></button></div><div class="info-body">${body}</div>`;
    document.body.append(d);
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-x]')) { d.close(); d.remove(); } });
    d.addEventListener('close', () => d.remove());
    d.showModal();
  };
})();
