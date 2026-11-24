// Theme Lock UI (bar under each page title + the theme dialog) and the Enhance button. Loaded after studio.js.
// Pages listen for the "theme-changed" event (detail: { theme, picked }); picked = the user just chose it, so the page
// can switch to the theme's models, voice and caption style (on page load it only reflects the lock).
(function () {
  // The Look picker: a swipe carousel (Real, Disney, Pixar, Anime, Brain rot, None) and an optional character
  // description with Enhance. Both are saved on the server and go into every clip on every page.
  // Pages listen for "theme-changed" (detail: { theme, character, picked }).
  const S = window.studio, esc = S.esc;
  let state = { themes: [], active: null, character: '' };
  const active = () => state.themes.find((t) => t.id === state.active) || null;
  S.theme = () => active(); // the look being applied right now, or null
  S.character = () => state.character || '';
  S.themeState = () => state;
  const emit = (picked = false) => window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: S.theme(), character: S.character(), picked } }));
  S.loadThemes = () => fetch('/api/themes').then((r) => r.json()).then((j) => { state = { themes: j.themes || [], active: j.active, character: j.character || '' }; paint(); emit(); return state; }).catch(() => state);
  const save = (patch) => fetch('/api/themes/active', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    .then((r) => r.json()).then((j) => { const picked = 'id' in patch && j.active !== state.active; state.active = j.active; state.character = j.character || ''; paint(); emit(picked); });

  let bars = [], openChar = false;
  // host: the element the picker goes into (inline: true) or after (under a page title)
  S.mountThemeBar = (host, { inline = false } = {}) => {
    if (!host) return;
    const bar = document.createElement('div');
    bar.className = 'look-bar' + (inline ? ' inline' : '');
    inline ? host.append(bar) : host.after(bar);
    bars.push(bar);
    paint();
  };
  // The Look is a swipe carousel: swipe (or tap a card, or use the arrows) and the card that lands in the middle is the look.
  let quietUntil = 0; // ignore the scroll events our own re-centring makes
  const centreOf = (track) => {
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = null, bd = 1e9;
    track.querySelectorAll('.look-card').forEach((c) => { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = c; } });
    return best;
  };
  const centre = (track, card, smooth) => {
    if (!card) return;
    if (!smooth) quietUntil = Date.now() + 350;
    track.scrollTo({ left: card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'instant' });
  };
  const markNear = (track, c) => track.querySelectorAll('.look-card').forEach((x) => x.classList.toggle('near', x === c));
  // each look is a neon icon in its own colour
  const NEON = { real: '#00e5ff', disney: '#ffd84d', pixar: '#ff8a3d', anime: '#ff7ad9', brainrot: '#c6ff00', gametrailer: '#4da3ff', horror: '#ff3b4a', fantasy: '#7dffb0', retro35: '#ffb86b', painterly: '#ff9ecb', luxury: '#e6d6a3', docu: '#9ad0ff', securitycam: '#7fff7f', estate: '#6fe3d1', toon3d: '#ffe066', indie: '#d9b38c', action: '#ff7a3d', inkpaint: '#b3a8ff', epicfilm: '#f5f5f5', none: '#8a92a6' };
  function buildTrack(bar) {
    const opts = [...state.themes.map((x) => [x.id, x.name, x.icon]), [null, 'None', 'x']];
    const wrap = bar.querySelector('.look-swipe');
    wrap.innerHTML = `<button type="button" class="look-arrow prev" aria-label="Previous look">${ic('chevron')}</button>
      <div class="look-track" role="radiogroup" aria-label="Look">${opts.map(([id, l, i]) => `<button type="button" class="look-card" role="radio" data-look="${id || ''}" style="--n:${NEON[id] || NEON.none}"><span class="lc-ic">${ic(i)}</span><b>${esc(l)}</b></button>`).join('')}</div>
      <button type="button" class="look-arrow next" aria-label="Next look">${ic('chevron')}</button>`;
    const track = wrap.querySelector('.look-track');
    const pick = (card) => { const id = card.dataset.look || null; if (id !== (state.active || null)) save({ id }); };
    track.onclick = (e) => { const c = e.target.closest('.look-card'); if (!c) return; quietUntil = Date.now() + 700; centre(track, c, true); markNear(track, c); pick(c); };
    let tm;
    track.addEventListener('scroll', () => {
      markNear(track, centreOf(track));
      clearTimeout(tm);
      tm = setTimeout(() => { const c = centreOf(track); if (c && Date.now() > quietUntil) pick(c); }, 170);
    }, { passive: true });
    const step = (d) => { const cards = [...track.querySelectorAll('.look-card')], k = cards.indexOf(centreOf(track)); centre(track, cards[Math.max(0, Math.min(cards.length - 1, k + d))], true); };
    wrap.querySelector('.prev').onclick = () => step(-1);
    wrap.querySelector('.next').onclick = () => step(1);
    track.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); } });
    bar.dataset.n = opts.length;
  }
  function paint() {
    const t = active();
    for (const bar of bars) {
      if (!bar.querySelector('.look-swipe')) bar.innerHTML = '<div class="look-swipe"></div><div class="look-char-wrap"></div>';
      if (state.themes.length && +bar.dataset.n !== state.themes.length + 1) buildTrack(bar);
      const track = bar.querySelector('.look-track');
      if (track) {
        let sel = null;
        track.querySelectorAll('.look-card').forEach((c) => { const on = (c.dataset.look || null) === (t ? t.id : null); c.classList.toggle('sel', on); c.setAttribute('aria-checked', on); c.tabIndex = on ? 0 : -1; if (on) sel = c; });
        // bring the chosen look to the middle (instantly, so it doesn't count as a swipe) unless the user is mid-swipe
        if (sel && Date.now() > quietUntil) requestAnimationFrame(() => { centre(track, sel, false); markNear(track, sel); });
      }
      // don't wipe the character box while someone is typing in it
      const cw = bar.querySelector('.look-char-wrap');
      if (cw.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') continue;
      const ch = state.character;
      cw.innerHTML = `<button type="button" class="look-char-btn" aria-expanded="${openChar}"><svg class=ic aria-hidden=true><use href=#i-user></use></svg> Character${ch ? ': <b>' + esc(ch.slice(0, 48)) + (ch.length > 48 ? '…' : '') + '</b>' : ' <span class="meta">(optional)</span>'}</button>
        <div class="look-char"${openChar ? '' : ' hidden'}>
          <textarea maxlength="1500" placeholder="Who is the main character? e.g. a shy 10-year-old girl with curly red hair and a yellow raincoat. Press Enhance to make it exact.">${esc(ch)}</textarea>
          <div class="tools"><button type="button" class="btn" data-enh><svg class=ic aria-hidden=true><use href=#i-sparkles></use></svg> Enhance character</button><button type="button" class="btn" data-clear${ch ? '' : ' hidden'}>Clear</button><span class="meta" data-st aria-live="polite">${ch ? 'Added to every clip, word for word.' : 'Leave empty for no fixed character.'}</span></div>
        </div>`;
      const bar2 = cw;
      bar2.querySelector('.look-char-btn').onclick = () => { openChar = !openChar; paint(); if (openChar) bar2.querySelector('textarea').focus(); };
      const ta = bar2.querySelector('textarea'), st = bar2.querySelector('[data-st]');
      ta.onblur = () => { if (ta.value.trim() !== state.character) save({ character: ta.value }); };
      bar2.querySelector('[data-clear]').onclick = () => save({ character: '' });
      bar2.querySelector('[data-enh]').onclick = async (e) => {
        const b = e.currentTarget;
        if (!ta.value.trim()) { st.textContent = 'Write a rough idea of the character first.'; return ta.focus(); }
        b.disabled = true; b.textContent = 'Enhancing…';
        try {
          const r = await fetch('/api/enhance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'character', prompt: ta.value }) });
          const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Enhance failed');
          await save({ character: j.prompt });
          window.dispatchEvent(new Event('spend-changed'));
        } catch (err) { st.innerHTML = '<svg class=ic aria-hidden=true><use href=#i-circle-x></use></svg> ' + escH(err.message); b.disabled = false; b.innerHTML = '<svg class=ic aria-hidden=true><use href=#i-sparkles></use></svg> Enhance character'; }
      };
    }
  }

  // ---------- Enhance: free upscale / sharpen / denoise / smooth on the server ----------
  // auto: { upscale, smooth } starts it straight away (the Director planned it)
  S.mountEnhance = (el, { src, auto } = {}) => {
    if (!el || !src) return;
    if (auto) setTimeout(() => {
      box.querySelector('details').open = true;
      $o('upscale').value = auto.upscale || '720p'; $o('smooth').checked = !!auto.smooth;
      box.querySelector('[data-go]').click();
    });
    const box = document.createElement('div');
    box.className = 'enh';
    box.innerHTML = `<details><summary><svg class=ic aria-hidden=true><use href=#i-sparkles></use></svg> Enhance (free, on your server)</summary>
      <div class="enh-opts"><label>Upscale<select data-o="upscale"><option value="720p">to 720p</option><option value="1080p">to 1080p</option><option value="none">keep size</option></select></label>
      <label>Colour grade<select data-o="grade"><option value="none">none</option><option value="cinematic">Cinematic</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="vivid">Vivid</option><option value="retro">Retro film</option><option value="bw">Black and white</option></select></label>
      <label class="ck"><input type="checkbox" data-o="sharpen" checked> Sharpen</label><label class="ck"><input type="checkbox" data-o="denoise" checked> Denoise</label>
      <label class="ck"><input type="checkbox" data-o="smooth"> Smooth motion <small>(fills slowed or choppy frames; slower to render)</small></label>
      <button class="btn" type="button" data-go>Enhance</button></div><div class="meta" data-st aria-live="polite"></div><div data-out></div></details>
      <details class="addmus"><summary><svg class=ic aria-hidden=true><use href=#i-music></use></svg> Add background music (free, no copyright)</summary>
      <div class="enh-opts"><label>Music<select data-m><option value="cinematic">Cinematic</option><option value="suspense">Suspense</option><option value="epic">Epic</option><option value="upbeat">Upbeat</option><option value="chill">Chill</option><option value="funny">Funny</option></select></label>
      <button class="btn" type="button" data-mgo>Add music</button></div><div class="meta" data-mst aria-live="polite">Made on your server. It dips under any voices in the clip.</div><div data-mout></div></details>`;
    el.append(box);
    const $o = (k) => box.querySelector(`[data-o="${k}"]`);
    // starts a job on the server and shows the result video under it
    const runJob = async (body, b, st, out, label) => {
      b.disabled = true; st.textContent = 'Starting…';
      const r = await fetch('/api/enhance-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src, ...body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { st.innerHTML = '<svg class=ic aria-hidden=true><use href=#i-circle-x></use></svg> ' + escH(j.error || 'Failed'); b.disabled = false; return; }
      const t0 = Date.now();
      const tick = async () => {
        const d = await fetch('/api/enhance-video/' + j.id).then((x) => x.json()).catch(() => null);
        if (!d) return setTimeout(tick, 3000);
        if (d.status === 'running') { st.textContent = d.step + ' · ' + Math.round((Date.now() - t0) / 1000) + ' s'; return setTimeout(tick, 2000); }
        b.disabled = false;
        if (d.status === 'failed') { st.innerHTML = '<svg class=ic aria-hidden=true><use href=#i-circle-x></use></svg> ' + escH(d.error); return; }
        st.textContent = body.musicOnly ? 'Done. No AI cost.' : `Done: ${d.from} → ${d.to}. No AI cost.`;
        out.innerHTML = `<video src="${d.url}" controls playsinline loop style="width:100%;max-height:60vh;margin-top:8px"></video><a class="btn" href="${d.url}?download=1"><svg class=ic aria-hidden=true><use href=#i-download></use></svg> ${label}</a>`;
      };
      tick();
    };
    box.querySelector('[data-go]').onclick = () => runJob({ upscale: $o('upscale').value, sharpen: $o('sharpen').checked, denoise: $o('denoise').checked, smooth: $o('smooth').checked, grade: $o('grade').value },
      box.querySelector('[data-go]'), box.querySelector('[data-st]'), box.querySelector('[data-out]'), 'Download enhanced MP4');
    box.querySelector('[data-mgo]').onclick = () => runJob({ music: box.querySelector('[data-m]').value, musicOnly: true },
      box.querySelector('[data-mgo]'), box.querySelector('[data-mst]'), box.querySelector('[data-mout]'), 'Download with music');
  };
})();
