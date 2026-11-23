// Radio player: live streams to listen to while you work (Nightride FM synthwave, Nightwave Plaza vaporwave,
// Radio Paradise, SomaFM), played straight from the stations (nothing is stored or re-streamed here).
//
// Two halves:
//  · the ENGINE (the audio, the station, play / pause, skipping dead stations) lives in /shell, the one page that
//    never reloads, so the music keeps playing when you change tabs;
//  · the CONTROLS are built by every page: on a phone the middle of the More menu is the Play / Pause button and a tap
//    on the left or right of the screen (outside the dial, see app.js) changes station while music plays; on a desktop
//    the sidebar has the buttons. The middle More button pulses while it plays.
// A page opened on its own (?noshell) gets its own engine, which stops when the page is left.
(function () {
  if (window.studioRadio) return; // (not "music": the Shorts page has an element with that id, which browsers expose as window.music)
  let shellRadio = null;
  try { shellRadio = window.parent !== window ? window.parent.__radio : null; } catch {}
  const isShell = !!(document.body && document.body.hasAttribute('data-shell'));
  const radio = shellRadio || createEngine();
  if (isShell) { window.__radio = radio; return; } // the shell has no controls of its own
  buildControls(radio);

  // =============================== the engine ===============================
  function createEngine() {
    const STATIONS = [
      { name: 'Nightride FM', tag: 'Synthwave', url: 'https://stream.nightride.fm/nightride.mp3' },
      { name: 'Chillsynth FM', tag: 'Chill synth', url: 'https://stream.nightride.fm/chillsynth.mp3' },
      { name: 'Datawave FM', tag: 'Glitchy electro', url: 'https://stream.nightride.fm/datawave.mp3' },
      { name: 'Darksynth FM', tag: 'Dark and driving', url: 'https://stream.nightride.fm/darksynth.mp3' },
      { name: 'Spacesynth FM', tag: 'Space synth', url: 'https://stream.nightride.fm/spacesynth.mp3' },
      { name: 'Nightwave Plaza', tag: 'Vaporwave', url: 'https://radio.plaza.one/mp3' },
      { name: 'Radio Paradise', tag: 'Mellow mix', url: 'https://stream.radioparadise.com/mellow-128' },
      { name: 'Radio Paradise', tag: 'Main mix', url: 'https://stream.radioparadise.com/mp3-128' },
      { name: 'SomaFM Groove Salad', tag: 'Chilled beats', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
      { name: 'SomaFM Drone Zone', tag: 'Deep ambient', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
      { name: 'SomaFM DEF CON', tag: 'Hacker music', url: 'https://ice1.somafm.com/defcon-128-mp3' },
    ];
    const N = STATIONS.length, KEY = 'musicState';
    const ls = {
      get: () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } },
      set: (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} },
    };
    const st = Object.assign({ i: 0, on: false }, ls.get());
    if (!(st.i >= 0 && st.i < N)) st.i = 0;
    const save = () => ls.set({ i: st.i, on: st.on });
    const cur = () => STATIONS[st.i];

    const audio = new Audio();
    audio.preload = 'none';
    audio.setAttribute('playsinline', '');
    audio.volume = 0.1; // starts at 10% (an iPhone ignores this and uses its volume buttons)
    let state = 'idle'; // idle | loading | playing | blocked (the browser wants a tap first)
    let tries = 0, noteText = '', noteT = 0, armed = false;
    let gen = 0, failedGen = -1; // one number per start(): a dead stream may report failure twice, it counts once
    const listeners = new Set(); // the controls of whichever page is showing

    function emit() {
      for (const fn of [...listeners]) { try { fn(); } catch { listeners.delete(fn); } } // a page that is gone throws: forget it
      if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : 'paused'; } catch {}
    }
    function setState(s) { state = s; emit(); }
    function note(t) { noteText = t; clearTimeout(noteT); noteT = setTimeout(() => { noteText = ''; emit(); }, 3500); emit(); }

    async function start() {
      const g = ++gen;
      audio.src = cur().url; // a fresh source every time: a live stream always starts at "now"
      setState('loading');
      try { await audio.play(); }
      catch (e) {
        if (g !== gen) return; // a late answer for a station we already moved on from
        if (e && e.name === 'AbortError') return; // another start() took over
        if (e && e.name === 'NotAllowedError') { setState('blocked'); armResume(); return; }
        fail();
      }
    }
    function stop() { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    function play() { st.on = true; save(); tries = 0; start(); }
    function pause() { st.on = false; save(); stop(); setState('idle'); }
    function toggle() { state === 'playing' || state === 'loading' ? pause() : play(); }
    function go(d) { st.i = (st.i + d + N) % N; st.on = true; save(); tries = 0; start(); }
    // sound was refused (no tap yet): call this from a tap or key press to start it
    function resume() { if (st.on && state !== 'playing' && state !== 'loading') start(); }
    // a station that can't be reached: move on to the next, at most one full lap
    function fail() {
      if (failedGen === gen) return; failedGen = gen;
      if (++tries > N) { st.on = false; save(); stop(); setState('idle'); note('No station can be reached right now.'); return; }
      note(cur().name + ' is unreachable, trying the next one…');
      st.i = (st.i + 1) % N; save(); start();
    }
    audio.addEventListener('playing', () => { tries = 0; setState('playing'); meta(); });
    audio.addEventListener('waiting', () => { if (state === 'playing') setState('loading'); });
    // (a stale "error" event that arrives after the source changed has no error attached: ignore those, or one dead
    // station would make us skip a working one too)
    audio.addEventListener('error', () => { if (st.on && audio.error && audio.getAttribute('src')) fail(); });
    // the first tap or key press in this document starts refused music (the pages inside the shell do the same for theirs)
    function armResume() {
      if (armed) return; armed = true;
      const ev = ['click', 'touchend', 'keydown'];
      const once = (e) => {
        if (e.target && e.target.closest && e.target.closest('.radial-x,.sb-music')) return; // those buttons do their own thing
        armed = false; ev.forEach((t) => document.removeEventListener(t, once, true)); resume();
      };
      ev.forEach((t) => document.addEventListener(t, once, true));
    }
    // lock-screen / headset controls and the "now playing" card
    function meta() {
      if (!('mediaSession' in navigator)) return;
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: cur().name, artist: cur().tag, album: 'Video Studio radio' }); } catch {}
    }
    if ('mediaSession' in navigator) {
      const m = navigator.mediaSession;
      [['play', play], ['pause', pause], ['nexttrack', () => go(1)], ['previoustrack', () => go(-1)]].forEach(([a, f]) => { try { m.setActionHandler(a, f); } catch {} });
    }

    if (st.on) start(); // the music carries on from the last visit
    return {
      STATIONS, audio, toggle, next: () => go(1), prev: () => go(-1), resume,
      get state() { return state; }, get on() { return st.on; }, get cur() { return cur(); }, get note() { return noteText; },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  // ============================ the controls on a page ============================
  function buildControls(radio) {
    const ic = (d, fill) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    const I = {
      play: ic('<path d="M8 5.5v13l10.5-6.5z"/>', true),
      pause: ic('<path d="M7.5 5.5h3.2v13H7.5zM13.3 5.5h3.2v13h-3.2z"/>', true),
      load: ic('<path d="M12 4a8 8 0 1 0 8 8"/>'),
      next: ic('<path d="M6 6l9 6-9 6z"/><path d="M18.5 5.5v13"/>'),
      prev: ic('<path d="M18 6l-9 6 9 6z"/><path d="M5.5 5.5v13"/>'),
    };
    const roots = []; // every place the controls appear on this page
    function mount(host, cls, before, playCls, nameCls) {
      if (!host) return;
      const el = document.createElement('div');
      el.className = cls; el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Music player');
      el.innerHTML = `<button type="button" class="m-prev" aria-label="Previous station">${I.prev}</button>` +
        `<button type="button" class="m-play ${playCls}" aria-label="Play music"></button>` +
        `<button type="button" class="m-next" aria-label="Next station">${I.next}</button>` +
        `<span class="m-name ${nameCls}" aria-live="polite"></span>`;
      el.querySelector('.m-prev').onclick = radio.prev;
      el.querySelector('.m-next').onclick = radio.next;
      el.querySelector('.m-play').onclick = radio.toggle;
      before ? host.insertBefore(el, before) : host.appendChild(el);
      roots.push(el);
    }
    const sb = document.querySelector('.sb');
    mount(sb, 'sb-music', sb && sb.querySelector('.sb-foot'), 'sm-play', 'sm-name');
    // phone: the middle of the More menu is the Play / Pause button, with the station name under it
    const radial = document.getElementById('radial'), center = radial && radial.querySelector('.radial-x');
    let stationEl = null;
    if (center) {
      center.onclick = radio.toggle;
      stationEl = document.createElement('div'); stationEl.className = 'radial-station'; stationEl.setAttribute('aria-live', 'polite');
      stationEl.innerHTML = '<b></b><span></span>'; radial.appendChild(stationEl);
      // the name belongs to the open menu only: hidden outright whenever the menu is closed (whatever the stylesheet says)
      const sync = () => { stationEl.style.visibility = document.body.classList.contains('radial-open') ? '' : 'hidden'; };
      sync(); new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // refused sound (no tap yet in this browser session): the first tap on this page starts it
    let armed = false;
    function armHere() {
      if (armed) return; armed = true;
      const ev = ['click', 'touchend', 'keydown'];
      const once = (e) => {
        if (e.target && e.target.closest && e.target.closest('.radial-x,.sb-music')) return;
        armed = false; ev.forEach((t) => document.removeEventListener(t, once, true)); radio.resume();
      };
      ev.forEach((t) => document.addEventListener(t, once, true));
    }

    function render() {
      const state = radio.state, cur = radio.cur, note = radio.note;
      const label = note || (state === 'blocked' ? 'Tap to resume music' : state === 'loading' ? 'Connecting…' : cur.name + ' · ' + cur.tag);
      const busy = state === 'playing' || state === 'loading';
      roots.forEach((el) => {
        const b = el.querySelector('.m-play');
        b.innerHTML = state === 'loading' ? I.load : busy ? I.pause : I.play;
        b.dataset.s = state;
        b.setAttribute('aria-label', busy ? 'Pause music' : 'Play music');
        el.querySelector('.m-name').textContent = label;
      });
      if (center) {
        center.innerHTML = state === 'loading' ? I.load : busy ? I.pause : I.play;
        center.dataset.s = state;
        center.setAttribute('aria-label', busy ? 'Pause music' : 'Play music');
        const two = note ? [note, ''] : state === 'blocked' ? ['Tap play to resume', ''] : [cur.name, cur.tag];
        stationEl.firstChild.textContent = two[0]; stationEl.lastChild.textContent = two[1];
        stationEl.classList.toggle('show', busy || state === 'blocked' || !!note);
      }
      document.body.classList.toggle('music-on', busy);
      if (state === 'blocked') armHere();
    }

    const unsubscribe = radio.subscribe(render);
    addEventListener('pagehide', unsubscribe); // this page is going away: stop updating it
    window.studioRadio = {
      toggle: radio.toggle, next: radio.next, prev: radio.prev,
      get state() { return radio.state; }, get on() { return radio.on; }, get audio() { return radio.audio; }, stations: radio.STATIONS,
    };
    render();
  }
})();
