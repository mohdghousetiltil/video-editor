// Netrunner easter egg: the screen break. Loaded by app.js only in netrunner mode; the first tap on the + button
// plays it (once per app launch), after that + opens the circle menu as usual.
// About 10 seconds: impact from the button → the glass shatters → breach readout → blackout → reboot → restore.
// It is only a layer on top of the page: nothing underneath is reloaded or changed, a tap (or Escape) skips it, and
// every sound is made here with Web Audio (no files, no network).
(function () {
  if (window.studioBreach) return;
  const FULL = 10400, CALM = 3600;
  let running = false;

  // ------------------------------------------------------------------ the glass, as sound
  // Breaking glass is a hard, very short snap followed by hundreds of small pieces, each ringing for a few hundredths of
  // a second at several unrelated high pitches. That is what is computed here, sample by sample, in stereo: every piece
  // has its own place (louder in the nearer ear and reaching the other one a moment later), so on headphones the glass
  // breaks around you and falls past. Nothing is recorded or downloaded.
  const SR = 44100;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pitch = (a, b) => a * Math.pow(b / a, Math.random());

  function soundSheet(seconds) {
    const n = Math.ceil(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
    // where a sound sits between the ears: how loud and how late on each side
    const place = (pan) => {
      const p = Math.max(-1, Math.min(1, pan));
      return { l: Math.cos((p + 1) * Math.PI / 4), r: Math.sin((p + 1) * Math.PI / 4), dl: p > 0 ? Math.round(p * 30) : 0, dr: p < 0 ? Math.round(-p * 30) : 0 };
    };
    // a hard edge: a few thousandths of a second of bright noise
    const snap = (t, amp, len, pan) => {
      const p = place(pan), at = Math.round(t * SR), m = Math.round(len * SR * 5);
      let last = 0;
      for (let i = 0; i < m; i++) {
        const w = Math.random() * 2 - 1, v = (w - last) * 0.5 * amp * Math.exp(-i / (len * SR));
        last = w;
        if (at + i + p.dl < n) L[at + i + p.dl] += v * p.l;
        if (at + i + p.dr < n) R[at + i + p.dr] += v * p.r;
      }
    };
    // one piece of glass ringing
    const piece = (t, freq, ring, amp, pan) => {
      const p = place(pan), at = Math.round(t * SR);
      snap(t, amp * 0.7, 0.00035, pan);
      [1, 1.47, 2.09, 2.76, 3.93].forEach((ratio, k) => {
        const hz = freq * ratio * rand(0.96, 1.04);
        if (hz > 17500) return;
        const tau = ring / (1 + k * 0.55), w = 2 * Math.PI * hz / SR, r = Math.exp(-1 / (tau * SR)), c1 = 2 * r * Math.cos(w), c2 = r * r;
        const m = Math.round(tau * SR * 6), level = amp * rand(0.35, 1) / (1 + k * 0.5);
        let y2 = 0, y1 = level * r * Math.sin(w);
        for (let i = 1; i < m; i++) {
          if (at + i + p.dl < n) L[at + i + p.dl] += y1 * p.l;
          if (at + i + p.dr < n) R[at + i + p.dr] += y1 * p.r;
          const y = c1 * y1 - c2 * y2; y2 = y1; y1 = y;
        }
      });
    };
    // the weight behind a blow: a short dull knock
    const knock = (t, amp) => {
      const at = Math.round(t * SR);
      let low = 0;
      for (let i = 0; i < SR * 0.4 && at + i < n; i++) {
        low += (Math.random() * 2 - 1 - low) * 0.025;
        const v = amp * (low * 2.6 * Math.exp(-i / (SR * 0.05)) + Math.sin(2 * Math.PI * 58 * i / SR) * 0.7 * Math.exp(-i / (SR * 0.085))) * Math.min(1, i / 40);
        L[at + i] += v; R[at + i] += v;
      }
    };
    // scaled so the loudest moment reaches `peak`; the soft curve keeps the small pieces audible next to the blows
    const done = (peak) => {
      let top = 0;
      for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(L[i]), Math.abs(R[i]));
      const norm = Math.tanh(2.2);
      for (const c of [L, R]) for (let i = 0; i < n; i++) c[i] = top ? peak * Math.tanh((c[i] / top) * 2.2) / norm : 0;
      return [L, R];
    };
    return { snap, piece, knock, done };
  }

  // the break itself, timed to the picture (seconds from the tap)
  function renderBreak() {
    const s = soundSheet(5.2);
    const blow = (t, power) => {
      s.knock(t, 1.5 * power);
      s.snap(t, 3 * power, 0.0022, 0); s.snap(t + 0.006, 2 * power, 0.0012, -0.35); s.snap(t + 0.013, 1.6 * power, 0.001, 0.4);
      for (let i = 0; i < 90; i++) s.snap(t + Math.pow(Math.random(), 2) * 0.12, rand(0.15, 1.1) * power, rand(0.0002, 0.0012), rand(-0.7, 0.7));
      for (let i = 0; i < 9; i++) s.piece(t + rand(0, 0.025), pitch(900, 2600), rand(0.045, 0.13), rand(0.25, 0.55) * power, rand(-0.5, 0.5));
      for (let i = 0; i < 130; i++) { const d = -Math.log(1 - Math.random() * 0.995) * 0.075; s.piece(t + d, pitch(2400, 10500), rand(0.005, 0.045), rand(0.05, 0.5) * power * Math.exp(-d * 3), rand(-0.9, 0.9)); }
    };
    // cracks running through the pane: little clusters of dry ticks, each from one side
    const creep = (from, to, groups) => {
      for (let g = 0; g < groups; g++) {
        let t = from + (g + Math.random() * 0.8) * (to - from) / groups;
        const pan = rand(-0.85, 0.85), many = 3 + Math.floor(Math.random() * 11);
        for (let i = 0; i < many; i++) { s.snap(t, rand(0.12, 0.8), rand(0.00015, 0.0007), pan + rand(-0.1, 0.1)); t += rand(0.0008, 0.011); }
        if (Math.random() < 0.7) s.piece(t, pitch(3200, 8000), rand(0.006, 0.025), rand(0.05, 0.18), pan);
      }
    };
    blow(0, 1);
    creep(0.22, 1.34, 13);
    blow(1.4, 0.85);
    creep(1.55, 1.85, 6);
    // the pane gives way: a rush of pieces, mostly small, a few big
    for (let i = 0; i < 460; i++) {
      const t = 1.8 + (Math.random() + Math.random()) * 0.65, loud = Math.pow(Math.random(), 3);
      s.piece(t, pitch(1500, 9500) * (1 - loud * 0.35), 0.006 + loud * 0.07, 0.025 + loud * 0.42, rand(-1, 1));
    }
    // pieces landing somewhere below, then the last splinters
    for (let i = 0; i < 17; i++) {
      const t = rand(2.55, 3.95), pan = rand(-0.95, 0.95), fade = 1 - (t - 2.55) / 1.9;
      s.snap(t, 0.9 * fade, 0.0013, pan); s.piece(t, pitch(1100, 3200), rand(0.04, 0.11), 0.4 * fade, pan);
      for (let k = 0, at = t, many = rand(6, 20); k < many; k++) { at += rand(0.004, 0.035); s.piece(at, pitch(2800, 9800), rand(0.005, 0.03), rand(0.03, 0.22) * fade, pan + rand(-0.15, 0.15)); }
    }
    for (let i = 0; i < 38; i++) { const t = rand(3.7, 4.9); s.piece(t, pitch(3500, 11000), rand(0.006, 0.04), rand(0.015, 0.1) * (5 - t), rand(-1, 1)); }
    return s.done(0.95);
  }
  // for the way back: pieces gathering (a shower played backwards), and one clean ring as the last one settles
  function renderGather() {
    const s = soundSheet(0.9);
    for (let i = 0; i < 120; i++) { const t = Math.pow(Math.random(), 1.8) * 0.75; s.piece(t, pitch(2600, 9000), rand(0.008, 0.05), rand(0.05, 0.3) * (1 - t), rand(-0.9, 0.9)); }
    const [L, R] = s.done(0.5);
    L.reverse(); R.reverse();
    return [L, R];
  }
  function renderRing() {
    const s = soundSheet(1.4);
    s.piece(0, 2093, 0.2, 0.6, -0.15); s.piece(0.004, 3136, 0.16, 0.35, 0.2);
    return s.done(0.4);
  }
  // computed once, a moment after loading, so the tap itself is answered at once
  let sheets = null;
  const glassSounds = () => sheets || (sheets = { break: renderBreak(), gather: renderGather(), ring: renderRing() });
  setTimeout(glassSounds, 60);

  // ------------------------------------------------------------------ sound
  function createSound() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    let ac;
    try { ac = new AC(); } catch { return null; }
    ac.resume && ac.resume().catch(() => {}); // we are inside the tap that started it, so this is allowed
    // everything goes out through a little extra sparkle on top and a limiter that lets the sharp edges through
    const out = ac.createGain(), air = ac.createBiquadFilter(), comp = ac.createDynamicsCompressor();
    out.gain.value = 0.6; air.type = 'highshelf'; air.frequency.value = 6000; air.gain.value = 3.5;
    comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.12;
    out.connect(air); air.connect(comp); comp.connect(ac.destination);
    // a small hard room around the glass: an echo made of fading noise
    const room = ac.createConvolver(), wet = ac.createGain(), tail = ac.createBuffer(2, Math.round(ac.sampleRate * 1.1), ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = tail.getChannelData(ch);
      let low = 0;
      for (let i = 0; i < d.length; i++) { low += (Math.random() * 2 - 1 - low) * 0.65; d[i] = i < ac.sampleRate * 0.012 ? 0 : low * Math.pow(1 - i / d.length, 3.2); }
    }
    room.buffer = tail; wet.gain.value = 0.22; room.connect(wet); wet.connect(out);
    const noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const t0 = ac.currentTime + 0.02;
    // one of the computed glass sounds, at a time in seconds from the tap
    const glass = (t, name, vol) => {
      const [L, R] = glassSounds()[name], b = ac.createBuffer(2, L.length, SR), s = ac.createBufferSource(), g = ac.createGain();
      b.getChannelData(0).set(L); b.getChannelData(1).set(R);
      g.gain.value = vol; s.buffer = b; s.connect(g); g.connect(out); g.connect(room); s.start(t0 + t);
    };
    const env = (g, at, dur, vol, attack) => {
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    };
    // a pitched sound: wave shape, start and end pitch, length, loudness (all times in seconds from the tap)
    const tone = (t, type, f0, f1, dur, vol, attack = 0.008) => {
      const o = ac.createOscillator(), g = ac.createGain(), at = t0 + t;
      o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + dur);
      env(g, at, dur, vol, attack); o.connect(g); g.connect(out); o.start(at); o.stop(at + dur + 0.05);
    };
    // filtered noise: static, air, dry ticks
    const noise = (t, dur, vol, kind, f0, f1, q = 1, attack = 0.004) => {
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), at = t0 + t;
      s.buffer = noiseBuf; s.loop = true; f.type = kind; f.Q.value = q;
      f.frequency.setValueAtTime(f0, at); f.frequency.exponentialRampToValueAtTime(f1, at + dur);
      env(g, at, dur, vol, attack); s.connect(f); f.connect(g); g.connect(out); s.start(at, Math.random()); s.stop(at + dur + 0.05);
    };
    return { glass, tone, noise, close: () => { try { out.gain.setTargetAtTime(0, ac.currentTime, 0.02); setTimeout(() => ac.close().catch(() => {}), 120); } catch {} } };
  }

  function scoreFull(s) {
    s.glass(0, 'break', 1);
    // breach: a low drone, dry data ticks as the lines arrive, three deep pulses
    s.tone(3.0, 'sine', 43, 41, 3.4, 0.26, 0.8); s.tone(3.0, 'sine', 64.5, 62, 3.4, 0.1, 1.2); s.noise(3.0, 3.4, 0.045, 'bandpass', 220, 420, 1.5, 1.4);
    LINES.forEach(([at]) => { for (let i = 0; i < 4; i++) s.noise(at / 1000 + i * 0.028 + Math.random() * 0.008, 0.012, 0.09, 'bandpass', 4200, 3600, 3, 0.001); });
    [3.9, 4.75, 5.6].forEach((t) => { s.tone(t, 'sine', 74, 38, 0.55, 0.42, 0.012); s.noise(t, 0.3, 0.07, 'lowpass', 700, 90, 0.7, 0.01); });
    // power down
    s.noise(6.4, 0.7, 0.2, 'lowpass', 5000, 60, 0.7, 0.01); s.tone(6.4, 'sine', 140, 26, 0.7, 0.35, 0.02); s.noise(7.05, 0.05, 0.4, 'lowpass', 900, 120, 0.7, 0.001);
    // cold boot: a warm chord swelling in, a dry tick per line
    [98, 146.83, 196, 293.66].forEach((f, i) => s.tone(7.7, 'sine', f, f, 2.7, 0.085 - i * 0.014, 1.1));
    BOOT.forEach(([at]) => s.noise(at / 1000, 0.018, 0.16, 'bandpass', 3000, 2600, 4, 0.001));
    // the way back
    s.glass(9.28, 'gather', 0.75); s.noise(9.4, 0.8, 0.07, 'highpass', 1500, 7000, 0.7, 0.55); s.glass(10.16, 'ring', 0.8);
  }
  const scoreCalm = (s) => { s.tone(0.1, 'sine', 330, 330, 0.9, 0.14, 0.06); s.tone(1.8, 'sine', 392, 392, 0.9, 0.12, 0.06); s.tone(2.0, 'sine', 523.25, 523.25, 1.2, 0.12, 0.06); };

  // [when (ms), text, style]
  const LINES = [
    [3050, 'ICE BREACH DETECTED', 'h'],
    [3450, 'TRACE ........ YOUR THUMB'],
    [3900, 'DAEMON ....... BLACKWALL.EXE', 'm'],
    [4350, 'FIREWALL ..... FAILED', 'm'],
    [4800, 'CORTEX TEMP .. 104°C', 'm'],
    [5250, 'RENDER CORE .. HIJACKED', 'm'],
    [5750, '> PULL THE PLUG? Y_', 'y'],
  ];
  const BOOT = [
    [7750, 'COLD BOOT', 'h'],
    [8150, 'MEMORY ....... OK'],
    [8500, 'ICE .......... REBUILT'],
    [8850, 'YOUR WORK .... INTACT'],
    [9200, 'WELCOME BACK, NETRUNNER', 'y'],
  ];

  // ------------------------------------------------------------------ the radio and anything else making noise
  // Goes quiet at once and comes back with a short fade. (An iPhone ignores volume, so muting does the work there.)
  function hush() {
    let radio = null;
    try { radio = window.studioRadio && window.studioRadio.audio; } catch {}
    const was = radio ? { muted: radio.muted, volume: radio.volume } : null;
    const others = [...document.querySelectorAll('video,audio')].filter((m) => !m.paused && !m.muted);
    others.forEach((m) => { m.muted = true; });
    let iv = 0, back = false;
    const fade = (from, to, ms, done) => {
      clearInterval(iv);
      const start = Date.now();
      iv = setInterval(() => {
        const p = Math.min(1, (Date.now() - start) / ms);
        try { radio.volume = from + (to - from) * p; } catch {}
        if (p >= 1) { clearInterval(iv); done && done(); }
      }, 30);
    };
    if (radio) fade(was.volume, 0, 220, () => { radio.muted = true; });
    return {
      // now = true: put everything back immediately (skip, or the page is going away)
      restore(now) {
        if (back && !now) return;
        back = true;
        others.forEach((m) => { m.muted = false; });
        if (!radio) return;
        clearInterval(iv);
        if (now) { radio.volume = was.volume; radio.muted = was.muted; return; }
        radio.volume = 0; radio.muted = was.muted; fade(0, was.volume, 900);
      },
    };
  }

  // ------------------------------------------------------------------ the broken glass
  // A web of cracks around the point of impact: spokes crossed by uneven rings. Neighbouring pieces share their corners.
  function buildGlass(ox, oy, W, H) {
    const S = 18, far = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy)) + 80;
    const radii = [0, 42, 95, 170, 270, 400, 570].filter((r) => r < far - 60).concat([far, far + 160]);
    const angles = Array.from({ length: S }, (_, s) => (s / S) * Math.PI * 2 + (Math.random() - 0.5) * 0.22);
    const P = radii.map((r, i) => angles.map((a) => {
      const rr = i === 0 ? 0 : r * (0.8 + Math.random() * 0.4), aa = a + (i === 0 ? 0 : (Math.random() - 0.5) * 0.12);
      return { x: ox + Math.cos(aa) * rr, y: oy + Math.sin(aa) * rr, d: rr };
    }));
    const shards = [], edges = [];
    for (let i = 0; i < radii.length - 1; i++) {
      for (let s = 0; s < S; s++) {
        const n = (s + 1) % S;
        const pts = i === 0 ? [P[0][s], P[1][s], P[1][n]] : [P[i][s], P[i + 1][s], P[i + 1][n], P[i][n]];
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        const dist = Math.hypot(cx - ox, cy - oy);
        shards.push({ pts, cx, cy, at: 1800 + Math.min(1, dist / far) * 800 + Math.random() * 280,
          vx: ((cx - ox) / (dist || 1)) * (30 + Math.random() * 90), vy: -40 - Math.random() * 140, vz: (60 + Math.random() * 380) * (dist > 200 ? 0.25 : 1), // big pieces mostly just drop
          spin: (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 3.4), axis: Math.random() * Math.PI, tint: Math.random(), rim: Math.max(...pts.map((p) => p.d)) });
        edges.push({ a: P[i][s], b: P[i + 1][s] });                       // along a spoke
        if (i > 0 && Math.random() < 0.82) edges.push({ a: P[i][s], b: P[i][n] }); // across, with a few gaps
      }
    }
    // the crushed spot where the blow landed, and the splinters thrown off by both blows
    const crush = Array.from({ length: 110 }, () => {
      const a = Math.random() * Math.PI * 2, r = Math.pow(Math.random(), 1.7) * 62, b = a + (Math.random() - 0.5) * 2.4, len = 3 + Math.random() * 15;
      const x = ox + Math.cos(a) * r, y = oy + Math.sin(a) * r;
      return [x, y, x + Math.cos(b) * len, y + Math.sin(b) * len];
    });
    const splinters = [0, 1400].flatMap((at) => Array.from({ length: at ? 70 : 110 }, () => {
      const a = Math.random() * Math.PI * 2, v = 90 + Math.random() * 620;
      return { at, life: 0.5 + Math.random() * 0.6, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 220, vz: 80 + Math.random() * 520,
        size: 2 + Math.pow(Math.random(), 2.5) * 13, spin: 6 + Math.random() * 18, turn: Math.random() * 6.3 };
    }));
    return { shards, edges, far, crush, splinters };
  }

  // ---- depth: the pane is flat on the screen, z comes out of it towards the eye
  const EYE = 750;
  const seen = (p, W, H) => { const k = EYE / Math.max(170, EYE - p[2]); return { x: W / 2 + (p[0] - W / 2) * k, y: H / 2 + (p[1] - H / 2) * k }; };
  // light from the upper left, in front; how strongly a tilted face throws it into the eye
  const glint = (n) => {
    const up = n[2] < 0 ? -1 : 1, lx = -0.35, ly = -0.5, lz = 0.79; // glass shines from either side
    const hx = lx, hy = ly, hz = lz + 1, h = Math.hypot(hx, hy, hz);
    return Math.pow(Math.max(0, up * (n[0] * hx + n[1] * hy + n[2] * hz) / h), 14);
  };

  // one falling piece: a thick slab turning in space, with a lit face, a darker back and green-blue cut edges
  function drawShard(g, s, dt, W, H, fade) {
    const a = s.spin * dt, c = Math.cos(a), n = Math.sin(a), ux = Math.cos(s.axis), uy = Math.sin(s.axis);
    const mx = s.cx + s.vx * dt, my = s.cy + s.vy * dt + 1050 * dt * dt, mz = s.vz * dt;
    const normal = [uy * n, -ux * n, c];
    const thick = 9;
    const front3 = s.pts.map((p) => {
      const x = p.x - s.cx, y = p.y - s.cy, along = x * ux + y * uy, across = -x * uy + y * ux;
      return [mx + along * ux - across * c * uy, my + along * uy + across * c * ux, mz + across * n];
    });
    const front = front3.map((p) => seen(p, W, H));
    const back = front3.map((p) => seen([p[0] - normal[0] * thick, p[1] - normal[1] * thick, p[2] - normal[2] * thick], W, H));
    const shine = glint(normal);
    g.globalAlpha = fade;
    trace(g, back); g.fillStyle = 'rgba(8,30,44,.28)'; g.fill(); g.strokeStyle = 'rgba(110,190,200,.35)'; g.lineWidth = 0.8; g.stroke();
    for (let i = 0; i < front.length; i++) {
      const j = (i + 1) % front.length;
      trace(g, [front[i], front[j], back[j], back[i]]);
      g.fillStyle = i % 2 ? 'rgba(120,235,215,.34)' : 'rgba(60,150,170,.28)'; g.fill();
    }
    const p = front[0], q = front[Math.floor(front.length / 2)];
    const body = g.createLinearGradient(p.x, p.y, q.x, q.y);
    body.addColorStop(0, `rgba(215,240,255,${(0.08 + shine * 0.72).toFixed(3)})`);
    body.addColorStop(0.55, `rgba(110,165,200,${(0.1 + (1 - Math.abs(c)) * 0.16 + shine * 0.25).toFixed(3)})`);
    body.addColorStop(1, 'rgba(18,42,66,.34)');
    trace(g, front); g.fillStyle = body; g.fill();
    g.strokeStyle = `rgba(235,252,255,${(0.45 + shine * 0.55).toFixed(3)})`; g.lineWidth = 0.8 + shine * 1.2; g.stroke();
    g.globalAlpha = 1;
  }

  function drawFalling(g, glass, t, W, H) {
    // the ones that left first are the nearest by now, so they are drawn last
    const falling = glass.shards.filter((s) => t >= s.at && t - s.at < 1150).sort((a, b) => b.at - a.at);
    for (const s of falling) { const dt = (t - s.at) / 1000; drawShard(g, s, dt, W, H, Math.max(0, Math.min(1, (1.15 - dt) / 0.45))); }
  }

  function drawSplinters(g, glass, t, ox, oy, W, H) {
    for (const s of glass.splinters) {
      const dt = (t - s.at) / 1000;
      if (dt < 0 || dt > s.life) continue;
      const mid = [ox + s.vx * dt, oy + s.vy * dt + 900 * dt * dt, s.vz * dt], a = s.turn + s.spin * dt, squash = Math.cos(a * 0.7);
      const pts = [[0, 1], [2.3, 0.45], [4.1, 0.75]].map(([off, r]) => seen([mid[0] + Math.cos(a + off) * s.size * r, mid[1] + Math.sin(a + off) * s.size * r * squash, mid[2]], W, H));
      const lit = Math.pow(Math.abs(Math.sin(a * 1.3)), 6);
      g.globalAlpha = Math.max(0, 1 - dt / s.life);
      trace(g, pts); g.fillStyle = `rgba(205,238,255,${(0.22 + lit * 0.7).toFixed(3)})`; g.fill();
      g.strokeStyle = 'rgba(240,253,255,.55)'; g.lineWidth = 0.6; g.stroke();
    }
    g.globalAlpha = 1;
  }

  // behind the cracks, each piece now sits at its own slight angle: some catch the light, some turn away from it
  function drawFacets(g, glass, front) {
    for (const s of glass.shards) {
      if (s.rim > front) continue;
      const bright = s.tint > 0.55, k = bright ? (s.tint - 0.55) * 0.26 : (0.55 - s.tint) * 0.34;
      const a = s.pts[0], b = s.pts[Math.floor(s.pts.length / 2)], shade = g.createLinearGradient(a.x, a.y, b.x, b.y);
      const rgb = bright ? '190,230,255' : '0,4,14';
      shade.addColorStop(0, `rgba(${rgb},${(k * 1.5).toFixed(3)})`); shade.addColorStop(1, `rgba(${rgb},${(k * 0.25).toFixed(3)})`);
      trace(g, s.pts); g.fillStyle = shade; g.fill();
    }
  }

  function drawCrush(g, glass, alpha) {
    g.save(); g.globalAlpha = alpha; g.strokeStyle = 'rgba(230,248,255,.65)'; g.lineWidth = 0.8; g.beginPath();
    for (const [x1, y1, x2, y2] of glass.crush) { g.moveTo(x1, y1); g.lineTo(x2, y2); }
    g.stroke(); g.restore();
  }

  const trace = (g, pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };

  // cracks as far out as `front`, drawn three times a little apart: the red and blue fringes of a broken display
  function drawCracks(g, glass, front, split, alpha) {
    [[1.6, 1.8, 'rgba(0,0,0,.6)', 2.6], [-split, -split * 0.35, 'rgba(255,46,147,.42)', 1.1], [split, split * 0.35, 'rgba(0,229,255,.42)', 1.1],
      [-0.7, -0.7, 'rgba(150,220,235,.5)', 2], [0, 0, 'rgba(245,253,255,.96)', 0.8]].forEach(([dx, dy, color, width]) => {
      g.save(); g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width; g.translate(dx, dy); g.beginPath();
      for (const e of glass.edges) {
        if (e.a.d >= front) continue;
        const p = e.b.d <= front ? 1 : (front - e.a.d) / Math.max(1, e.b.d - e.a.d);
        g.moveTo(e.a.x, e.a.y); g.lineTo(e.a.x + (e.b.x - e.a.x) * p, e.a.y + (e.b.y - e.a.y) * p);
      }
      g.stroke(); g.restore();
    });
  }

  // ------------------------------------------------------------------ the show
  function play(origin, opts = {}) {
    if (running) return false;
    running = true;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = calm ? CALM : FULL;
    const root = document.documentElement;

    const el = document.createElement('div');
    el.className = 'eg-br' + (calm ? ' calm' : '');
    el.tabIndex = -1;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Netrunner easter egg. Tap or press Escape to skip.');
    el.innerHTML = '<canvas aria-hidden="true"></canvas><div class="eg-br-term" aria-hidden="true"><div class="eg-br-lines"></div><div class="eg-br-bar" hidden><i></i><span></span></div></div><div class="eg-br-skip">TAP TO SKIP</div>';
    const cv = el.querySelector('canvas'), g = cv.getContext('2d');
    const term = el.querySelector('.eg-br-term'), lines = el.querySelector('.eg-br-lines'), bar = el.querySelector('.eg-br-bar'), skip = el.querySelector('.eg-br-skip');
    const focused = document.activeElement;
    focused && focused.blur && focused.blur(); // nothing typed during the show lands in a text box underneath
    root.appendChild(el);
    el.focus({ preventScroll: true });

    let W = 0, H = 0, glass = null;
    const size = () => {
      const r = el.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (!r.width || !r.height) return;
      W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ox = origin && isFinite(origin.x) ? origin.x : W / 2, oy = origin && isFinite(origin.y) ? origin.y : H - 70;
    glass = buildGlass(ox, oy, W, H);

    const quiet = hush();
    const sound = createSound();
    if (sound) (calm ? scoreCalm : scoreFull)(sound);
    const buzz = (p) => { try { !calm && navigator.vibrate && navigator.vibrate(p); } catch {} }; // Android only

    const t0 = performance.now();
    let raf = 0, done = false, shown = 0, phase = '', hit2 = false;
    const timers = [];

    const showLines = (list, t, key) => {
      if (phase !== key) { phase = key; shown = 0; lines.textContent = ''; }
      while (shown < list.length && t >= list[shown][0]) {
        const d = document.createElement('div');
        d.textContent = list[shown][1]; d.dataset.t = list[shown][1]; d.className = list[shown][2] || '';
        lines.appendChild(d); shown++;
      }
    };
    const progress = (p, label) => { bar.hidden = false; bar.firstChild.style.transform = `scaleX(${p.toFixed(3)})`; bar.lastChild.textContent = label + ' ' + Math.floor(p * 100) + '%'; };

    function frameCalm(t) {
      el.style.opacity = Math.min(1, t / 500, Math.max(0, (CALM - t) / 600)).toFixed(3);
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(3,4,10,.94)'; g.fillRect(0, 0, W, H);
      drawCracks(g, glass, glass.far, 1.5, 0.3); // one still picture of the damage: nothing moves
      showLines(t < 1800 ? [[0, 'BREACH CONTAINED', 'h'], [0, 'YOUR WORK .... INTACT']] : [[0, 'SYSTEM RESTORED', 'h'], [0, 'WELCOME BACK, NETRUNNER', 'y']], t, t < 1800 ? 'c1' : 'c2');
      if (t > 2200) quiet.restore();
    }

    function frameFull(t) {
      g.clearRect(0, 0, W, H);
      term.style.opacity = '1';
      if (t < 3300) {
        // impact and cracking: the page is still visible through the glass
        const front = t < 1400 ? Math.min(1, t / 380) * 230 + Math.max(0, t - 500) * 0.06 : 285 + Math.min(1, (t - 1400) / 330) * glass.far;
        if (t >= 1400 && !hit2) { hit2 = true; shake(); buzz([60, 30, 90]); }
        g.fillStyle = `rgba(3,4,10,${(Math.min(1, t / 1800) * 0.35).toFixed(3)})`;
        if (t < 1800) g.fillRect(0, 0, W, H);
        else {
          // pieces still in place stay see-through, the ones that left show the dark behind the screen
          for (const s of glass.shards) {
            trace(g, s.pts);
            g.fillStyle = t >= s.at ? '#02030a' : 'rgba(3,4,10,.35)';
            g.fill();
            if (t >= s.at) { g.strokeStyle = '#02030a'; g.lineWidth = 1.2; g.stroke(); } // no seams between holes
          }
        }
        if (t < 1800) { drawFacets(g, glass, front); drawCracks(g, glass, front, 2 + (t < 220 || (t > 1400 && t < 1620) ? 4 : 0), 1); drawCrush(g, glass, Math.min(1, t / 90)); }
        else {
          for (const s of glass.shards) {
            if (t >= s.at) continue;
            trace(g, s.pts); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 2.6; g.stroke(); g.strokeStyle = 'rgba(215,248,255,.8)'; g.lineWidth = 0.9; g.stroke();
          }
          drawFalling(g, glass, t, W, H);
        }
        drawSplinters(g, glass, t, ox, oy, W, H);
        // the shock ring, and one soft flash at the moment of impact (the only flash in the whole show)
        if (t < 600) {
          const p = t / 600;
          g.strokeStyle = `rgba(0,229,255,${(1 - p).toFixed(3)})`; g.lineWidth = 10 * (1 - p) + 1;
          g.beginPath(); g.arc(ox, oy, 20 + p * glass.far * 0.7, 0, Math.PI * 2); g.stroke();
          const glow = g.createRadialGradient(ox, oy, 0, ox, oy, 210);
          glow.addColorStop(0, `rgba(215,250,255,${(0.7 * (1 - p)).toFixed(3)})`); glow.addColorStop(1, 'rgba(215,250,255,0)');
          g.fillStyle = glow; g.fillRect(0, 0, W, H);
        }
      } else if (t < 6400) {
        g.fillStyle = '#02030a'; g.fillRect(0, 0, W, H);
        drawCracks(g, glass, glass.far, 3, 0.13);
        if (t < 4100) drawFalling(g, glass, t, W, H); // the last pieces are still on their way down
      } else if (t < 7700) {
        // the display collapses to a line, then a dot, then nothing
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        const p = (t - 6400) / 650;
        if (p < 1) {
          const w = p < 0.55 ? W * (1 - p * 0.3) : Math.max(3, W * 0.835 * (1 - (p - 0.55) / 0.45)), h = p < 0.3 ? 2 + 60 * Math.pow(1 - p / 0.3, 2) : 2;
          g.fillStyle = `rgba(200,248,255,${(p < 0.3 ? 0.25 + p * 2 : 0.85 * Math.min(1, (1 - p) * 3)).toFixed(3)})`;
          g.fillRect((W - w) / 2, H / 2 - h / 2, w, h);
        }
      } else {
        // reboot, then a hole opens from the button and the app is back
        g.fillStyle = '#03040a'; g.fillRect(0, 0, W, H);
        if (t > 9550) {
          quiet.restore();
          const p = Math.min(1, (t - 9550) / (FULL - 9550)), r = Math.pow(p, 1.8) * (glass.far + 20);
          g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(ox, oy, r, 0, Math.PI * 2); g.fill(); g.restore();
          g.strokeStyle = `rgba(0,229,255,${(1 - p * 0.7).toFixed(3)})`; g.lineWidth = 3; g.beginPath(); g.arc(ox, oy, r, 0, Math.PI * 2); g.stroke();
          term.style.opacity = Math.max(0, 1 - p * 2.2).toFixed(3);
        }
      }
      // torn bands of colour, faint on purpose (no flashing), moving about 8 times a second
      if ((t > 120 && t < 1900) || (t > 3000 && t < 6400)) {
        const step = Math.floor(t / 125), rnd = (n) => { const v = Math.sin(step * 91.7 + n * 47.3) * 43758.5453; return v - Math.floor(v); };
        for (let i = 0; i < 4; i++) {
          if (rnd(i) < 0.45) continue;
          const y = rnd(i + 9) * H, h = 2 + rnd(i + 17) * 14, x = (rnd(i + 23) - 0.5) * 90;
          g.fillStyle = 'rgba(255,46,147,.14)'; g.fillRect(x, y, W, h);
          g.fillStyle = 'rgba(0,229,255,.14)'; g.fillRect(-x, y + h * 0.6, W, h * 0.6);
        }
      }
      // the readouts
      if (t >= 3000 && t < 6400) {
        showLines(LINES, t, 'breach');
        if (t > 3300) progress(Math.min(0.99, (t - 3300) / 2700), 'UPLOADING YOUR SOUL');
      } else if (t >= 7700) {
        showLines(BOOT, t, 'boot');
        if (t > 7900) progress(Math.min(1, (t - 7900) / 1400), 'RESTORING');
      } else if (phase) { phase = ''; shown = 0; lines.textContent = ''; bar.hidden = true; }
      term.classList.toggle('boot', t >= 7700);
    }

    // the page itself jolts under the glass
    function shake() { root.classList.remove('eg-br-hit'); void root.offsetWidth; root.classList.add('eg-br-hit'); }

    function tick() {
      if (done) return;
      const t = performance.now() - t0;
      if (t >= total) return finish(false);
      skip.classList.toggle('show', t > 900 && t < total - 900);
      (calm ? frameCalm : frameFull)(t);
      raf = requestAnimationFrame(tick);
    }

    // ---- leaving: the end, a tap, Escape, or the page going out of sight. Safe to call more than once. ----
    function finish(skipped) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf); timers.forEach(clearInterval);
      sound && sound.close();
      quiet.restore(true);
      root.classList.remove('eg-br-hit');
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', swallow, true);
      removeEventListener('resize', size); removeEventListener('pagehide', leave); removeEventListener('message', onShell); document.removeEventListener('visibilitychange', onHide);
      const gone = () => {
        el.remove(); running = false;
        if (opts.focus && opts.focus.focus) opts.focus.focus({ preventScroll: true }); // keyboard users go back to the button
        opts.done && opts.done(skipped);
      };
      if (!skipped) return gone();
      // fade out; the layer keeps catching the finger meanwhile, so the skipping tap never reaches the page
      let a = el.style.opacity === '' ? 1 : Number(el.style.opacity);
      const iv = setInterval(() => { a -= 0.17; el.style.opacity = Math.max(0, a).toFixed(3); if (a <= 0) { clearInterval(iv); gone(); } }, 30);
    }

    const born = Date.now();
    const swallow = (e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); } };
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey) return;
      swallow(e);
      if (e.key === 'Escape' && !e.repeat) finish(true);
    };
    const leave = () => finish(false);
    const onHide = () => { if (document.hidden) finish(false); };
    const onShell = (e) => { if (e.origin === location.origin && e.data && e.data.shell === 'shown') finish(false); };
    addEventListener('keydown', onKey, true); addEventListener('keyup', swallow, true);
    addEventListener('resize', size); addEventListener('pagehide', leave); addEventListener('message', onShell); document.addEventListener('visibilitychange', onHide);
    // touches stay on this layer: no scrolling underneath, and the app's other gestures don't see them
    ['touchstart', 'touchmove', 'touchend', 'wheel', 'pointerdown', 'pointerup'].forEach((type) =>
      el.addEventListener(type, (e) => { e.stopPropagation(); if (type === 'touchmove' || type === 'wheel') e.preventDefault(); }, { passive: false }));
    el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (Date.now() - born > 450) finish(true); // a double tap on + doesn't skip it by accident
    });
    // the shell hides this page's frame when another tab is shown (animation frames stop then), and a safety net
    // makes sure the layer can never stay behind
    timers.push(setInterval(() => {
      let away = false;
      try { const sh = window.parent !== window && window.parent.__shell; away = !!(sh && sh.active && sh.active() !== window); } catch {}
      if (away || performance.now() - t0 > total + 400) finish(false);
    }, 250));

    if (!calm) { shake(); buzz([90, 40, 160]); }
    tick();
    return true;
  }

  window.studioBreach = { play, get running() { return running; } };
})();
