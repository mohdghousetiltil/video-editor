// Shared shell: sidebar (desktop), tab bar (mobile), page heading, server status, toasts.
(function () {
  const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    clip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 5 2.5-5 2.5z"/>'),
    story: svg('<rect x="2" y="6" width="9" height="12" rx="1.5"/><rect x="13" y="6" width="9" height="12" rx="1.5"/>'),
    ugc: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
    motion: svg('<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><circle cx="12" cy="12" r="3"/>'),
    people: svg('<circle cx="9" cy="8" r="3"/><path d="M3 19c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.6c1.8.6 2.7 2 3 4.4"/>'),
  };
  const items = [
    ['/', 'Single clip', ICON.clip, 'One prompt, one video'],
    ['/story.html', 'Story mode', ICON.story, 'Scenes, narration, stitch'],
    ['/ugc.html', 'UGC review', ICON.ugc, 'Influencer reviews a product'],
    ['/motion.html', 'Poses & motion', ICON.motion, 'Poses for TikTok, copy motion'],
    ['/influencers.html', 'Influencers', ICON.people, 'Your AI influencer library'],
  ];
  const here = location.pathname === '/index.html' ? '/' : location.pathname;

  const side = document.createElement('aside');
  side.className = 'sb';
  side.innerHTML =
    '<a class="sb-brand" href="/"><span class="sb-logo">'+ICON.clip+'</span><span>VIDEO<em>STUDIO</em></span></a>' +
    '<div class="sb-nav">' +
    items.map((i) => `<a href="${i[0]}" class="${i[0] === here ? 'on' : ''}"><span class="ic">${i[2]}</span><span class="tx"><b>${i[1]}</b><small>${i[3]}</small></span></a>`).join('') +
    '</div><div class="sb-foot"><span class="dot" id="sbDot"></span><span id="sbTxt">LINKING…</span></div>';
  document.body.prepend(side);

  const tabs = document.createElement('div');
  tabs.className = 'tabbar';
  tabs.innerHTML = items.map((i) => `<a href="${i[0]}" class="${i[0] === here ? 'on' : ''}"><span>${i[2]}</span>${i[1].split(' ')[0]}</a>`).join('');
  document.body.append(tabs);

  const wrap = document.querySelector('.wrap');
  const title = document.body.dataset.title;
  if (wrap && title) {
    const h = document.createElement('div');
    h.className = 'pagehead';
    h.innerHTML = `<h1>${title}</h1><p>${document.body.dataset.sub || ''}</p>`;
    wrap.prepend(h);
  }

  const dot = document.getElementById('sbDot'), txt = document.getElementById('sbTxt');
  const ping = () =>
    fetch('/api/influencers')
      .then((r) => { if (!r.ok) throw 0; dot.className = 'dot ok'; txt.textContent = 'SERVER ONLINE'; })
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
})();
