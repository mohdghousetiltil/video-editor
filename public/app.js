// Shared shell: sidebar (desktop), tab bar (mobile), page heading, server status, toasts.
(function () {
  const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    clip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 5 2.5-5 2.5z"/>'),
    story: svg('<rect x="2" y="6" width="9" height="12" rx="1.5"/><rect x="13" y="6" width="9" height="12" rx="1.5"/>'),
    ugc: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
    motion: svg('<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><circle cx="12" cy="12" r="3"/>'),
    shorts: svg('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    people: svg('<circle cx="9" cy="8" r="3"/><path d="M3 19c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.6c1.8.6 2.7 2 3 4.4"/>'),
  };
  const items = [
    ['/', 'Single clip', ICON.clip, 'One prompt, one video'],
    ['/story', 'Story mode', ICON.story, 'Scenes, narration, stitch'],
    ['/ugc', 'UGC review', ICON.ugc, 'Influencer reviews a product'],
    ['/motion', 'Poses & motion', ICON.motion, 'Poses for TikTok, copy motion'],
    ['/shorts', 'Shorts maker', ICON.shorts, 'Long video → ready-to-post Short'],
    ['/influencers', 'Influencers', ICON.people, 'Your AI influencer library'],
    ['/settings', 'Settings', ICON.gear, 'Models, Muse by Meta, spend cap'],
  ];
  // clean URLs (/shorts) and old ones (/shorts.html, /index.html) both count as the same page
  const here = location.pathname.replace(/\.html$/, '').replace(/^\/index$/, '/') || '/';

  const side = document.createElement('aside');
  side.className = 'sb';
  side.innerHTML =
    '<a class="sb-brand" href="/"><span class="sb-logo">'+ICON.clip+'</span><span>VIDEO<em>STUDIO</em></span></a>' +
    '<div class="sb-nav">' +
    items.map((i) => `<a href="${i[0]}" class="${i[0] === here ? 'on' : ''}"><span class="ic">${i[2]}</span><span class="tx"><b>${i[1]}</b><small>${i[3]}</small></span></a>`).join('') +
    '</div><div class="sb-foot"><span class="dot" id="sbDot"></span><span id="sbTxt">LINKING…</span></div>';
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
  const R = 112, n = more.length, span = Math.min(140, 64 * (n - 1));
  radial.innerHTML = '<span class="radial-ring" aria-hidden="true"></span>' + more.map((i, k) => {
    const a = (-90 - span / 2 + (n > 1 ? (span * k) / (n - 1) : span / 2)) * Math.PI / 180;
    return `<a role="menuitem" href="${i[0]}" class="${i[0] === here ? 'on' : ''}" style="--x:${(Math.cos(a) * R).toFixed(1)}px;--y:${(Math.sin(a) * R).toFixed(1)}px;--d:${k * 45}ms">` +
      `<span class="ro">${i[2]}</span><b>${i[1]}</b></a>`;
  }).join('');
  document.body.append(scrim, radial);

  const moreBtn = tabs.querySelector('.tb-more');
  const setOpen = (open, refocus) => {
    if (open) { // anchor the arc on the orb's centre
      const r = moreBtn.querySelector('.tb-orb').getBoundingClientRect();
      radial.style.left = r.left + r.width / 2 + 'px';
      radial.style.top = r.top + r.height / 2 + 'px';
    }
    document.body.classList.toggle('radial-open', open);
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => radial.querySelector('a')?.focus({ preventScroll: true }), 60);
    else if (refocus) moreBtn.focus();
  };
  const isOpen = () => document.body.classList.contains('radial-open');
  moreBtn.onclick = () => setOpen(!isOpen());
  scrim.onclick = () => setOpen(false);
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
    const or = j.openrouter, total = or && or.month != null ? or.month : j.local.total;
    sbSpend.querySelector('.spend-v').textContent = money(total, 2);
    chip.querySelector('b').textContent = money(total, 2);
    // the bar shows the monthly cap from Settings when there is one, else the API key's own limit
    const cap = j.cap > 0 ? j.cap : 0;
    const lim = cap || (or && or.keyLimit), used = cap ? total : lim ? lim - (or.keyRemaining ?? lim) : 0;
    const bar = sbSpend.querySelector('.spend-bar');
    bar.hidden = !lim;
    if (lim) { const p = Math.min(100, (used / lim) * 100); bar.firstChild.style.width = p + '%'; bar.classList.toggle('hot', p > 85); }
    sbSpend.querySelector('.spend-s').textContent = cap ? money(Math.max(0, cap - total), 2) + ' left of ' + money(cap, 0) + ' cap'
      : or && or.keyRemaining != null ? money(or.keyRemaining, 2) + ' left on key' : or && or.balance != null ? money(or.balance, 2) + ' credit left' : 'tap for details';
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
      `<div class="sd-head"><h2>AI spend · ${esc(monthName)}</h2><button class="btn sd-x" data-x aria-label="Close">✕</button></div>` +
      (j.months.length > 1 ? `<label class="sd-month">Month<select>${j.months.map((m) => `<option ${m === j.month ? 'selected' : ''}>${m}</option>`).join('')}</select></label>` : '') +
      (j.current && j.openrouter ? `<div class="sd-tiles">
        <div><span>This month</span><b>${money(or.month, 2)}</b></div>
        <div><span>This week</span><b>${money(or.week, 2)}</b></div>
        <div><span>Today</span><b>${money(or.day, 2)}</b></div>
        <div><span>Credit left</span><b>${money(or.balance, 2)}</b></div></div>` +
        (lim ? `<div class="sd-lim"><div class="sd-lim-t"><span>API key limit</span><span>${money(used, 2)} of ${money(lim, 2)} used · ${money(or.keyRemaining, 2)} left</span></div><div class="spend-bar${used / lim > .85 ? ' hot' : ''}"><i style="width:${Math.min(100, (used / lim) * 100)}%"></i></div></div>` : '') +
        `<p class="sd-note">Totals come straight from OpenRouter (calendar month, UTC) and include everything this API key spent.</p>` : '') +
      `<h3>Where it went <small>${money(L.total)} logged by this app</small></h3>` +
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
  //  · now and then a title, heading or button glitches for a split second
  //  · ↑ ↑ ↓ ↓ ← → ← → B A  → OVERDRIVE
  //  · click the logo 5 times fast → the nav gets hacked for a moment
  //  · type "glitch" anywhere outside a text box → the screen tears
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
        const pool = [...document.querySelectorAll('.pagehead h1, .sb-brand, .panel h2, .btn.primary, .spend-v')].filter((e) => e.offsetParent);
        glitch(pool[Math.floor(Math.random() * pool.length)]);
        if (Math.random() < .25) tear(2);
      }
      setTimeout(tick, 25000 + Math.random() * 45000);
    };
    setTimeout(tick, 9000 + Math.random() * 12000);
    // Konami code
    const KON = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let k = 0, typed = '';
    addEventListener('keydown', (e) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      k = key === KON[k] ? k + 1 : key === KON[0] ? 1 : 0;
      if (k === KON.length) {
        k = 0;
        document.body.classList.add('eg-overdrive'); tear(14);
        toast('⚡ OVERDRIVE ENGAGED // all limiters off (not really)', 'ok');
        setTimeout(() => document.body.classList.remove('eg-overdrive'), 2500);
      }
      if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable || key.length !== 1) return;
      typed = (typed + key).slice(-6);
      if (typed === 'glitch') { tear(9); glitch(document.querySelector('.pagehead h1')); typed = ''; }
    });
    // logo, 5 fast clicks: the nav labels scramble into hex and come back
    let clicks = [];
    side.querySelector('.sb-logo').addEventListener('click', (e) => {
      const now = Date.now(); clicks = clicks.filter((t) => now - t < 1500); clicks.push(now);
      if (clicks.length < 5) return;
      e.preventDefault(); clicks = [];
      const labels = [...side.querySelectorAll('.sb-nav .tx b')];
      const orig = labels.map((b) => b.textContent);
      const junk = () => Array.from({ length: 6 + Math.floor(Math.random() * 6) }, () => '0123456789ABCDEF#$%&ｱｲｳｴｵ'[Math.floor(Math.random() * 25)]).join('');
      let n = 0;
      const iv = setInterval(() => { labels.forEach((b) => { b.textContent = junk(); b.classList.add('eg-scramble'); }); if (++n > 12) { clearInterval(iv); labels.forEach((b, i) => { b.textContent = orig[i]; b.classList.remove('eg-scramble'); }); } }, 70);
      tear(6); toast('SIGNAL INTRUSION DETECTED // 0xDEADBEEF // just kidding', 'err');
    });
    // night owls
    const hr = new Date().getHours();
    if (hr < 4) window.__eggNight = true;
  })();

  const dot = document.getElementById('sbDot'), txt = document.getElementById('sbTxt');
  const ping = () =>
    fetch('/api/influencers')
      .then((r) => { if (!r.ok) throw 0; dot.className = 'dot ok'; txt.textContent = window.__eggNight ? 'NETRUNNER ONLINE' : 'SERVER ONLINE'; })
      .catch(() => { dot.className = 'dot bad'; txt.textContent = 'SERVER OFFLINE'; });
  ping();
  setInterval(ping, 15000);

  const box = document.createElement('div');
  box.id = 'toasts';
  document.body.append(box);
  window.toast = (msg, type) => {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    box.append(t);
    setTimeout(() => t.remove(), 4500);
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
      '<button class="btn primary share-go" type="button">⇪ Share video</button>';
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
