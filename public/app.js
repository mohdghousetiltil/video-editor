// Shared shell: sidebar (desktop), tab bar (mobile), page heading, server status, toasts.
(function () {
  if (window.__shellRedirect) return; // this page is being replaced by the shell right now
  const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    clip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 5 2.5-5 2.5z"/>'),
    story: svg('<rect x="2" y="6" width="9" height="12" rx="1.5"/><rect x="13" y="6" width="9" height="12" rx="1.5"/>'),
    ugc: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
    motion: svg('<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><circle cx="12" cy="12" r="3"/>'),
    shorts: svg('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
    pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    people: svg('<circle cx="9" cy="8" r="3"/><path d="M3 19c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.6c1.8.6 2.7 2 3 4.4"/>'),
  };
  // App feel on phones: no pinch zoom (iOS ignores user-scalable=no; double-tap zoom is off via touch-action in CSS), and the nav,
  // icons and buttons never open the copy / share callout on a long press.
  ['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('.sb,.tabbar,.radial,.btn,button,.chip,svg,.look-card,.pagehead')) e.preventDefault(); });
  // starting a text selection inside the page heading (a long press) is refused as well
  document.addEventListener('selectstart', (e) => { const n = e.target && (e.target.nodeType === 3 ? e.target.parentElement : e.target); if (n && n.closest && n.closest('.pagehead')) e.preventDefault(); }, true);
  document.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest('.sb,.tabbar,.radial,svg')) e.preventDefault(); });

  const items = [
    ['/', 'Single clip', ICON.clip, 'One prompt, one video'],
    ['/story', 'Story mode', ICON.story, 'Scenes, narration, stitch'],
    ['/ugc', 'UGC review', ICON.ugc, 'Influencer reviews a product'],
    ['/motion', 'Poses & motion', ICON.motion, 'Poses for TikTok, copy motion'],
    ['/shorts', 'Shorts maker', ICON.shorts, 'Long video → ready-to-post Short'],
    ['/influencers', 'Influencers', ICON.people, 'Your AI influencer library'],
    ['/scripts', 'Scripts', ICON.pen, 'Suspense script writer (chat)'],
    ['/history', 'History', ICON.history, 'Everything you made, search, retry'],
    ['/settings', 'Settings', ICON.gear, 'Models, Muse by Meta, spend cap'],
  ];
  // clean URLs (/shorts) and old ones (/shorts.html, /index.html) both count as the same page
  const here = location.pathname.replace(/\.html$/, '').replace(/^\/index$/, '/') || '/';

  const side = document.createElement('aside');
  side.className = 'sb';
  side.innerHTML =
    '<a class="sb-brand" href="/"><span class="sb-logo">'+ICON.clip+'</span><span>VIDEO<em>STUDIO</em></span></a>' +
    '<div class="sb-nav">' +
    items.map((i) => `<a href="${i[0]}" class="${i[0] === here ? 'on' : ''}" title="${i[1]}: ${i[3]}"${i[0] === here ? ' aria-current="page"' : ''}><span class="ic">${i[2]}</span><span class="tx"><b>${i[1]}</b><small>${i[3]}</small></span></a>`).join('') +
    '</div><a class="sb-queue" id="sbQueue" href="/history?status=running" hidden><span class="dot ok"></span><span id="sbQueueTxt"></span></a>' +
    '<div class="sb-foot"><span class="dot" id="sbDot"></span><span id="sbTxt">LINKING…</span><button type="button" class="sb-help" id="sbHelp" aria-label="Help">?</button></div>';
  document.body.prepend(side);

  // Mobile tab bar: 4 main tabs + a centre "more" orb that fans the remaining pages out on an arc.
  const PRIMARY = ['/', '/story', '/motion', '/shorts'];
  const prim = items.filter((i) => PRIMARY.includes(i[0]));
  const more = items.filter((i) => !PRIMARY.includes(i[0]));
  const inMore = more.find((i) => i[0] === here);
  const tab = (i) => `<a href="${i[0]}" class="${i[0] === here ? 'on' : ''}"${i[0] === here ? ' aria-current="page"' : ''}><span>${i[2]}</span>${i[1].split(' ')[0]}</a>`;
  const tabs = document.createElement('nav');
  tabs.className = 'tabbar';
  tabs.setAttribute('aria-label', 'Pages');
  tabs.innerHTML = tab(prim[0]) + tab(prim[1]) +
    `<button type="button" class="tb-more${inMore ? ' on' : ''}" aria-label="More pages" aria-expanded="false" aria-controls="radial">` +
    `<span class="tb-orb">${svg('<path d="M12 5v14M5 12h14"/>')}</span><small>${inMore ? inMore[1].split(' ')[0] : 'More'}</small></button>` +
    tab(prim[2]) + tab(prim[3]);
  document.body.append(tabs);

  const scrim = document.createElement('div');
  scrim.className = 'radial-scrim';
  const radial = document.createElement('div');
  radial.className = 'radial';
  radial.id = 'radial';
  radial.setAttribute('role', 'menu');
  radial.setAttribute('aria-label', 'More pages');
  // the pages fan out on a full circle in the middle of the screen (roomy on any phone), around a centre close button
  const n = more.length, R = n > 5 ? 128 : 118;
  radial.innerHTML = `<span class="radial-ring" aria-hidden="true" style="left:${-R - 46}px;top:${-R - 46}px;width:${2 * R + 92}px;height:${2 * R + 92}px"></span>` +
    `<button type="button" class="radial-x" aria-label="Close menu">${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button>` + more.map((i, k) => {
    const a = (-90 + (360 * k) / n) * Math.PI / 180;
    return `<a role="menuitem" href="${i[0]}" draggable="false" class="${i[0] === here ? 'on' : ''}" style="--x:${(Math.cos(a) * R).toFixed(1)}px;--y:${(Math.sin(a) * R).toFixed(1)}px;--d:${k * 40}ms">` +
      `<span class="ro">${i[2]}</span><b>${i[1]}</b></a>`;
  }).join('');
  radial.style.setProperty('--r', R + 'px');
  document.body.append(scrim, radial);
  // radio player (controls under the dial and in the sidebar)
  { const m = document.createElement('script'); m.src = '/music.js'; m.defer = true; document.head.appendChild(m); }

  // drag anywhere on the dial to spin it: the pages orbit the centre (labels stay upright), the dashed ring turns
  // with them, and a flick keeps it coasting for a moment. A tap without movement still opens the page.
  {
    const items = [...radial.querySelectorAll('a')], ring = radial.querySelector('.radial-ring');
    let rot = 0, drag = null, vel = 0, coast = 0, moved = false;
    const place = () => {
      items.forEach((el, k) => {
        const a = (-90 + (360 * k) / n + rot) * Math.PI / 180;
        el.style.setProperty('--x', (Math.cos(a) * R).toFixed(1) + 'px');
        el.style.setProperty('--y', (Math.sin(a) * R).toFixed(1) + 'px');
      });
      ring.style.setProperty('--rot', rot.toFixed(1) + 'deg');
    };
    const angle = (e) => { const r = radial.getBoundingClientRect(); return Math.atan2(e.clientY - r.top, e.clientX - r.left) * 180 / Math.PI; };
    radial.addEventListener('pointerdown', (e) => {
      if (e.button || e.target.closest('.radial-x')) return;
      cancelAnimationFrame(coast);
      drag = { id: e.pointerId, last: angle(e), x: e.clientX, y: e.clientY, t: performance.now() }; vel = 0; moved = false;
    });
    radial.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
        moved = true; radial.classList.add('spin');
        try { radial.setPointerCapture(e.pointerId); } catch {}
      }
      const a = angle(e), now = performance.now();
      let d = a - drag.last; if (d > 180) d -= 360; if (d < -180) d += 360;
      rot += d; vel = d / Math.max(8, now - drag.t); drag.last = a; drag.t = now;
      place();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      if (!moved) return;
      // coast: the spin slows down on its own
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let v = reduce ? 0 : Math.max(-0.6, Math.min(0.6, vel)), prev = performance.now();
      const step = (now) => {
        const dt = Math.min(40, now - prev); prev = now; rot += v * dt; v *= Math.pow(0.9, dt / 16); place();
        if (Math.abs(v) > 0.01) coast = requestAnimationFrame(step); else radial.classList.remove('spin');
      };
      coast = requestAnimationFrame(step);
    };
    radial.addEventListener('pointerup', end);
    radial.addEventListener('pointercancel', end);
    // a drag is not a tap: don't open the page the finger happened to lift on
    radial.addEventListener('click', (e) => { if (moved && e.target.closest('a')) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  }

  const moreBtn = tabs.querySelector('.tb-more');
  const setOpen = (open, refocus, kb) => {
    if (open) { // centre of the visible screen, a little above the middle so the bottom labels clear the tab bar
      const vv = window.visualViewport, h = vv ? vv.height : innerHeight, w = vv ? vv.width : innerWidth;
      radial.style.left = w / 2 + 'px';
      radial.style.top = Math.min(h / 2 - 20, h - 260) + 'px';
    }
    document.body.classList.toggle('radial-open', open);
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open && kb) setTimeout(() => radial.querySelector('a')?.focus({ preventScroll: true }), 60); // keyboard only: no focus box on a tap
    else if (refocus) moreBtn.focus();
  };
  const isOpen = () => document.body.classList.contains('radial-open');
  moreBtn.onclick = (e) => setOpen(!isOpen(), false, e.detail === 0);
  // Outside the dial: a tap on the left or right of the screen changes the music station (previous / next) while music
  // plays, and does nothing when it is off. A tap straight above or below the dial closes the menu (so does the More button).
  scrim.onclick = (e) => {
    const dx = e.clientX - radial.getBoundingClientRect().left;
    if (Math.abs(dx) <= 60) return setOpen(false);
    const r = window.studioRadio;
    if (!r || !r.on) return;
    dx < 0 ? r.prev() : r.next();
    const c = dx < 0 ? 'flash-l' : 'flash-r';
    scrim.classList.remove('flash-l', 'flash-r'); void scrim.offsetWidth; scrim.classList.add(c);
    setTimeout(() => scrim.classList.remove(c), 400);
  };
  radial.querySelector('.radial-x').onclick = () => setOpen(false, true);
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false, true); }
    if (/^Arrow/.test(e.key)) { // move between items
      const as = [...radial.querySelectorAll('a')], k = as.indexOf(document.activeElement);
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      as[(k + step + as.length) % as.length].focus(); e.preventDefault();
    }
  });
  addEventListener('resize', () => isOpen() && setOpen(false));
  addEventListener('pageshow', () => setOpen(false)); // back button shouldn't restore an open menu

  // Browsers without speculation rules (Safari, Firefox): start fetching a page as soon as a nav link is
  // touched or hovered, so the tap itself finds it ready.
  if (!(HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'))) {
    const done = new Set([here]);
    const warm = (e) => {
      const a = e.target.closest && e.target.closest('.sb a, .tabbar a, .radial a');
      if (!a || done.has(a.pathname)) return;
      done.add(a.pathname);
      fetch(a.href, { credentials: 'same-origin', priority: 'high' }).catch(() => {});
    };
    addEventListener('pointerdown', warm, { passive: true, capture: true });
    addEventListener('mouseover', warm, { passive: true });
    moreBtn.addEventListener('click', () => more.forEach((i) => warm({ target: radial.querySelector(`a[href="${i[0]}"]`) })));
  }

  const wrap = document.querySelector('.wrap');
  const title = document.body.dataset.title;
  if (wrap && title) {
    const h = document.createElement('div');
    h.className = 'pagehead';
    h.innerHTML = `<h1 data-text="${title}">${title}</h1><p>${document.body.dataset.sub || ''}</p>`;
    h.dataset.sys = (here.replace(/\W/g, '') || 'core').toUpperCase().slice(0, 8) + '.0x' + ((title.length * 2654435761) >>> 0).toString(16).slice(0, 4).toUpperCase();
    wrap.prepend(h);
  }

  // ---------- Spend tracker: this month's AI spend (OpenRouter's own figure) + where it went (local log) ----------
  const money = (n, d) => n == null ? '—' : n > 0 && n < 0.001 ? '<$0.001' : '$' + Number(n).toFixed(d ?? (Math.abs(n) < 1 ? 3 : 2));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sbSpend = document.createElement('button');
  sbSpend.type = 'button'; sbSpend.className = 'spend';
  sbSpend.innerHTML = '<span class="spend-k">This month</span><b class="spend-v">…</b><span class="spend-bar"><i></i></span><small class="spend-s"></small>';
  side.querySelector('.sb-foot').before(sbSpend);
  const chipHost = () => document.querySelector('.pagehead');
  const chip = document.createElement('button'); // phones: the sidebar is hidden, so a chip sits in the page head
  chip.type = 'button'; chip.className = 'spend-chip'; chip.innerHTML = '<span>This month</span> <b>…</b>';
  const dlg = document.createElement('dialog');
  dlg.className = 'spend-dlg';
  dlg.setAttribute('aria-label', 'AI spend');
  document.body.append(dlg);
  chipHost()?.append(chip);
  let spend = null;
  const paintSpend = (j) => {
    spend = j;
    // this month across every provider (OpenRouter's own figure + fal.ai), the same number the cap checks
    const or = j.openrouter, total = j.capUsed != null ? j.capUsed : or && or.month != null ? or.month : j.local.total;
    sbSpend.querySelector('.spend-v').textContent = money(total, 2);
    chip.querySelector('b').textContent = money(total, 2);
    // the bar shows the monthly cap from Settings when there is one, else the API key's own limit
    const cap = j.cap > 0 ? j.cap : 0;
    const lim = cap || (or && or.keyLimit), used = cap ? total : lim ? lim - (or.keyRemaining ?? lim) : 0;
    const falBal = j.fal && j.fal.balance != null ? ' · fal ' + money(j.fal.balance, 2) : '';
    const bar = sbSpend.querySelector('.spend-bar');
    bar.hidden = !lim;
    if (lim) { const p = Math.min(100, (used / lim) * 100); bar.firstChild.style.width = p + '%'; bar.classList.toggle('hot', p > 85); }
    // one meaning per number, same labels as the dialog: cap left (the app's own monthly cap), else OpenRouter credit left
    sbSpend.querySelector('.spend-s').textContent = (cap ? money(Math.max(0, cap - total), 2) + ' cap left of ' + money(cap, 0)
      : or && or.balance != null ? money(or.balance, 2) + ' credit left' : 'tap for details') + falBal;
    sbSpend.title = 'This month, all providers ' + money(total, 2) + (or && or.month != null ? ' · OpenRouter ' + money(or.month, 2) : '') + (or && or.balance != null ? ' · OpenRouter credit left ' + money(or.balance, 2) : '') +
      (j.fal && j.fal.balance != null ? ' · fal.ai credit left ' + money(j.fal.balance, 2) : '') + (cap ? ' · app cap ' + money(cap, 0) : '');
  };
  const loadSpend = (month) => fetch('/api/spend' + (month ? '?month=' + month : ''))
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => { if (!month || j.current) paintSpend(j); return j; })
    .catch(() => null);
  const openSpend = async (month) => {
    if (!dlg.open) dlg.showModal();
    const j = month || !spend ? await loadSpend(month) : spend;
    if (!j) { dlg.innerHTML = '<p>Couldn\'t load spending. Is the server running?</p><button class="btn" data-x>Close</button>'; return; }
    const or = j.openrouter || {}, L = j.local;
    const monthName = new Date(j.month + '-15').toLocaleString([], { month: 'long', year: 'numeric' });
    const maxF = Math.max(...L.byFeature.map((f) => f.cost), 0.0001), maxD = Math.max(...L.byDay.map((d) => d.cost), 0.0001);
    const lim = or.keyLimit, used = lim ? lim - (or.keyRemaining ?? lim) : 0;
    dlg.innerHTML =
      `<div class="sd-head"><h2>AI spend · ${esc(monthName)}</h2><button class="btn sd-x" data-x aria-label="Close"><svg class=ic aria-hidden=true><use href=#i-x></use></svg></button></div>` +
      (j.months.length > 1 ? `<label class="sd-month">Month<select>${j.months.map((m) => `<option ${m === j.month ? 'selected' : ''}>${m}</option>`).join('')}</select></label>` : '') +
      (j.current && j.openrouter ? `<div class="sd-tiles">
        <div><span>OpenRouter month total</span><b>${money(or.month, 2)}</b></div>
        <div><span>This week</span><b>${money(or.week, 2)}</b></div>
        <div><span>Today</span><b>${money(or.day, 2)}</b></div>
        <div><span>OpenRouter credit left</span><b>${money(or.balance, 2)}</b></div></div>` +
        (j.fal ? `<div class="sd-tiles sd-fal">
        <div><span>fal.ai this month</span><b>${money(j.fal.month != null ? j.fal.month : (L.byProvider || {}).fal || 0, 2)}</b></div>
        <div><span>fal.ai credit left</span><b>${money(j.fal.balance, 2)}</b></div>
        <div><span>All providers this month</span><b>${money(j.capUsed, 2)}</b></div></div>
        <p class="sd-note">fal.ai credit comes straight from fal. ${j.fal.month != null ? 'Its month total is fal\'s own figure (admin key).' : 'Its month total is this app\'s log (fal.ai prices per second); add FAL_ADMIN_KEY for fal\'s own figure.'}</p>` : '') +
        (j.cap > 0 ? `<div class="sd-lim"><div class="sd-lim-t"><span>App monthly cap (all providers)</span><span>${money(j.capUsed, 2)} of ${money(j.cap, 2)} used · ${money(Math.max(0, j.cap - (j.capUsed || 0)), 2)} cap left · <a href="/settings">change</a></span></div><div class="spend-bar${(j.capUsed || 0) / j.cap > .85 ? ' hot' : ''}"><i style="width:${Math.min(100, ((j.capUsed || 0) / j.cap) * 100)}%"></i></div></div>`
          : '<p class="sd-note">No monthly cap set. <a href="/settings">Set one in Settings</a> so paid calls stop at a limit you choose.</p>') +
        (lim ? `<div class="sd-lim"><div class="sd-lim-t"><span>API key limit (set at openrouter.ai)</span><span>${money(used, 2)} of ${money(lim, 2)} used · ${money(or.keyRemaining, 2)} left on key</span></div><div class="spend-bar${used / lim > .85 ? ' hot' : ''}"><i style="width:${Math.min(100, (used / lim) * 100)}%"></i></div></div>` : '') +
        `<p class="sd-note">The month total and credit come straight from OpenRouter (calendar month, UTC) and include everything this key spent, also outside this app. They are the numbers that count.</p>` : '') +
      (j.current && j.limits && (j.limits.dailyCap > 0 || j.limits.weeklyCap > 0) ? (() => { const Lm = j.limits, row = (label, used, cap, tail) => cap > 0 ? `<div class="sd-lim"><div class="sd-lim-t"><span>${label}</span><span>${money(used, 2)} of ${money(cap, 2)} · ${money(Math.max(0, cap - used), 2)} left${tail}</span></div><div class="spend-bar${used / cap > .85 ? ' hot' : ''}"><i style="width:${Math.min(100, (used / cap) * 100)}%"></i></div></div>` : ''; return row('Video limit today', Lm.today + Lm.pending, Lm.dailyCap, ' · <a href="/settings">change</a>') + row('Video limit this week', Lm.week + Lm.pending, Lm.weeklyCap, ''); })() : '') +
      `<h3>App log (estimate) <small>${money(L.total)} recorded by this app</small></h3>` +
      (L.byProvider && Object.keys(L.byProvider).length > 1 ? `<p class="sd-note">By provider: ${Object.entries(L.byProvider).map(([k, v]) => `${k === 'fal' ? 'fal.ai' : k === 'byteplus' ? 'BytePlus' : 'OpenRouter'} ${money(v)}`).join(' · ')}</p>` : '') +
      (j.current && or.month != null && Math.abs(or.month - ((L.byProvider || {}).openrouter ?? L.total)) >= 0.01 ? `<p class="sd-note">${money(Math.abs(or.month - L.total), 2)} ${or.month > L.total ? 'not in the app log: calls made elsewhere with this key, or before the log started' : 'more in the app log than OpenRouter reports: voice costs are estimates and OpenRouter can lag a few minutes'}.</p>` : '') +
      (L.byFeature.length ? `<div class="sd-rows">${L.byFeature.map((f) => `<div class="sd-row"><span>${esc(f.feature)} <small>${f.count}×</small></span><span class="sd-track"><i style="width:${(f.cost / maxF) * 100}%"></i></span><b>${money(f.cost)}</b></div>`).join('')}</div>`
        : '<p class="sd-note">Nothing logged yet this month. Costs are recorded from now on as you make videos.</p>') +
      (L.byDay.length ? `<h3>By day</h3><div class="sd-days">${L.byDay.map((d) => `<i title="${d.day}: ${money(d.cost)}" style="height:${Math.max(4, (d.cost / maxD) * 100)}%"></i>`).join('')}</div>
        <div class="sd-days-l"><span>${L.byDay[0].day.slice(5)}</span><span>${L.byDay[L.byDay.length - 1].day.slice(5)}</span></div>` : '') +
      `<p class="sd-note">The app's log covers only what this app spent since the tracker was added; the voice cost is an estimate (the voice service doesn't report it).</p>`;
    dlg.querySelector('select')?.addEventListener('change', (e) => openSpend(e.target.value));
  };
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-x]')) dlg.close(); });
  sbSpend.onclick = chip.onclick = () => openSpend();
  loadSpend();
  setInterval(() => { if (!document.hidden) loadSpend(); }, 60000);
  addEventListener('spend-changed', () => setTimeout(loadSpend, 1500)); // pages can nudge it after a paid action

  // ---------- Easter eggs (Settings → "Little easter-egg glitches"; off when the OS asks for reduced motion) ----------
  //  · every few minutes a page title or heading glitches for a split second (never buttons)
  //  · ↑ ↑ ↓ ↓ ← → ← → B A  → OVERDRIVE
  //  · click the logo (or, on a phone, tap the page title) 5 times fast → the nav gets hacked for a moment
  //  · type "glitch" anywhere outside a text box → the screen tears
  //  · phones: hold the centre orb 1.5 s without moving → OVERDRIVE; shake hard → tear (Android)
  //  · touch: 2-finger tap, 3-finger tap, hold the title, pull down 3 times, turn sideways and back (see below)
  //  · iPhone home-screen app: a boot screen at most once an hour
  //  · after midnight the server light says NETRUNNER ONLINE
  (() => {
    let on = true;
    try { on = localStorage.getItem('eggs') !== '0'; } catch {}
    if (!sessionStorage.getItem('eggsSync')) { // pick up the server setting once per visit
      fetch('/api/settings').then((r) => r.json()).then((j) => { try { localStorage.setItem('eggs', j.settings.eggs ? '1' : '0'); sessionStorage.setItem('eggsSync', '1'); } catch {} }).catch(() => {});
    }
    if (!on || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const glitch = (el) => { if (!el) return; el.classList.remove('eg-glitch'); void el.offsetWidth; el.classList.add('eg-glitch'); setTimeout(() => el.classList.remove('eg-glitch'), 420); };
    const tear = (n = 5) => {
      for (let i = 0; i < n; i++) setTimeout(() => {
        const t = document.createElement('div');
        t.className = 'eg-tear';
        t.style.cssText = `--y:${Math.random() * 92}vh;--h:${6 + Math.random() * 46}px;--x:${(Math.random() < .5 ? -1 : 1) * (20 + Math.random() * 60)}px`;
        document.body.append(t); setTimeout(() => t.remove(), 260);
      }, i * 70);
    };
    const tick = () => {
      if (!document.hidden) {
        // headings only: nothing you are about to tap ever jumps
        const pool = [...document.querySelectorAll('.pagehead h1, .sb-brand, .panel h2')].filter((e) => e.offsetParent);
        glitch(pool[Math.floor(Math.random() * pool.length)]);
      }
      setTimeout(tick, 120000 + Math.random() * 120000);
    };
    setTimeout(tick, 60000 + Math.random() * 60000);
    const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} }; // Android only; iPhones ignore it
    const overdrive = () => {
      document.body.classList.add('eg-overdrive'); tear(6); buzz([40, 30, 120]);
      toast('OVERDRIVE ENGAGED // all limiters off (not really)', 'ok');
      setTimeout(() => document.body.classList.remove('eg-overdrive'), 2500);
    };
    // nav labels (sidebar on desktop, tab bar on phones) scramble into hex/katakana for a moment
    const hack = () => {
      const nodes = [...side.querySelectorAll('.sb-nav .tx b')]
        .concat([...tabs.querySelectorAll('a, .tb-more small')].map((el) => [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()) || el.querySelector('small')).filter(Boolean));
      const orig = nodes.map((n) => n.textContent);
      const junk = (len) => Array.from({ length: len }, () => '0123456789ABCDEF#$%&ｱｲｳｴｵ'[Math.floor(Math.random() * 25)]).join('');
      let n = 0;
      const iv = setInterval(() => {
        nodes.forEach((x, i) => { x.textContent = junk(Math.max(4, orig[i].length)); x.parentElement?.classList.add('eg-scramble'); });
        if (++n > 12) { clearInterval(iv); nodes.forEach((x, i) => { x.textContent = orig[i]; x.parentElement?.classList.remove('eg-scramble'); }); }
      }, 70);
      tear(3); buzz([20, 40, 20]); toast('SIGNAL INTRUSION DETECTED // 0xDEADBEEF // just kidding', 'err');
    };

    // ---- keyboard: Konami code, typing "glitch" ----
    const KON = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let k = 0, typed = '';
    addEventListener('keydown', (e) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      k = key === KON[k] ? k + 1 : key === KON[0] ? 1 : 0;
      if (k === KON.length) { k = 0; overdrive(); }
      if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable || key.length !== 1) return;
      typed = (typed + key).slice(-6);
      if (typed === 'glitch') { tear(9); glitch(document.querySelector('.pagehead h1')); typed = ''; }
    });

    // ---- mouse / touch: 5 fast taps on the logo (desktop) or the page title (phones) hacks the nav ----
    const fastTaps = (el, n, fn) => {
      let ts = [];
      el && el.addEventListener('click', (e) => {
        const now = Date.now(); ts = ts.filter((t) => now - t < 1600); ts.push(now);
        if (ts.length >= n) { ts = []; e.preventDefault(); fn(); }
      });
    };
    fastTaps(side.querySelector('.sb-logo'), 5, hack);
    fastTaps(document.querySelector('.pagehead h1'), 5, hack);

    // ---- touch: hold the centre "More" orb for 1.5 s → overdrive (the tap that follows doesn't open the menu) ----
    let holdT = null, held = false;
    const orb = tabs.querySelector('.tb-more');
    // a finger that moves (scrolling, sliding off) cancels the hold, so a scroll never fires it
    let hx = 0, hy = 0;
    orb.addEventListener('pointerdown', (e) => { held = false; hx = e.clientX; hy = e.clientY; clearTimeout(holdT); holdT = setTimeout(() => { held = true; overdrive(); }, 1500); });
    orb.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - hx, e.clientY - hy) > 10) clearTimeout(holdT); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => orb.addEventListener(ev, () => clearTimeout(holdT)));
    orb.addEventListener('click', (e) => { if (held) { held = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    orb.addEventListener('contextmenu', (e) => e.preventDefault()); // no long-press menu on Android

    // ---- shake the phone → the screen tears (Android; iPhones only send motion after a permission prompt) ----
    if ('DeviceMotionEvent' in window && typeof DeviceMotionEvent.requestPermission !== 'function') {
      let last = 0, hits = [];
      addEventListener('devicemotion', (e) => {
        const a = e.accelerationIncludingGravity; if (!a) return;
        const f = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0), now = Date.now();
        if (f > 45) { hits = hits.filter((t) => now - t < 900); hits.push(now); }
        if (hits.length >= 4 && now - last > 8000) { last = now; hits = []; tear(4); buzz(60); glitch(document.querySelector('.pagehead h1')); }
      });
    }

    // ---- touch screens, extra for the iPhone home-screen app ----
    //  · two-finger tap → RGB split flash   · three-finger tap → the nav gets hacked
    //  · hold the page title 1 s → hologram title   · pull down hard at the top 3 times → SYSTEM REBOOT sweep
    //  · turn the phone sideways and back within 2 s → barrel roll
    //  · home-screen app: a boot screen for 3.756 s, at most once an hour (tap to skip)
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    if (matchMedia('(pointer: coarse)').matches) {
      const rgb = () => { document.body.classList.remove('eg-rgb'); void document.body.offsetWidth; document.body.classList.add('eg-rgb'); setTimeout(() => document.body.classList.remove('eg-rgb'), 650); };
      let multi = null;
      addEventListener('touchstart', (e) => { if (e.touches.length >= 2) multi = { n: e.touches.length, t: Date.now(), moved: false }; }, { passive: true });
      addEventListener('touchmove', () => { if (multi) multi.moved = true; }, { passive: true });
      addEventListener('touchend', (e) => {
        if (!multi || e.touches.length) return;
        const m = multi; multi = null;
        if (m.moved || Date.now() - m.t > 350) return;
        if (m.n === 2) rgb(); else if (m.n >= 3) hack();
      }, { passive: true });
      // hold the title
      const h1 = document.querySelector('.pagehead h1');
      if (h1) {
        let ht;
        h1.addEventListener('touchstart', () => { ht = setTimeout(() => { h1.classList.add('eg-holo'); buzz(30); setTimeout(() => h1.classList.remove('eg-holo'), 6000); }, 1000); }, { passive: true });
        ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => h1.addEventListener(ev, () => clearTimeout(ht), { passive: true }));
      }
      // pull down hard at the very top (the iPhone bounce) three times
      let py = null, pulls = [];
      addEventListener('touchstart', (e) => { py = scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
      addEventListener('touchend', (e) => {
        if (py == null) return;
        const dy = (e.changedTouches[0]?.clientY || 0) - py; py = null;
        if (dy < 140) return;
        const now = Date.now(); pulls = pulls.filter((t) => now - t < 4000); pulls.push(now);
        if (pulls.length >= 3) { pulls = []; document.body.classList.add('eg-reboot'); tear(4); setTimeout(() => document.body.classList.remove('eg-reboot'), 1300); }
      }, { passive: true });
      // sideways and back
      let turned = 0;
      const so = screen.orientation;
      const onTurn = () => {
        const land = so ? /landscape/.test(so.type) : Math.abs(window.orientation || 0) === 90;
        if (land) turned = Date.now();
        else if (turned && Date.now() - turned < 2000) { turned = 0; document.body.classList.add('eg-roll'); setTimeout(() => document.body.classList.remove('eg-roll'), 1100); }
      };
      so && so.addEventListener ? so.addEventListener('change', onTurn) : addEventListener('orientationchange', onTurn);
    }
    if (standalone) {
      // at most once an hour
      const HOUR = 3600000, now = Date.now();
      let last = 0; try { last = Number(localStorage.getItem('egBootAt')) || 0; } catch {}
      if (now - last >= HOUR) {
        try { localStorage.setItem('egBootAt', String(now)); } catch {}
        const boot = document.createElement('div');
        boot.className = 'eg-boot'; boot.setAttribute('aria-hidden', 'true');
        // a different crew each boot
        const CREWS = ['NETRUNNER', 'FIXER', 'TECHIE', 'NOMAD', 'SOLO', 'ROCKERBOY', 'MEDTECH', 'MEDIA'];
        const crew = new Date().getHours() < 4 ? 'NETRUNNER' : CREWS[Math.floor(Math.random() * CREWS.length)];
        const lines = ['VIDEO//STUDIO OS v3.1', 'LINKING NEURAL RENDER CORE ......... OK', `JACKING IN ${crew} CREW .............. OK`, 'CALIBRATING LOOKS ...................... OK', `WELCOME BACK, ${crew}`];
        // on screen for 3.756 s: the lines type in over the first ~2.4 s, then it holds and fades
        boot.innerHTML = lines.map((l, i) => `<div style="--d:${i * 600}ms">${l}</div>`).join('');
        const end = () => { boot.classList.add('out'); setTimeout(() => boot.remove(), 300); };
        boot.addEventListener('click', end);
        document.body.append(boot); setTimeout(end, 3756);
      }
    }

    // night owls: after midnight the status light (desktop) says NETRUNNER ONLINE and the phone orb glows magenta
    const hr = new Date().getHours();
    if (hr < 4) { window.__eggNight = true; document.body.classList.add('eg-night'); }
  })();

  // ---------- Help (sidebar ? and footer), footer, render queue ----------
  const S = window.studio;
  if (S) {
    document.getElementById('sbHelp').onclick = () => S.openInfo('help');
    // theme bar under the title on the pages that make videos
    // the Look picker only where it shapes the video: inside the form on Single clip and Story
    if (S.mountThemeBar && ['/', '/story'].includes(here)) {
      const host = document.getElementById('lookHost');
      host ? S.mountThemeBar(host, { inline: true }) : S.mountThemeBar(wrap && wrap.querySelector('.pagehead'));
      S.loadThemes();
    }
    if (wrap) {
      const ft = document.createElement('footer');
      ft.className = 'site-foot';
      ft.innerHTML = '<a href="/guide">How it works</a><span aria-hidden="true">·</span>' + ['help', 'about', 'privacy', 'refunds'].map((k) => `<button type="button" data-k="${k}">${S.INFO[k][0]}</button>`).join('<span aria-hidden="true">·</span>') +
        '<span class="sf-note">Single-user studio · charges go to your own OpenRouter key</span>';
      ft.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) S.openInfo(b.dataset.k); });
      wrap.append(ft);
    }
  }
  const qa = document.getElementById('sbQueue'), qt = document.getElementById('sbQueueTxt');
  const loadQueue = () => fetch('/api/queue').then((r) => r.json()).then((q) => {
    const run = (q.items || []).length, wait = q.waiting || 0;
    qa.hidden = !run && !wait && !q.active;
    qt.textContent = `${run || q.active} running · ${wait} waiting`;
    qa.title = (q.items || []).map((i) => `${i.kind}: ${i.title || i.id}`).join('\n') || 'Render queue';
  }).catch(() => {});
  loadQueue();
  setInterval(() => { if (!document.hidden) loadQueue(); }, 10000);
  addEventListener('spend-changed', loadQueue);

  const dot = document.getElementById('sbDot'), txt = document.getElementById('sbTxt');
  const ping = () =>
    fetch('/api/influencers')
      .then((r) => { if (!r.ok) throw 0; dot.className = 'dot ok'; txt.textContent = window.__eggNight ? 'NETRUNNER ONLINE' : 'SERVER ONLINE'; })
      .catch(() => { dot.className = 'dot bad'; txt.textContent = 'SERVER OFFLINE'; });
  ping();
  setInterval(ping, 15000);

  // Messages go to one quiet line under the page title (no pop-up notifications at the bottom of the screen)
  const status = document.createElement('p');
  status.className = 'page-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  (document.querySelector('.pagehead') || document.querySelector('.wrap') || document.body).append(status);
  let statusT = null;
  window.toast = (msg, type) => {
    status.textContent = msg;
    status.className = 'page-status' + (type === 'err' ? ' err' : '');
    clearTimeout(statusT);
    statusT = setTimeout(() => { status.textContent = ''; }, type === 'err' ? 12000 : 6000);
  };

  // ---------- Share: the video file itself (posts straight into TikTok / Instagram / WhatsApp / YouTube on a
  // phone) plus the caption; falls back to sharing a link, then to copying caption + link on desktops. ----------
  // The file is fetched ahead of time: iPhone Safari only opens the share sheet if share() runs right after the
  // tap, so there is no time to download the video once the button is pressed.
  const files = new Map(); // url -> Promise (while downloading) | File | null
  const canShareFiles = () => !!(navigator.share && navigator.canShare);
  const prep = (url, name, type = "video/mp4", max = 300 * 1048576) => {
    if (!canShareFiles() || !url || files.has(url)) return;
    const p = fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b && b.size && b.size < max ? new File([b], name, { type }) : null))
      .catch(() => null)
      .then((f) => { files.set(url, f); return f; });
    files.set(url, p);
  };
  const copy = (t) => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).catch(() => {});

  async function shareVideo({ url, name, title, text, thumb }) {
    const link = new URL(url, location.href).href;
    text = (text || "").trim();
    const f = files.get(url), t = thumb && files.get(thumb);
    if (f instanceof File && navigator.canShare({ files: [f] })) {
      if (text) copy(text); // some apps (Instagram, TikTok) drop shared text, so it's also on the clipboard to paste
      // the thumbnail rides along as a second file when the phone allows mixed files; apps that take only one
      // file (TikTok, Reels) still get the video
      const both = t instanceof File && navigator.canShare({ files: [f, t] }) ? [f, t] : [f];
      try {
        await navigator.share({ files: both, title: title || undefined, text: text || undefined });
        if (text) toast("Caption is copied too: paste it if the app didn't add it", "ok");
        return;
      } catch (e) { if (e.name === "AbortError") return; }
    } else if (f && typeof f.then === "function") {
      toast("Getting the video ready to share, tap Share again in a moment");
      return;
    }
    if (navigator.share) {
      try { await navigator.share({ title: title || undefined, text: text || undefined, url: link }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    await copy((text ? text + "\n\n" : "") + link);
    toast(text ? "Caption and video link copied" : "Video link copied", "ok");
  }

  // Adds a caption box (written by AI from the prompt unless `text` is given) and a Share button to `el`.
  // getText: read the caption from somewhere else instead (Shorts has its own title/description fields).
  // the server makes a thumbnail for any finished video: /api/video/<id>/thumb.jpg, /api/final/<id>/thumb.jpg
  const thumbFor = (url) => (/^\/api\/(video|final)\/[\w-]+$/.test(url.split("?")[0]) ? url.split("?")[0] + "/thumb.jpg" : null);
  window.mountShare = (el, { url, name = "video.mp4", title = "", prompt = "", text = "", getText, thumb } = {}) => {
    if (!el || !url) return;
    thumb = thumb || thumbFor(url);
    prep(url, name);
    prep(thumb, name.replace(/\.mp4$/i, "") + "-thumbnail.jpg", "image/jpeg", 20 * 1048576);
    const box = document.createElement("div");
    box.className = "sharebox";
    box.innerHTML = (getText ? "" : '<label>Caption<textarea class="share-cap" rows="3" placeholder="Caption for your post"></textarea></label>') +
      '<button class="btn primary share-go" type="button"><svg class=ic aria-hidden=true><use href=#i-share></use></svg> Share video</button>';
    el.append(box);
    const cap = box.querySelector(".share-cap");
    if (cap) {
      const key = "cap:" + url;
      let saved = null;
      try { saved = localStorage.getItem(key); } catch {}
      cap.value = text || saved || "";
      cap.oninput = () => { try { localStorage.setItem(key, cap.value); } catch {} };
      if (!cap.value && prompt) {
        cap.placeholder = "Writing a caption…";
        fetch("/api/caption", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) })
          .then((r) => r.json())
          .then((j) => { if (j.caption && !cap.value) { cap.value = j.caption; cap.oninput(); } })
          .catch(() => {})
          .finally(() => (cap.placeholder = "Caption for your post"));
      }
    }
    box.querySelector(".share-go").onclick = () => shareVideo({ url, name, title, thumb, text: getText ? getText() : cap.value });
  };
})();

