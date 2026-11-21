// Theme Lock UI (bar under each page title + the theme dialog) and the Enhance button. Loaded after studio.js.
// Pages listen for the "theme-changed" event (detail: { theme, picked }); picked = the user just chose it, so the page
// can switch to the theme's models, voice and caption style (on page load it only reflects the lock).
(function () {
  const S = window.studio, esc = S.esc;
  let state = { themes: [], active: null, lock: false };
  const active = () => state.themes.find((t) => t.id === state.active) || null;
  S.theme = () => (state.lock ? active() : null); // the theme being applied right now, or null
  S.themeState = () => state;
  const emit = (picked = false) => window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: S.theme(), picked } }));
  S.loadThemes = () => fetch('/api/themes').then((r) => r.json()).then((j) => { state = { themes: j.themes || [], active: j.active, lock: !!j.lock }; paintBar(); emit(); return state; }).catch(() => state);
  const setActive = (id, lock) => fetch('/api/themes/active', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, lock }) })
    .then((r) => r.json()).then((j) => { const changed = j.active !== state.active || (j.lock && !state.lock); state.active = j.active; state.lock = j.lock; paintBar(); emit(changed); });
  const swatch = (t) => `linear-gradient(90deg,${(t.swatch && t.swatch.length ? t.swatch : ['#444', '#888']).join(',')})`;

  // ---------- the bar under the page title ----------
  let bar = null;
  S.mountThemeBar = (host) => {
    if (!host) return;
    bar = document.createElement('div');
    bar.className = 'theme-bar';
    host.after(bar);
    paintBar();
  };
  function paintBar() {
    if (!bar) return;
    const t = active();
    bar.innerHTML = `<button type="button" class="theme-chip" aria-label="Theme settings"><span class="tsw" style="background:${t ? swatch(t) : 'var(--line2)'}"></span>🎨 Theme: <b>${t ? esc(t.emoji || '') + ' ' + esc(t.name) : 'none'}</b></button>` +
      `<label class="theme-lock"><input type="checkbox" ${state.lock ? 'checked' : ''} ${t ? '' : 'disabled'}> 🔒 Theme Lock</label>` +
      (state.lock ? `<span class="meta">Style, palette, lighting, camera${t && (t.character || t.influencerId) ? ', character' : ''}${t && t.outfit ? ', outfit' : ''}${t && t.styleImage ? ' and style picture' : ''} go into every clip.</span>`
        : `<span class="theme-warn">${t ? 'Theme Lock is off: each clip can drift to a different look.' : 'No theme: each clip can look different. Pick one to keep a series consistent.'}</span>`);
    bar.querySelector('.theme-chip').onclick = openDialog;
    bar.querySelector('input').onchange = (e) => setActive(state.active, e.target.checked);
  }

  // ---------- the theme dialog: presets, your themes, editor ----------
  let dlg = null, editing = null, models = {}, infs = [], voices = [];
  async function openDialog() {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'spend-dlg theme-dlg';
      dlg.setAttribute('aria-label', 'Themes');
      document.body.append(dlg);
      dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-x]')) dlg.close(); });
      models = (await S.models()).map;
      infs = await fetch('/api/influencers').then((r) => r.json()).then((j) => j.influencers || []).catch(() => []);
      voices = await fetch('/api/shorts/voices').then((r) => r.json()).then((j) => j.voices || []).catch(() => []);
    }
    editing = null;
    render();
    if (!dlg.open) dlg.showModal();
  }
  function render() {
    const t = active();
    dlg.innerHTML = `<div class="sd-head"><h2>Theme</h2><button class="btn sd-x" data-x type="button" aria-label="Close">✕</button></div>
      <label class="theme-lock big"><input type="checkbox" id="tdLock" ${state.lock ? 'checked' : ''} ${t ? '' : 'disabled'}> 🔒 <b>Theme Lock</b>: add this theme to every clip on every page</label>
      ${state.lock ? '' : '<p class="theme-warn">Off: clips use only what you type, so a series can drift (different faces, colours, lighting).</p>'}
      <div class="theme-grid">${state.themes.map((x) => `<div class="tcard${x.id === state.active ? ' on' : ''}" data-id="${esc(x.id)}">
        <div class="tex" style="${x.example ? `background-image:url('${esc(x.example)}')` : `background:${swatch(x)}`}">${x.example ? '' : `<span>${esc(x.emoji || '🎨')}</span>`}</div>
        <div class="tsw" style="background:${swatch(x)}"></div>
        <b>${esc(x.emoji || '')} ${esc(x.name)}</b><small>${x.builtin ? 'Preset' : 'Yours'}${x.styleImage ? ' · style picture' : ''}</small>
        <div class="tact"><button class="btn" data-use type="button">${x.id === state.active ? '✓ In use' : 'Use'}</button><button class="btn" data-edit type="button">${x.builtin ? 'Customise' : 'Edit'}</button>${x.example ? '' : '<button class="btn" data-ex type="button" title="One picture, about a cent">Example</button>'}</div></div>`).join('')}</div>
      <div id="tdEdit"></div>`;
    dlg.querySelector('#tdLock').onchange = (e) => setActive(state.active, e.target.checked).then(render);
    dlg.querySelectorAll('.tcard').forEach((c) => {
      const x = state.themes.find((y) => y.id === c.dataset.id);
      c.querySelector('[data-use]').onclick = () => setActive(x.id, true).then(() => { render(); toast(`${x.name} is on and locked`, 'ok'); });
      c.querySelector('[data-edit]').onclick = () => { editing = { ...x }; renderEditor(); };
      const ex = c.querySelector('[data-ex]');
      if (ex) ex.onclick = async () => {
        if (!(await S.confirmSpend({ title: `Example picture for ${x.name}?`, total: 0.01, rows: [['What', 'One 9:16 picture in this theme'], ['Why', 'See the look before paying for video']] }))) return;
        ex.disabled = true; ex.textContent = 'Drawing…';
        const r = await fetch(`/api/themes/${x.id}/example`, { method: 'POST' }); const j = await r.json().catch(() => ({}));
        if (!r.ok) { toast(j.error || 'Failed', 'err'); ex.disabled = false; ex.textContent = 'Example'; return; }
        await S.loadThemes(); render(); window.dispatchEvent(new Event('spend-changed'));
      };
    });
  }
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
  function renderEditor() {
    const e = editing, box = dlg.querySelector('#tdEdit'), m = e.models || {};
    const vids = Object.values(models).map((x) => [x.id, `${x.name} (${S.tierLabel(x.tier)})`]);
    box.innerHTML = `<h3>${e.builtin ? 'Customise ' + esc(e.name) + ' (saved as your copy)' : 'Edit ' + esc(e.name)}</h3>
      <div class="tform">
        <label>Name<input data-k="name" value="${esc(e.builtin ? e.name + ' (mine)' : e.name)}"></label>
        <label>Style<textarea data-k="style">${esc(e.style || '')}</textarea></label>
        <label>Colour palette<input data-k="palette" value="${esc(e.palette || '')}" placeholder="warm gold, sunset orange, black and white"></label>
        <label>Lighting<input data-k="lighting" value="${esc(e.lighting || '')}" placeholder="soft cinematic, golden hour"></label>
        <label>Camera<input data-k="camera" value="${esc(e.camera || '')}" placeholder="close-ups, 9:16"></label>
        <label>Character (saved influencer)<select data-k="influencerId"><option value="">None: use the text below</option>${opt(infs.map((p) => [p.id, p.name]), e.influencerId)}</select></label>
        <label>Character description, used word for word<textarea data-k="character" placeholder="A cheerful traveller in her 20s with short curly black hair…">${esc(e.character || '')}</textarea></label>
        <label>Outfit, same in every shot<input data-k="outfit" value="${esc(e.outfit || '')}" placeholder="mustard raincoat, white sneakers"></label>
        <label>Never show (negative prompt)<input data-k="negative" value="${esc(e.negative || '')}" placeholder="logos, text on screen, extra people"></label>
        <label>Cheap model (B-roll, simple motion)<select data-m="cheap">${opt(vids, m.cheap)}</select></label>
        <label>Quality model (faces, close-ups)<select data-m="good">${opt(vids, m.good)}</select></label>
        <label>Resolution<select data-m="res">${opt([['480p', '480p'], ['720p', '720p (Reels, Shorts)'], ['1080p', '1080p (hero YouTube)']], m.res || '720p')}</select></label>
        <label>Narrator voice<select data-k="voice">${opt(voices.map((v) => [v.voice, v.label]), e.voice)}</select></label>
        <label>Caption style<select data-k="capStyle">${opt([['bold', 'Bold: white, black outline'], ['box', 'Box: white on black'], ['minimal', 'Minimal']], e.capStyle)}</select></label>
        <label>Music mood<select data-k="music">${opt([['none', 'None'], ['pad', 'Soft ambient pad']], e.music)}</select></label>
      </div>
      <div class="tstyle"><div class="tsimg" style="${e.styleImage ? `background-image:url('${esc(e.styleImage)}')` : ''}">${e.styleImage ? '' : 'No style picture'}</div>
        <div><b>Style reference picture</b><p class="meta">One picture that defines the look, e.g. a frame from a video you liked. It guides every new clip's style and colours (not its content). Use AI-made pictures: photos of real people are blocked by the video models.</p>
        <label class="btn" style="display:inline-block">⬆ Choose picture<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-up></label> ${e.styleImage || e._img ? '<button class="btn" type="button" data-rm>Remove</button>' : ''}</div></div>
      <div class="cf-act">${!e.builtin && e.id ? '<button class="btn danger" type="button" data-del>Delete</button>' : ''}<button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-save>Save &amp; use (locked)</button></div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.querySelector('[data-up]').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      if (f.size > 10 * 1048576) return toast('Picture is over 10 MB', 'err');
      e._img = await shrink(f, 1024); e.styleImage = e._img; e._rm = false; renderEditor();
    };
    const rm = box.querySelector('[data-rm]'); if (rm) rm.onclick = () => { e._img = null; e.styleImage = null; e._rm = true; renderEditor(); };
    box.querySelector('[data-cancel]').onclick = () => { editing = null; box.innerHTML = ''; };
    const del = box.querySelector('[data-del]');
    if (del) del.onclick = async () => { if (!confirm(`Delete the theme "${e.name}"? This can't be undone.`)) return; await fetch('/api/themes/' + e.id, { method: 'DELETE' }); await S.loadThemes(); render(); };
    box.querySelector('[data-save]').onclick = async () => {
      const body = { id: e.id, models: {} };
      box.querySelectorAll('[data-k]').forEach((el) => (body[el.dataset.k] = el.value));
      box.querySelectorAll('[data-m]').forEach((el) => (body.models[el.dataset.m] = el.value));
      if (e._img) body.styleImage = e._img;
      if (e._rm) body.removeStyleImage = true;
      const r = await fetch('/api/themes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) return toast(j.error || 'Save failed', 'err');
      await S.loadThemes(); await setActive(j.id, true); editing = null; render(); toast(`${j.name} saved, in use and locked`, 'ok');
    };
  }
  function shrink(file, max) {
    return new Promise((res, rej) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c.toDataURL('image/jpeg', 0.9)); }; im.onerror = () => rej(new Error('Could not read that picture')); im.src = u; });
  }
  S.openThemes = openDialog;

  // ---------- Enhance: free upscale / sharpen / denoise / smooth on the server ----------
  S.mountEnhance = (el, { src } = {}) => {
    if (!el || !src) return;
    const box = document.createElement('div');
    box.className = 'enh';
    box.innerHTML = `<details><summary>✨ Enhance (free, on your server)</summary>
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
      if (!r.ok) { st.textContent = '❌ ' + (j.error || 'Failed'); b.disabled = false; return; }
      const t0 = Date.now();
      const tick = async () => {
        const d = await fetch('/api/enhance-video/' + j.id).then((x) => x.json()).catch(() => null);
        if (!d) return setTimeout(tick, 3000);
        if (d.status === 'running') { st.textContent = d.step + ' · ' + Math.round((Date.now() - t0) / 1000) + ' s'; return setTimeout(tick, 2000); }
        b.disabled = false;
        if (d.status === 'failed') { st.textContent = '❌ ' + d.error; return; }
        st.textContent = `Done: ${d.from} → ${d.to}. No AI cost.`;
        box.querySelector('[data-out]').innerHTML = `<video src="${d.url}" controls playsinline loop style="width:100%;max-height:60vh;margin-top:8px"></video><a class="btn" href="${d.url}?download=1">⬇ Download enhanced MP4</a>`;
      };
      tick();
    };
  };
})();
