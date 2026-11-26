// Who is in this video, and which person should be swapped. Runs in the browser and costs nothing:
// a small face detector (face-api, loaded from a CDN only when a face swap video is opened) looks at about
// 24 frames, the faces are linked into people across frames, and each person gets a "main person" score.
//
// The rules (they are the whole mechanism, so the model never has to guess):
//   - one person in the video: that person, whatever their gender
//   - several: the main person of the influencer's gender (main = on screen most of the time, biggest, most central,
//     facing the camera); nobody of that gender: the main person overall
//   - two candidates almost as "main" as each other: still pre-selected, but flagged so the user confirms or picks
//   - a person seen in very few frames (someone walking past) never counts as a candidate
// The pure parts (track, choose, cropBox) are plain functions so the tests can run them in Node.
(function (root) {
  const CDN = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15";
  let ready = null;
  function load() {
    if (ready) return ready;
    ready = new Promise((res, rej) => {
      if (root.faceapi) return res();
      const s = document.createElement("script");
      s.src = CDN + "/dist/face-api.js";
      s.onload = res;
      s.onerror = () => rej(new Error("Could not load the face detector (no internet?)"));
      document.head.append(s);
    }).then(async () => {
      const f = root.faceapi;
      // SSD MobileNet (about 5 MB): slower than the tiny detector but it also finds faces seen from the side
      await f.nets.ssdMobilenetv1.loadFromUri(CDN + "/model");
      await f.nets.ageGenderNet.loadFromUri(CDN + "/model");
      await f.nets.faceLandmark68TinyNet.loadFromUri(CDN + "/model");   // 77 KB: eye points, to find a frame with open eyes
    });
    ready.catch(() => { ready = null; });
    return ready;
  }

  // Bodies: a second small detector (COCO-SSD lite, about 5 MB, on the same TensorFlow face-api already loaded) finds whole
  // people, also those with their back to the camera, who have no face to find. Optional: without it, faces only.
  let bodyNet = null;
  function loadBodies() {
    if (bodyNet) return bodyNet;
    bodyNet = load().then(() => new Promise((res, rej) => {
      if (!root.tf) root.tf = root.faceapi.tf;
      if (root.cocoSsd) return res();
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";
      s.onload = res; s.onerror = () => rej(new Error("body detector did not load"));
      document.head.append(s);
    })).then(() => root.cocoSsd.load({ base: "lite_mobilenet_v2" }));
    bodyNet.catch(() => { bodyNet = null; });
    return bodyNet;
  }
  // a low bar on purpose (a turned-away person scores 0.15 to 0.3): one-off false finds are dropped later, a real person is found in many frames
  async function bodies(net, c, W, H) {
    const ds = await net.detect(c, 10, 0.12);
    return ds.filter((d) => d.class === "person").map((d) => {
      const [x, y, w, h] = d.bbox, x0 = Math.max(0, x / W), y0 = Math.max(0, y / H);
      return { x: x0, y: y0, w: Math.min(1, (x + w) / W) - x0, h: Math.min(1, (y + h) / H) - y0, score: d.score };
    });
  }

  // faces in an image or canvas, with a gender guess: [{x,y,w,h (0..1 of the picture), score, gender, gp}]
  async function faces(img, W, H) {
    const f = root.faceapi;
    const ds = await f.detectAllFaces(img, new f.SsdMobilenetv1Options({ minConfidence: 0.35 })).withFaceLandmarks(true).withAgeAndGender();
    return ds.map((d) => { const b = d.detection.box; return { x: b.x / W, y: b.y / H, w: b.width / W, h: b.height / H, score: d.detection.score, gender: d.gender, gp: d.genderProbability, eyes: eyeOpen(d.landmarks) }; });
  }

  // how open the eyes are: height of each eye over its width (about 0.3 open, under 0.18 closed), the two eyes averaged
  function eyeOpen(lm) {
    try {
      const ear = (p) => (Math.hypot(p[1].x - p[5].x, p[1].y - p[5].y) + Math.hypot(p[2].x - p[4].x, p[2].y - p[4].y)) / (2 * Math.hypot(p[0].x - p[3].x, p[0].y - p[3].y));
      return (ear(lm.getLeftEye()) + ear(lm.getRightEye())) / 2;
    } catch { return null; }
  }
  // The frame the swap model lines the new face up on (PixVerse "keyframe"). The first frame is often a blink or a squint, and
  // the model then keeps the eyes closed for the whole clip; this picks the chosen person's frame with the most open eyes, facing
  // the camera, face large. Returns { t, frame } (frame counted from 1 at the given fps).
  function keyFrame(person, frames, fps = 24) {
    if (!person || !person.dets.length) return null;
    const best = person.dets.reduce((a, d) => (score(d) > score(a) ? d : a), person.dets[0]);
    function score(d) { return (d.eyes == null ? 0.2 : Math.min(d.eyes, 0.4)) * 3 + d.score + d.h * 2; }
    const t = frames[best.i] ? frames[best.i].t : 0;
    return { t, frame: Math.max(1, Math.round(t * fps) + 1), eyes: best.eyes };
  }

  // look through the video: about 24 evenly spaced frames, each with its faces. onStep(done, total, secondsLeft, phase)
  // for a progress line: phase "load" while the detectors download (secondsLeft null), then "scan" with an estimate
  // from how long the frames so far took (before the first one: this browser's last scan, if any).
  const PER_KEY = "vd0.scanPerFrame";
  let warm = false;
  async function scan(src, onStep) {
    if (onStep) onStep(0, 0, null, "load");
    await load();
    const net = await loadBodies().catch(() => null);
    // the detectors' first run is slow (they set themselves up, ~10-15 s); do it here on a blank picture so it counts
    // as loading and the time-left estimate below only sees the real per-frame speed (about 0.25 s a frame)
    if (!warm) { const b = document.createElement("canvas"); b.width = 320; b.height = 240; try { await faces(b, 320, 240); if (net) await bodies(net, b, 320, 240); } catch {} warm = true; }
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = src;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("Could not read the video")); });
    const dur = v.duration || 1, n = Math.max(6, Math.min(24, Math.round(dur * 2)));
    const W = 640, H = Math.round(640 * v.videoHeight / v.videoWidth) || 360;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d");
    const frames = [];
    let last = null; try { last = Number(localStorage.getItem(PER_KEY)) || null; } catch {}
    if (onStep) onStep(0, n, last ? Math.round(last * n) : null, "scan");
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * dur / n;
      await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
      g.drawImage(v, 0, 0, W, H);
      const fs = await faces(c, W, H);
      // a small picture of each face (the biggest one per person is kept later)
      for (const f of fs) f.thumb = faceThumb(c, f, W, H);
      let text = [];
      try { text = textRects(g.getImageData(0, 0, W, H).data, W, H); } catch {}
      frames.push({ t, faces: fs, bodies: net ? await bodies(net, c, W, H).catch(() => []) : [], text });
      const per = (performance.now() - t0) / 1000 / (i + 1);
      if (onStep) onStep(i + 1, n, Math.round(per * (n - i - 1)), "scan");
    }
    try { localStorage.setItem(PER_KEY, String((performance.now() - t0) / 1000 / n)); } catch {}
    const width = v.videoWidth, height = v.videoHeight;   // read before letting the video go: they are 0 afterwards
    v.removeAttribute("src"); v.load();
    return { frames, width, height, duration: dur, bodies: !!net };
  }
  function faceThumb(c, f, W, H) {
    const m = 0.7, x = Math.max(0, (f.x - f.w * m) * W), y = Math.max(0, (f.y - f.h * m) * H);
    const w = Math.min(W - x, f.w * (1 + 2 * m) * W), h = Math.min(H - y, f.h * (1 + 2 * m) * H);
    const t = document.createElement("canvas"); t.width = 160; t.height = Math.round(160 * h / w) || 160;
    t.getContext("2d").drawImage(c, x, y, w, h, 0, 0, t.width, t.height);
    return t.toDataURL("image/jpeg", 0.8);
  }

  // Burned-in captions: bold white or yellow letters with a dark outline. The model redraws everything it is given, which
  // scrambles any caption inside the swapped area, so the server puts the original caption pixels back on top afterwards.
  // This finds where the caption lines are in one frame (RGBA pixels): [{x,y,w,h} 0..1].
  function textRects(px, W, H) {
    const fill = new Uint8Array(W * H), dark = new Uint8Array(W * H);
    for (let i = 0, k = 0; i < W * H; i++, k += 4) {
      const r = px[k], g = px[k + 1], b = px[k + 2];
      if (r + g + b < 150) dark[i] = 1;
      else if ((r > 215 && g > 215 && b > 215 && Math.max(r, g, b) - Math.min(r, g, b) < 40) || (r > 190 && g > 110 && b < 110 && r - b > 110)) fill[i] = 1;
    }
    const D = 4, rows = [];
    for (let y = 0; y < H; y++) {
      let n = 0, edges = 0, x0 = W, x1 = -1, prev = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        // a letter pixel: bright fill with the dark outline a few pixels away
        const on = fill[i] && ((x >= D && dark[i - D]) || (x < W - D && dark[i + D]) || (y >= D && dark[i - D * W]) || (y < H - D && dark[i + D * W])) ? 1 : 0;
        if (on) { n++; if (x < x0) x0 = x; x1 = x; }
        if (on !== prev) edges++;
        prev = on;
      }
      rows.push({ n, edges, x0, x1 });
    }
    // rows with enough letter pixels and many on/off changes (letters, not one white object) make a caption line
    const out = [];
    let y = 0;
    while (y < H) {
      if (rows[y].n < Math.max(6, W * 0.01) || rows[y].edges < 8) { y++; continue; }
      let y1 = y, gap = 0, x0 = W, x1 = 0, edges = 0, cnt = 0;
      for (let k = y; k < H && gap <= 2; k++) {
        if (rows[k].n >= Math.max(3, W * 0.005)) { y1 = k; gap = 0; x0 = Math.min(x0, rows[k].x0); x1 = Math.max(x1, rows[k].x1); edges += rows[k].edges; cnt++; } else gap++;
      }
      const h = y1 - y + 1;
      if (h >= H * 0.01 && h <= H * 0.09 && x1 - x0 >= W * 0.08 && edges / cnt >= 6) {
        const pad = 6, bx = Math.max(0, x0 - pad), by = Math.max(0, y - pad);
        out.push({ x: bx / W, y: by / H, w: (Math.min(W, x1 + pad) - bx) / W, h: (Math.min(H, y1 + pad) - by) / H });
      }
      y = y1 + 3;
    }
    return out;
  }
  // caption lines over the whole clip: the same line in several frames becomes one box over everywhere its text went
  function captionBoxes(frames) {
    const groups = [];
    frames.forEach((fr, i) => (fr.text || []).forEach((r) => {
      const g = groups.find((g) => r.y < g.y + g.h && r.y + r.h > g.y);
      if (g) { const x0 = Math.min(g.x, r.x), y0 = Math.min(g.y, r.y); g.w = Math.max(g.x + g.w, r.x + r.w) - x0; g.h = Math.max(g.y + g.h, r.y + r.h) - y0; g.x = x0; g.y = y0; g.seen.add(i); }
      else groups.push({ ...r, seen: new Set([i]) });
    }));
    const r = (n) => Math.round(n * 1000) / 1000;
    return groups.filter((g) => g.seen.size >= Math.min(2, frames.length) && g.h < 0.2).slice(0, 4).map((g) => ({ x: r(g.x), y: r(g.y), w: r(g.w), h: r(g.h) }));
  }

  // link the faces of each frame into people: the same person is near where they were last seen, at a similar size
  const iou = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / (a.w * a.h + b.w * b.h - w * h);
  };
  function track(frames) {
    let people = [];
    frames.forEach((fr, i) => {
      const used = new Set();
      // the detector sometimes reports one face twice: keep the surest of overlapping boxes
      const fs = [];
      [...fr.faces].sort((a, b) => b.score - a.score).forEach((f) => { if (!fs.some((k) => iou(k, f) > 0.2)) fs.push(f); });
      fs.sort((a, b) => b.h - a.h).forEach((f) => {
        let best = null, bd = Infinity;
        for (const p of people) {
          if (used.has(p) || i - p.lastI > 4) continue;   // gone for more than 4 looks: a new person
          const l = p.dets[p.dets.length - 1];
          const d = Math.hypot(f.x + f.w / 2 - (l.x + l.w / 2), f.y + f.h / 2 - (l.y + l.h / 2));
          const ratio = f.h / l.h;
          if (d < Math.max(f.h, l.h) * 1.5 && ratio > 0.5 && ratio < 2 && d < bd) { bd = d; best = p; }
        }
        if (!best) { best = { id: people.length + 1, dets: [], lastI: i }; people.push(best); }
        used.add(best); best.dets.push({ ...f, i }); best.lastI = i;
      });
    });
    // one person whose track broke (a missed look, a fast turn): a track that starts right where another one ended joins it
    for (let k = 0; k < people.length; k++) {
      for (let m = 0; m < people.length; m++) {
        const a = people[k], b = people[m];
        if (a === b || !a.dets.length || !b.dets.length) continue;
        const ae = a.dets[a.dets.length - 1], bs = b.dets[0];
        const overlap = b.dets.filter((d) => a.dets.some((x) => x.i === d.i)).length;
        const near = Math.hypot(ae.x + ae.w / 2 - (bs.x + bs.w / 2), ae.y + ae.h / 2 - (bs.y + bs.h / 2)) < Math.max(ae.h, bs.h) * 2;
        if (bs.i >= ae.i - 1 && bs.i - ae.i <= 6 && overlap <= 1 && near) {
          a.dets = [...a.dets, ...b.dets.filter((d) => !a.dets.some((x) => x.i === d.i))]; b.dets = [];
        }
      }
    }
    people = people.filter((p) => p.dets.length);
    const N = Math.max(1, frames.length);
    const maxH = Math.max(1e-6, ...people.map((p) => avg(p.dets.map((d) => d.h))));
    for (const p of people) {
      p.presence = p.dets.length / N;
      p.size = avg(p.dets.map((d) => d.h)) / maxH;
      p.centrality = Math.max(0, 1 - 2 * avg(p.dets.map((d) => Math.abs(d.x + d.w / 2 - 0.5))));
      p.facing = avg(p.dets.map((d) => d.score));         // the detector is surest about faces turned to the camera
      const vote = p.dets.reduce((a, d) => a + (d.gender === "female" ? 1 : -1) * (d.gp || 0.5), 0);
      p.gender = vote > 0 ? "female" : "male";
      p.genderSure = Math.min(1, Math.abs(vote) / p.dets.length);
      p.score = 0.4 * p.presence + 0.3 * p.size + 0.15 * p.centrality + 0.15 * p.facing;
      const big = p.dets.reduce((a, d) => (d.h > a.h ? d : a), p.dets[0]);
      p.thumb = big.thumb || null;
      delete p.lastI;
    }
    return people.sort((a, b) => b.score - a.score).map((p, k) => Object.assign(p, { label: "Person " + String.fromCharCode(65 + k) }));
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  // A face seen from the side often gets a different gender guess in every frame. For each person whose votes disagree, ask
  // once: ask(picture) -> "female" | "male" | null (the page sends it to a vision model, a fraction of a cent each).
  async function checkGenders(people, ask) {
    for (const p of people) {
      if (p.genderSure >= 0.6 || !p.thumb || !(p.presence >= 0.2 || p.dets.length >= 3)) continue;
      try { const g = await ask(p.thumb); if (g === "female" || g === "male") { p.gender = g; p.genderSure = 0.9; p.genderBy = "look"; } } catch {}
    }
    return people;
  }

  // which person to swap, by the rules at the top. gender: the influencer's ("female" | "male" | null)
  function choose(people, gender) {
    if (!people.length) return { pick: null, reason: "No face found in the video. The whole video is sent and the model chooses.", ambiguous: false };
    const real = people.filter((p) => p.presence >= 0.2 || p.dets.length >= 3);
    const cands = real.length ? real : people;
    if (cands.length === 1) return { pick: cands[0], reason: "Only one person in the video.", ambiguous: false };
    const same = gender ? cands.filter((p) => p.gender === gender) : [];
    const pool = same.length ? same : cands;
    const [a, b] = pool;
    const who = gender === "female" ? "woman" : gender === "male" ? "man" : "person";
    const reason = same.length ? `The main ${who} in the video (your influencer is a ${who}).` : gender ? `No ${who} in the video, so the main person.` : "The main person in the video.";
    return { pick: a, reason, ambiguous: !!b && b.score >= 0.85 * a.score };
  }

  // the part of the frame to send: the chosen person from a little above the head down to the bottom of the body,
  // over everywhere they move during the clip. Values are 0..1 of the frame. null = no cut needed (the person fills the frame).
  // It is cut even when only one face was found: someone with their back to the camera has no face to find, but is still
  // a person the model could pick.
  function cropBox(person, people, width, height) {
    if (!person) return null;
    const d = person.dets, fw = med(d.map((x) => x.w)), fh = med(d.map((x) => x.h));
    let x0 = Math.min(...d.map((x) => x.x)) - fw * 1.1, x1 = Math.max(...d.map((x) => x.x + x.w)) + fw * 1.1;   // shoulders: about a face width each side
    let y0 = Math.min(...d.map((x) => x.y)) - fh * 0.8, y1 = Math.max(...d.map((x) => x.y + x.h)) + fh * 4.5;   // down to about the waist
    // keep the shape between 9:16 and 16:9 (in pixels): grow the short side around the middle
    const ar = width / height;
    const grow = (a0, a1, want) => { const m = (a0 + a1) / 2; return [m - want / 2, m + want / 2]; };
    if ((x1 - x0) * ar < (y1 - y0) * 9 / 16) [x0, x1] = grow(x0, x1, (y1 - y0) * 9 / 16 / ar);
    if ((y1 - y0) < (x1 - x0) * ar * 9 / 16) [y0, y1] = grow(y0, y1, (x1 - x0) * ar * 9 / 16);
    // inside the frame (slide back in first, then cut)
    const fit = (a0, a1) => { if (a0 < 0) { a1 -= a0; a0 = 0; } if (a1 > 1) { a0 -= a1 - 1; a1 = 1; } return [Math.max(0, a0), Math.min(1, a1)]; };
    [x0, x1] = fit(x0, x1); [y0, y1] = fit(y0, y1);
    if ((x1 - x0) * (y1 - y0) > 0.8) return null;           // nearly the whole frame anyway
    const r = (n) => Math.round(n * 1000) / 1000;
    return { x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0) };
  }
  // Everyone who is NOT the chosen person, as boxes (0..1 of the frame) over everywhere they are during the clip. The page
  // sends these with the swap: the server covers them in the clip the model sees (so the model sees one person only) and
  // keeps the original pixels there when the result is pasted back.
  function hideBoxes(pick, people, frames) {
    if (!pick || !frames || !frames.length) return [];
    const N = frames.length, pf = new Map(pick.dets.map((d) => [d.i, d]));
    // bodies linked across frames (same way as faces, by overlap)
    const tracks = [];
    frames.forEach((fr, i) => {
      const used = new Set();
      [...(fr.bodies || [])].sort((a, b) => b.score - a.score).forEach((b) => {
        let best = null, bo = 0.3;
        for (const t of tracks) { if (used.has(t) || i - t.last > 4) continue; const o = iou(t.boxes[t.boxes.length - 1], b); if (o > bo) { bo = o; best = t; } }
        if (!best) { best = { boxes: [], last: i, own: 0 }; tracks.push(best); }
        used.add(best); best.boxes.push({ ...b, i }); best.last = i;
        // the chosen person's body: their face sits in its top half
        const f = pf.get(i);
        if (f) { const cx = f.x + f.w / 2, cy = f.y + f.h / 2; if (cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h * 0.6) best.own++; }
      });
    });
    const others = tracks.filter((t) => t.own < Math.max(1, t.boxes.length * 0.3) && (t.boxes.length >= N * 0.35 || t.boxes.some((b) => b.score >= 0.5)))
      .map((t) => union(t.boxes));
    // people whose face was found but who are not the chosen one: their face plus where their body would be
    for (const p of people) {
      if (p === pick || !(p.presence >= 0.2 || p.dets.length >= 3)) continue;
      const u = union(p.dets);
      others.push({ x: u.x - u.w, y: u.y - u.h * 0.5, w: u.w * 3, h: u.h * 7 });
    }
    // never cover the chosen person: cut each box back to the side away from their face, leaving half a face width of room (more would uncover people standing close)
    const f = union(pick.dets), m = med(pick.dets.map((d) => d.w)) * 0.5, core = { x0: f.x - m, x1: f.x + f.w + m };
    const out = [];
    // the chosen person's whole body (arms included) over the clip, when the body detector found it: in the rows of their body a
    // cover stops at its edge, above and below it the cover keeps its full width (a covered arm would come back as the old arm)
    const ownTracks = tracks.filter((t) => t.own >= Math.max(1, t.boxes.length * 0.3)), T = ownTracks.length ? union(ownTracks.flatMap((t) => t.boxes)) : null;
    const pieces = [];
    for (const b of others) {
      if (!T || b.x + b.w <= T.x || b.x >= T.x + T.w || b.y + b.h <= T.y || b.y >= T.y + T.h) { pieces.push(b); continue; }
      const top = T.y, bot = T.y + T.h;
      if (b.y < top) pieces.push({ x: b.x, y: b.y, w: b.w, h: top - b.y });
      const my0 = Math.max(b.y, top), my1 = Math.min(b.y + b.h, bot);
      if (b.x < T.x) pieces.push({ x: b.x, y: my0, w: T.x - b.x, h: my1 - my0 });
      else if (b.x + b.w > T.x + T.w) pieces.push({ x: T.x + T.w, y: my0, w: b.x + b.w - T.x - T.w, h: my1 - my0 });
      if (b.y + b.h > bot) pieces.push({ x: b.x, y: bot, w: b.w, h: b.y + b.h - bot });
    }
    for (let b of pieces) {
      let x0 = Math.max(0, b.x), x1 = Math.min(1, b.x + b.w);
      const y0 = Math.max(0, b.y), y1 = Math.min(1, b.y + b.h);
      if (x0 < core.x1 && x1 > core.x0) { const left = core.x0 - x0, right = x1 - core.x1; if (left >= right) x1 = core.x0; else x0 = core.x1; }
      if (x1 - x0 < 0.03 || y1 - y0 < 0.03) continue;
      const r = (n) => Math.round(n * 1000) / 1000;
      out.push({ x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0) });
    }
    return out.slice(0, 6);
  }
  const union = (bs) => { const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y)); return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 }; };
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

  // the influencer's gender: their description first, else the detector on their picture
  async function genderOf(desc, imgUrl) {
    const t = String(desc || "").toLowerCase();
    const f = /\b(woman|girl|female|lady|she|her)\b/.test(t), m = /\b(man|boy|male|guy|he|his)\b/.test(t);
    if (f !== m) return f ? "female" : "male";
    if (!imgUrl) return null;
    try {
      await load();
      // a load event, not im.decode(): decode() can wait forever while the tab is in the background
      const im = new Image();
      await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("picture timeout")), 10000); im.onload = () => { clearTimeout(t); res(); }; im.onerror = () => { clearTimeout(t); rej(new Error("picture")); }; im.src = imgUrl; });
      const fs = await faces(im, im.naturalWidth, im.naturalHeight);
      return fs.length ? fs.sort((a, b) => b.h - a.h)[0].gender : null;
    } catch { return null; }
  }

  const api = { load, loadBodies, scan, track, checkGenders, choose, cropBox, hideBoxes, textRects, captionBoxes, keyFrame, genderOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.people = api;
})(typeof window !== "undefined" ? window : globalThis);