// Hinglish mode: a hidden gesture. Tap More (the circle opens), then touch and hold the More button, which shows an X while the
// circle is open, for 2 seconds (the same on iPhone and Android). The same gesture turns the mode off again. There is no button for
// it anywhere. The screen says "Diving in. Location: South Asia" when it switches on and "Public server reinstated" when it
// switches off. See studio.js for what the mode does.
// While the button is held, nothing on the page can be selected (a phone starts a text selection on a long press and picks up
// the text near the finger): the lock goes on the moment the finger lands and comes off a moment after it lifts.
(function () {
  let timer = 0, sx = 0, sy = 0, holding = false, releaseT = 0, fired = false;
  const root = document.documentElement;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const release = () => { clearTimeout(releaseT); releaseT = setTimeout(() => { holding = false; root.classList.remove('hold-gesture'); }, 500); };
  function toggle(btn) {
    let on = false;
    try { on = localStorage.getItem('hinglish') !== '1'; localStorage.setItem('hinglish', on ? '1' : '0'); } catch { return; }
    fired = true;
    try { navigator.vibrate && navigator.vibrate(40); } catch {}
    // a short neon flash in the middle of the screen, then the page reloads in the new mode
    const orb = btn.querySelector('.tb-orb') || btn;
    orb.classList.add('eg-glitch'); setTimeout(() => orb.classList.remove('eg-glitch'), 500);
    const d = document.createElement('div');
    d.textContent = on ? 'DIVING IN. LOCATION: SOUTH ASIA' : 'PUBLIC SERVER REINSTATED';
    d.style.cssText = 'position:fixed;left:0;right:0;top:42%;z-index:2147483000;text-align:center;font:700 17px/1.5 var(--font-hud,Orbitron,sans-serif);letter-spacing:.14em;padding:0 22px;box-sizing:border-box;color:#00e5ff;text-shadow:0 0 12px #00e5ff,0 0 28px #ff2e93;pointer-events:none;animation:eg-glitch .5s steps(2) 2';
    document.body.appendChild(d);
    setTimeout(() => location.reload(), 1100);
  }
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('.tb-more');
    // only the More button while the circle is open (it shows an X then)
    if (!btn || e.button || !document.body.classList.contains('radial-open')) return;
    holding = true; clearTimeout(releaseT); root.classList.add('hold-gesture');
    try { getSelection().removeAllRanges(); } catch {}
    sx = e.clientX; sy = e.clientY; cancel();
    timer = setTimeout(() => { timer = 0; toggle(btn); }, 2000);
  }, true);
  // letting go or sliding the finger away cancels the hold (a finger that starts scrolling is cancelled by the browser itself)
  document.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 12) cancel(); }, true);
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { cancel(); if (holding) release(); }, true));
  // after a completed hold, the tap that follows the release must not also close the circle
  document.addEventListener('click', (e) => { if (fired && e.target.closest && e.target.closest('.tb-more')) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
  // if a selection still starts while the button is held, it is cleared at once
  document.addEventListener('selectionchange', () => { if (holding) { try { getSelection().removeAllRanges(); } catch {} } });
})();
