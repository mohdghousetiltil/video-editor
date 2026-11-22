// Theme Lock UI (bar under each page title + the theme dialog) and the Enhance button. Loaded after studio.js.
// Pages listen for the "theme-changed" event (detail: { theme, picked }); picked = the user just chose it, so the page
// can switch to the theme's models, voice and caption style (on page load it only reflects the lock).
(function () {
  // The Look picker: one row of chips (Real, Disney, Pixar, Anime, Brain rot, None) and an optional character
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
  function paint() {
    const t = active();
    for (const bar of bars) {
      // don't wipe the character box while someone is typing in it
      if (bar.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') continue;
      const chips = [...state.themes.map((x) => [x.id, x.name, x.icon]), [null, 'None', 'x']]
        .map(([id, l, i]) => `<button type="button" class="chip${(t ? t.id : null) === id ? ' sel' : ''}" data-look="${id || ''}" aria-pressed="${(t ? t.id : null) === id}">${window.ic ? ic(i) + ' ' : ''}${esc(l)}</button>`).join('');
      const ch = state.character;
      bar.innerHTML = `<div class="look-row">${bar.classList.contains('inline') ? '' : '<span class="look-lbl">Look</span>'}<div class="chips">${chips}</div></div>
        <button type="button" class="look-char-btn" aria-expanded="${openChar}"><svg class=ic aria-hidden=true><use href=#i-user></use></svg> Character${ch ? ': <b>' + esc(ch.slice(0, 48)) + (ch.length > 48 ? '…' : '') + '</b>' : ' <span class="meta">(optional)</span>'}</button>
        <div class="look-char"${openChar ? '' : ' hidden'}>
          <textarea maxlength="1500" placeholder="Who is the main character? e.g. a shy 10-year-old girl with curly red hair and a yellow raincoat. Press Enhance to make it exact.">${esc(ch)}</textarea>
          <div class="tools"><button type="button" class="btn" data-enh><svg class=ic aria-hidden=true><use href=#i-sparkles></use></svg> Enhance character</button><button type="button" class="btn" data-clear${ch ? '' : ' hidden'}>Clear</button><span class="meta" data-st aria-live="polite">${ch ? 'Added to every clip, word for word.' : 'Leave empty for no fixed character.'}</span></div>
        </div>`;
      bar.querySelectorAll('[data-look]').forEach((b) => (b.onclick = () => save({ id: b.dataset.look || null })));
      bar.querySelector('.look-char-btn').onclick = () => { openChar = !openChar; paint(); if (openChar) bar.querySelector('textarea').focus(); };
      const ta = bar.querySelector('textarea'), st = bar.querySelector('[data-st]');
      ta.onblur = () => { if (ta.value.trim() !== state.character) save({ character: ta.value }); };
      bar.querySelector('[data-clear]').onclick = () => save({ character: '' });
      bar.querySelector('[data-enh]').onclick = async (e) => {
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
      <label class="ck"><input type="checkbox" data-o="sharpen" checked> Sharpen</label><label class="ck"><input type="checkbox" data-o="denoise" checked> Denoise</label>
      <label class="ck"><input type="checkbox" data-o="smooth"> Smooth motion <small>(fills slowed or choppy frames; slower to render)</small></label>
      <button class="btn" type="button" data-go>Enhance</button></div><div class="meta" data-st aria-live="polite"></div><div data-out></div></details>`;
    el.append(box);
    const $o = (k) => box.querySelector(`[data-o="${k}"]`);
    box.querySelector('[data-go]').onclick = async () => {
      const b = box.querySelector('[data-go]'); b.disabled = true;
      const st = box.querySelector('[data-st]'); st.textContent = 'Starting…';
      const r = await fetch('/api/enhance-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src, upscale: $o('upscale').value, sharpen: $o('sharpen').checked, denoise: $o('denoise').checked, smooth: $o('smooth').checked }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { st.innerHTML = '<svg class=ic aria-hidden=true><use href=#i-circle-x></use></svg> ' + escH(j.error || 'Failed'); b.disabled = false; return; }
      const t0 = Date.now();
      const tick = async () => {
        const d = await fetch('/api/enhance-video/' + j.id).then((x) => x.json()).catch(() => null);
        if (!d) return setTimeout(tick, 3000);
        if (d.status === 'running') { st.textContent = d.step + ' · ' + Math.round((Date.now() - t0) / 1000) + ' s'; return setTimeout(tick, 2000); }
        b.disabled = false;
        if (d.status === 'failed') { st.innerHTML = '<svg class=ic aria-hidden=true><use href=#i-circle-x></use></svg> ' + escH(d.error); return; }
        st.textContent = `Done: ${d.from} → ${d.to}. No AI cost.`;
        box.querySelector('[data-out]').innerHTML = `<video src="${d.url}" controls playsinline loop style="width:100%;max-height:60vh;margin-top:8px"></video><a class="btn" href="${d.url}?download=1"><svg class=ic aria-hidden=true><use href=#i-download></use></svg> Download enhanced MP4</a>`;
      };
      tick();
    };
  };
})();
