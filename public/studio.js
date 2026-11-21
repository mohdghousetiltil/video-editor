// Shared page helpers (loaded in <head>, before each page's own script): model table, total-cost lines, the
// "this costs money" confirmation, form memory, job progress (stage + elapsed time, no fake countdown), presets,
// templates and the Help / About / Privacy / Spend texts. Everything hangs off window.studio.
(function () {
  const S = (window.studio = {});
  const esc = (S.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const money = (S.money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : n > 0 && n < 0.005 ? '<$0.01' : '$' + Number(n).toFixed(d)));
  const ls = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  S.store = ls;

  // ---------- models (GET /api/models: live lengths, resolutions and prices per model) ----------
  let modelsP = null;
  S.models = () => (modelsP ||= fetch('/api/models').then((r) => r.json()).then((j) => {
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
  // rows: [[label, value], ...]; total: dollars. Resolves true (go) or false.
  S.confirmSpend = async ({ title = 'Start this generation?', rows = [], total = 0, note = '' } = {}) => {
    const st = await settings();
    const first = !ls.get('paidOk', false);
    if (!first && total > 0 && total < (+st.confirmUnder || 0)) return true;
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'spend-dlg confirm-dlg';
      d.setAttribute('aria-label', title);
      d.innerHTML = `<div class="sd-head"><h2>${esc(title)}</h2></div>` +
        `<dl class="cf-rows">${rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}` +
        `<dt>Estimated total</dt><dd class="cf-total">${money(total)}</dd></dl>` +
        (note ? `<p class="sd-note">${esc(note)}</p>` : '') +
        (first ? '<p class="cf-warn" role="alert"><b>Heads up:</b> this charges real money to your OpenRouter key. The monthly cap in Settings stops paid calls once it is reached.</p>' : '') +
        `<div class="cf-act"><button class="btn" data-no type="button">Cancel</button><button class="btn primary" data-yes type="button">Confirm · ${money(total)}</button></div>`;
      document.body.append(d);
      const done = (v) => { d.close(); d.remove(); if (v) ls.set('paidOk', true); resolve(v); };
      d.querySelector('[data-yes]').onclick = () => done(true);
      d.querySelector('[data-no]').onclick = () => done(false);
      d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      d.showModal();
      d.querySelector('[data-yes]').focus();
    });
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
  S.presetChips = (el, onPick) => {
    if (!el) return;
    el.innerHTML = Object.entries(S.PRESETS).map(([k, p]) => `<button type="button" class="chip preset" data-k="${k}">${esc(p.label)}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => (b.onclick = () => { el.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b)); onPick(S.PRESETS[b.dataset.k], b.dataset.k); }));
  };

  // ---------- templates: a starting point instead of a blank box ----------
  S.TEMPLATES = [
    { id: 'passport', name: 'Passport photo story', pages: ['story', 'clip'], prompt: 'A traveller rushes into a small photo studio the night before a flight, sits for a passport photo, blinks at the flash, gets the photo strip and laughs at it, then runs out to catch a taxi. Warm evening light, handheld feel.' },
    { id: 'unboxing', name: 'Product unboxing', pages: ['clip', 'ugc'], prompt: 'Close-up of hands opening a sleek matte box on a wooden desk, lifting the product out slowly, turning it in soft window light, then a satisfied smile at the camera. Clean, bright, smartphone-style footage.' },
    { id: 'poses', name: 'Influencer pose pack', pages: ['clip'], prompt: 'A confident creator in a sunny street does three quick poses for the camera: a hand-on-hip look over the shoulder, a laugh while fixing sunglasses, and a slow spin. Golden hour, shallow depth of field.' },
    { id: 'beforeafter', name: 'Before and after', pages: ['clip', 'story'], prompt: 'A messy cluttered room transforms into a clean bright minimalist space: the camera pushes in slowly as items disappear and the light warms up. One continuous shot, satisfying reveal at the end.' },
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
    help: ['Help', `<h3>How paying works</h3><p>This app uses your own <b>OpenRouter</b> account. OpenRouter is a service that gives one key access to many AI models (video, pictures, voices). Every time you make something, OpenRouter charges your credit for it. The app never charges you itself.</p>
      <h3>What the numbers mean</h3><ul><li><b>This month</b>: what your OpenRouter key spent this calendar month (UTC), straight from OpenRouter.</li><li><b>Credit left</b>: money still on your OpenRouter account.</li><li><b>Cap left</b>: how much more this app may spend this month before it refuses paid calls (Settings → monthly cap, $10 by default).</li><li><b>API key limit</b>: an optional limit you can set on the key itself at openrouter.ai. It is separate from the app's cap.</li><li><b>App log (estimate)</b>: what this app recorded, by feature. Voice costs there are estimates.</li></ul>
      <h3>Before anything is charged</h3><p>Every paid button shows the model, length, resolution and total first. Nothing is charged until you press Confirm.</p>
      <h3>Saving money</h3><ul><li>Draft on cheap models (marked Draft), keep Hero models for the one shot that matters.</li><li>720p looks the same as 1080p on a phone.</li><li>Short clips (2–4 s) stitched together drift less than one long clip.</li><li>Make a picture first, then animate it: pictures cost about 1–3 cents.</li></ul>`],
    about: ['About', '<p>Video Studio makes AI clips, stories, UGC reviews, poses and Shorts with your OpenRouter key. It runs on your own server; only you (behind the site password) can use it.</p><p>Fonts: Anton (SIL Open Font License). Video, picture and voice models are provided through OpenRouter and, if you add their keys, fal.ai and BytePlus.</p>'],
    privacy: ['Privacy', '<p>This is a single-user app. What it stores, and where:</p><ul><li><b>On your server</b> (DATA_DIR): your settings, influencer pictures, story drafts, the history list, the spend log and finished videos (deleted after the days set in Settings → Storage).</li><li><b>In this browser</b>: unsent form fields, the last model you picked and dismissed tips.</li><li><b>Sent to AI providers</b>: your prompts, pictures and videos you choose to use, only when you press Confirm.</li></ul><p>Nothing is shared with anyone else, and there are no trackers.</p>'],
    refunds: ['Spend & refunds', '<p>All charges are made by <b>OpenRouter</b> (or fal.ai / BytePlus if you added their keys) to your own account. This app cannot refund them.</p><ul><li>If a generation failed but you were charged, contact the provider\'s support with the job ID from History.</li><li>The monthly cap (Settings) stops this app from starting paid work once this month\'s spend reaches it.</li><li>For a hard limit, also set a spending limit on the key at openrouter.ai.</li></ul>'],
  };
  S.openInfo = (k) => {
    const [title, body] = S.INFO[k] || S.INFO.help;
    const d = document.createElement('dialog');
    d.className = 'spend-dlg info-dlg';
    d.setAttribute('aria-label', title);
    d.innerHTML = `<div class="sd-head"><h2>${title}</h2><button class="btn sd-x" data-x aria-label="Close">✕</button></div><div class="info-body">${body}</div>`;
    document.body.append(d);
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-x]')) { d.close(); d.remove(); } });
    d.addEventListener('close', () => d.remove());
    d.showModal();
  };
})();
