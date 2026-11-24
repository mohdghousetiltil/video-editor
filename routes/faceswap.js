// Face swap from video (Poses & motion page, "Face swap" tab).
//
//   1. POST /api/swap/source   the user's video is cut to 15 s, shrunk to 720p and kept (with its sound) in work/swap/<token>.mp4
//   2. POST /api/swap          the video + a face picture (a saved influencer or an uploaded picture) go to a fal.ai video model that
//                              puts that person in place of the person in the video. The job is an ordinary external job (fal_...), so
//                              /api/jobs/<id>, /api/video/<id>, the spend log and History handle it like any other clip.
//
// Rules built in (this feature can be misused, so they are part of the mechanism, not an afterthought):
//   - the request must say the face is the user's own or used with the person's permission, and that the video may be used (consent:true)
//   - the provider's safety checkers are switched ON for the input and the output
//   - the monthly cap, the daily / weekly video limits and the confirm-spend dialog apply like for any video
//   - History records every swap as kind "swap" with the consent flag, and the output is never published anywhere by this app
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// engines: what each fal.ai model does, what it costs and what it keeps
const ENGINES = {
  pixverse: { app: "fal-ai/pixverse/swap", name: "PixVerse Swap", perSec: () => Number(process.env.SWAP_PIXVERSE_PRICE || 0.05), keepsSound: true,   // measured: billed per second of video, not per video
    // keyframe_id: the frame the new face is lined up on; the page picks one with the person's eyes open (frame 1 is often a blink)
    input: (v, f, o = {}) => ({ video_url: v, image_url: f, mode: "person", resolution: "720p", original_sound_switch: true, keyframe_id: o.keyframe || 1, enable_safety_checker: true }) },
  wan: { app: "fal-ai/wan/v2.2-14b/animate/replace", name: "Wan Animate Replace", perSec: () => Number(process.env.SWAP_WAN_PRICE || 0.08), keepsSound: false,
    input: (v, f) => ({ video_url: v, image_url: f, resolution: "720p", video_quality: "high", enable_safety_checker: true, enable_output_safety_checker: true }) },
};
const estimate = (engine, secs) => { const e = ENGINES[engine]; return +(e.flat ? e.flat() : e.perSec() * Math.max(1, Math.ceil(secs))).toFixed(3); };

// Voice: the swapped person should sound like the new character, not like the person in the original video. It is the SAME voice (same
// words, timing, breathing, so the lips still match), with its pitch moved up for a woman or down for a man. Free: ffmpeg only, no model, no fee.
// Where the pitch lands comes from the influencer, inside a natural range, so the same influencer always sounds the same.
// "Real voice": a speech-to-speech voice changer (ElevenLabs on fal.ai). Same words, timing and feeling, but an actual woman's or man's voice, the
// same one every time for the same character. It costs about 0.3 dollars a minute (about 0.02 for a 4 second clip); nothing is generated from text.
const VOICES = {
  female: ["Rachel", "Bella", "Domi", "Elli", "Sarah", "Charlotte", "Alice", "Matilda", "Jessica", "Lily"],
  male: ["Adam", "Antoni", "Josh", "Arnold", "Sam", "Daniel", "Brian", "George", "Charlie", "Will"],
};
const VOICE_PER_MIN = () => Number(process.env.SWAP_VOICE_PRICE || 0.3);
// A character keeps ONE voice: the choice comes from a number made from the influencer (or the face picture), so every
// video of the same influencer gets the same voice and the same pitch, and a different influencer gets a different one.
function seededRnd(key) {
  let h = 2166136261;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return (h >>> 8) / 16777216; };
}
const pickVoice = (gender, rnd = Math.random) => { const pool = VOICES[gender] || VOICES.female; return pool[Math.floor(rnd() * pool.length)]; };
const voiceCostFor = (secs) => +(VOICE_PER_MIN() * Math.max(secs, 1) / 60).toFixed(4);

const RANGE_HZ = { female: [185, 230], male: [105, 138] };   // typical speaking pitch of the target voice
const MAX_SEMITONES = 8;                                      // further than this stops sounding like a person
const median = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
// speaking pitch (Hz) of 16 kHz mono signed 16-bit audio: the median over the loud frames; null when nothing voiced
function estimateF0(pcm) {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), FR = 640, hits = [];
  for (let st = 0; st + FR * 2 <= s.length; st += FR) {
    let e = 0; for (let i = 0; i < FR; i++) e += s[st + i] * s[st + i];
    if (e / FR < 4e5) continue;                               // quiet frame
    let bl = 0, bv = 0, e0 = 0; for (let i = 0; i < FR; i += 2) e0 += s[st + i] * s[st + i];
    for (let lag = 40; lag < 320; lag++) { let c = 0; for (let i = 0; i + lag < FR; i += 2) c += s[st + i] * s[st + i + lag]; if (c > bv) { bv = c; bl = lag; } }
    if (bl && bv > 0.35 * e0) hits.push(16000 / bl);          // clearly periodic = voiced
  }
  return hits.length >= 5 ? median(hits) : null;
}
// how many semitones to move a voice at srcHz so it lands in the target gender's range (0 = leave it); jitter makes each run different
function pitchShift(srcHz, gender, rnd = Math.random) {
  const [lo, hi] = RANGE_HZ[gender] || RANGE_HZ.female, target = lo + rnd() * (hi - lo);
  // use 80 to 100 percent of the move, so two videos never get the same pitch even when the move is at its limit
  const k = 0.8 + 0.2 * rnd();
  if (!srcHz) return (gender === "male" ? -5 : 6) * k;                                      // unknown voice: a typical shift
  return Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, 12 * Math.log2(target / srcHz))) * k;
}
// the audio filter: rubberband (pitch and formants move together, which is what makes it read as another person); asetrate when it is missing
const pitchFilter = (st, hasRubberband = true) => {
  const r = Math.pow(2, st / 12);
  return hasRubberband ? `rubberband=pitch=${r.toFixed(4)}:formant=shifted:transients=smooth` : `asetrate=44100*${r.toFixed(4)},aresample=44100,atempo=${(1 / r).toFixed(4)}`;
};
// "female" / "male" from the influencer's description, else null
const genderFromText = (t) => { t = String(t || "").toLowerCase(); const f = /\b(woman|girl|female|lady|she|her|feminine)\b/.test(t), m = /\b(man|boy|male|guy|he|his|masculine)\b/.test(t); return f && !m ? "female" : m && !f ? "male" : null; };

// The person to swap, as a box in the frame (0..1, chosen on the page). Only that part of the video goes to the model, so the
// model sees one person and cannot pick the wrong one; the result is pasted back over the original with a soft edge.
// Returns pixel numbers (even, as x264 needs) or null when the box is missing or not sensible.
function cropPixels(c, W, H) {
  if (!c || typeof c !== "object" || !W || !H) return null;
  const n = ["x", "y", "w", "h"].map((k) => Number(c[k]));
  if (n.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  const [x, y, w, h] = n;
  if (w < 0.15 || h < 0.15 || x + w > 1.001 || y + h > 1.001) return null;
  const ev = (v) => Math.max(0, Math.floor(v / 2) * 2);
  const px = { x: ev(x * W), y: ev(y * H), w: ev(w * W), h: ev(h * H) };
  px.w = Math.min(px.w, ev(W - px.x)); px.h = Math.min(px.h, ev(H - px.y));
  return px.w >= 64 && px.h >= 64 ? px : null;
}
// Size of the cut-out sent to the model: short side 720 (enough pixels for a face), but never past 1920 on the long side
// (PixVerse refuses anything larger) and never below 360 on the short side. Even numbers, as x264 needs.
function cutScale(w, h) {
  const short = Math.min(w, h), long = Math.max(w, h);
  const k = Math.max(360 / short, Math.min(720 / short, 1920 / long));
  const ev = (v) => Math.max(2, Math.round((v * k) / 2) * 2);
  return `scale=${ev(w)}:${ev(h)}`;
}
// The other people (boxes 0..1 of the frame, found on the page) to cover in the clip the model sees. Pixels, at most 6.
function hidePixels(list, W, H) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 6).map((c) => {
    const n = ["x", "y", "w", "h"].map((k) => Number(c && c[k]));
    if (n.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
    const x = Math.round(n[0] * W), y = Math.round(n[1] * H), w = Math.min(W - x, Math.round(n[2] * W)), h = Math.min(H - y, Math.round(n[3] * H));
    return w >= 8 && h >= 8 ? { x, y, w, h } : null;
  }).filter(Boolean);
}
// the ffmpeg filter that pastes the swapped clip (input 1) back into the original (input 0) at the box, with a feathered edge
// on the sides that are inside the frame (an edge that touches the frame border stays hard, nothing to blend there).
// hide: the covered people (frame pixels); the original stays there, the model only saw a grey box. The hole is drawn at its
// exact size AFTER the wide soft edge of the swap area is made, with only a narrow soft edge of its own (a few pixels): a wide one
// shows a see-through ghost of what the model drew there over the covered person.
// Captions: inside each caption box (frame pixels), the original's letter pixels (the bright fill, grown by 4 px to take the
// dark outline too) are put back on top, so burned-in subtitles read exactly as before instead of being redrawn.
const LETTER = (() => {
  // bright caption colours: near-white, or yellow / orange. Inside a caption box only, so a white thing in the scene there is
  // simply the original background coming back, which is what was there anyway.
  const F = `(gt(r(X,Y),185)*gt(g(X,Y),185)*gt(b(X,Y),185)+gt(r(X,Y),170)*gt(g(X,Y),90)*lt(b(X,Y),120)*gt(r(X,Y)-b(X,Y),90))`;
  return `255*gt(${F},0)`;
})();
function captionStage(boxes, inLabel, origLabels, outLabel) {
  return boxes.map((t, k) => {
    const from = k ? `c${k}` : inLabel, to = k === boxes.length - 1 ? outLabel : `c${k + 1}`;
    return `[${origLabels[k]}]crop=${t.w}:${t.h}:${t.x}:${t.y},format=gbrp,split[tc${k}][tq${k}];` +
      `[tq${k}]geq=r='${LETTER}':g='${LETTER}':b='${LETTER}',format=gray,dilation,dilation,dilation,dilation,gblur=sigma=0.8[tm${k}];` +
      `[tc${k}][tm${k}]alphamerge[ta${k}];[${from}][ta${k}]overlay=${t.x}:${t.y}[${to}]`;
  }).join(";");
}
function pasteFilter(b, W, H, fps = 24, hide = [], text = []) {
  const F = Math.max(4, Math.round(Math.min(b.w, b.h) * 0.06));
  const L = b.x > 0 ? F : 0, T = b.y > 0 ? F : 0, R = b.x + b.w < W ? F : 0, B = b.y + b.h < H ? F : 0;
  const holes = hide.map((r) => ({ x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h })).filter((r) => r.x < b.w && r.y < b.h && r.x + r.w > 0 && r.y + r.h > 0)
    .map((r) => `,drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=black:t=fill`).join("");
  return `[1:v]fps=${fps},scale=${b.w}:${b.h},setsar=1,format=yuva420p[s];` +
    `color=c=black:s=${b.w}x${b.h}:r=${fps},format=gray,drawbox=x=${L}:y=${T}:w=${b.w - L - R}:h=${b.h - T - B}:color=white:t=fill,boxblur=${Math.max(1, Math.floor(F / 2))}:2${holes}${holes ? ",gblur=sigma=2.5" : ""}[m];` +
    (text.length
      ? `[0:v]split=${text.length + 1}[base]${text.map((_, k) => `[o${k}]`).join("")};[s][m]alphamerge[sa];[base][sa]overlay=${b.x}:${b.y}:shortest=1:format=auto[comp];` +
        captionStage(text, "comp", text.map((_, k) => `o${k}`), "capt") + `;[capt]format=yuv420p[v]`
      : `[s][m]alphamerge[sa];[0:v][sa]overlay=${b.x}:${b.y}:shortest=1:format=auto,format=yuv420p[v]`);
}

module.exports = function swapRoutes(ctx) {
  const { spawn } = require("child_process");
  const { STORE, API, send, readBody, run, spend, serveMp4, mediaDuration, history, jobs, imgFile, viewFile, frameToJpeg, providers, fetchLink, FFMPEG, orFetch, orHeaders, ensureVideo, readInf, hasAudio } = ctx;
  const genderCache = new Map();
  // who is speaking now: the influencer's description first, else a quick look at the picture (a fraction of a cent)
  async function faceGender(influencerId, faceDataUrl) {
    const key = influencerId || String(faceDataUrl).slice(-64);
    if (genderCache.has(key)) return genderCache.get(key);
    let g = null;
    try { const inf = influencerId && readInf().find((x) => x.id === influencerId); g = genderFromText(inf && (inf.gender || inf.desc)); } catch {}
    if (!g) {
      try {
        const r = await orFetch(`${API}/chat/completions`, { method: "POST", headers: orHeaders(), body: JSON.stringify({ model: process.env.DESCRIBE_MODEL || "nvidia/nemotron-3.5-super-vl", max_tokens: 20, reasoning: { enabled: false },
          messages: [{ role: "user", content: [{ type: "text", text: "Does the person in this picture present as female or male? Answer with exactly one word: female or male." }, { type: "image_url", image_url: { url: faceDataUrl } }] }] }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) { spend.log("Face swap", j.usage?.cost, "face-gender"); g = /\bmale\b/i.test(j.choices?.[0]?.message?.content || "") && !/female/i.test(j.choices?.[0]?.message?.content || "") ? "male" : "female"; }
      } catch {}
    }
    g = g || "female";
    genderCache.set(key, g);
    return g;
  }
  const DIR = path.join(STORE, "work", "swap");
  fs.mkdirSync(DIR, { recursive: true });
  const MAX_UPLOAD = 100 * 1024 * 1024, MAX_VIDEO_FILE = 24 * 1024 * 1024; // the file travels to fal.ai inside the request
  const file = (t) => path.join(DIR, t + ".mp4");
  // width x height of a video, from ffmpeg's description of it
  const videoDims = (f) => new Promise((resolve) => {
    const pr = spawn(FFMPEG, ["-hide_banner", "-i", f]); let err = "";
    pr.stderr.on("data", (d) => (err += d)); pr.on("error", () => resolve(null));
    pr.on("close", () => { const m = err.match(/Video:.*?, (\d{2,5})x(\d{2,5})/); resolve(m ? { W: +m[1], H: +m[2] } : null); });
  });
  const dataUrlOf = (f) => `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");

  const handle = async function handle(req, res, url) {
    let m;
    // info for the page: which engines exist, what they cost, whether fal.ai is set up
    // Face swap page: is the person in this small picture a woman or a man? (only for people whose face the detector was unsure about)
    if (req.method === "POST" && url.pathname === "/api/swap/gender") {
      const b = await readBody(req);
      if (typeof b.image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(b.image) || b.image.length > 400000) return send(res, 400, { error: "Send a small picture." }), true;
      try {
        const r = await orFetch(`${API}/chat/completions`, { method: "POST", headers: orHeaders(), body: JSON.stringify({ model: process.env.DESCRIBE_MODEL || "nvidia/nemotron-3.5-super-vl", max_tokens: 20, reasoning: { enabled: false },
          messages: [{ role: "user", content: [{ type: "text", text: "Does the person in this picture present as female or male? Answer with exactly one word: female or male." }, { type: "image_url", image_url: { url: b.image } }] }] }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return send(res, 502, { error: j.error?.message || "check failed" }), true;
        spend.log("Face swap", j.usage?.cost, "who-is-who");
        const t = String(j.choices?.[0]?.message?.content || "").toLowerCase();
        return send(res, 200, { gender: /female|woman/.test(t) ? "female" : /\bmale\b|\bman\b/.test(t) ? "male" : null }), true;
      } catch (e) { return send(res, 502, { error: e.message }), true; }
    }
    if (req.method === "GET" && url.pathname === "/api/swap/engines") {
      return send(res, 200, { ready: !!providers.configured().fal, engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, keepsSound: e.keepsSound, price: e.flat ? { flat: e.flat() } : { perSecond: e.perSec() } })) }), true;
    }
    // the video: an upload, or a link (Instagram, X, TikTok, YouTube, a direct MP4 ...) that the server fetches itself
    if (req.method === "POST" && (url.pathname === "/api/swap/source" || url.pathname === "/api/swap/link")) {
      const token = crypto.randomBytes(12).toString("hex");
      let raw = path.join(DIR, token + ".src"), dl = null;
      if (url.pathname === "/api/swap/link") {
        const b = await readBody(req);
        dl = path.join(DIR, "dl-" + token);
        try { raw = await fetchLink(b.url, dl, { maxMb: 150, ffmpeg: FFMPEG }); } catch (e) { fs.rm(dl, { recursive: true, force: true }, () => {}); return send(res, e.status || 400, { error: String(e.message).slice(-300) }), true; }
      } else {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) return send(res, 413, { error: "Video too large (max 100 MB)." }), true; chunks.push(c); }
        if (!size) return send(res, 400, { error: "Empty upload." }), true;
        fs.writeFileSync(raw, Buffer.concat(chunks));
      }
      const cleanup = () => { if (dl) fs.rm(dl, { recursive: true, force: true }, () => {}); else fs.unlink(raw, () => {}); };
      try {
        // first 15 s, short side at most 720 px, the sound is kept (PixVerse hands it back), a size small enough to send inline
        await run(["-y", "-i", raw, "-t", "15", "-vf", "scale='if(lt(iw,ih),min(iw,720),-2)':'if(lt(iw,ih),-2,min(ih,720))',fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", file(token)], DIR);
      } catch (e) { cleanup(); return send(res, 400, { error: "Couldn't read that video: " + String(e.message).slice(-160) }), true; }
      cleanup();
      if (fs.statSync(file(token)).size > MAX_VIDEO_FILE) { fs.unlink(file(token), () => {}); return send(res, 413, { error: "That video is too heavy even after shrinking it. Try a shorter one." }), true; }
      return send(res, 200, { token, duration: await mediaDuration(file(token)), previewUrl: `/api/swap/source/${token}.mp4` }), true;
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/swap\/source\/([a-f0-9]{24})\.mp4$/))) return serveMp4(req, res, file(m[1])), true;

    if (req.method === "POST" && url.pathname === "/api/swap") {
      const b = await readBody(req);
      if (!providers.configured().fal) return send(res, 400, { error: "Face swap runs on fal.ai: add FAL_KEY on the server first." }), true;
      if (b.consent !== true) return send(res, 400, { error: "Confirm first that the face is yours (or you have that person's permission) and that you may use this video." }), true;
      const engine = ENGINES[b.engine] ? b.engine : "pixverse", E = ENGINES[engine];
      if (!/^[a-f0-9]{24}$/.test(b.token || "") || !fs.existsSync(file(b.token))) return send(res, 400, { error: "Upload the video first." }), true;
      // the face picture: a saved influencer, or an uploaded picture
      let face = null;
      // both engines replace the whole person, so the full-body profile (when made) shows them far better than a head-and-shoulders picture
      if (/^[\w-]+$/.test(b.influencer_id || "") && imgFile(b.influencer_id)) face = dataUrlOf((viewFile && viewFile(b.influencer_id, "full")) || imgFile(b.influencer_id));
      else if (typeof b.face === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.face) && b.face.length < 12e6) face = b.face;
      if (!face) return send(res, 400, { error: "Choose a saved influencer with a picture, or upload a clear face picture." }), true;
      const secs = await mediaDuration(file(b.token));
      // voice: "auto" (match the character, the same voice every time for the same influencer), "female", "male", or "keep" (the original voice)
      const voiceMode = ["real", "auto", "female", "male", "keep"].includes(b.voice) ? b.voice : "real";
      const hasSound = await hasAudio(file(b.token)).catch(() => false);
      let voicePlan = null, voiceCost = 0;
      const voiceKey = b.influencer_id && /^[\w-]+$/.test(b.influencer_id) ? "inf:" + b.influencer_id : "pic:" + crypto.createHash("sha1").update(face).digest("hex");
      if (hasSound && voiceMode === "real") {
        const gender = await faceGender(b.influencer_id, face);
        voicePlan = { mode: "real", gender, voice: pickVoice(gender, seededRnd(voiceKey)), source: file(b.token), seconds: secs };
        voiceCost = voiceCostFor(secs);
      } else if (hasSound && voiceMode !== "keep") {
        const gender = voiceMode === "auto" ? await faceGender(b.influencer_id, face) : voiceMode;
        voicePlan = { mode: "pitch", gender, key: voiceKey, source: file(b.token), seconds: secs };   // the pitch itself is worked out when the clip is ready
      } else if (hasSound && !E.keepsSound) voicePlan = { mode: "restore", source: file(b.token), seconds: secs }; // Wan returns silence: put the original sound back
      const est = estimate(engine, secs) + voiceCost;
      const lim = spend.videoBlock(est, 0);
      if (lim) return send(res, 429, { error: lim, limit: true }), true;
      // the chosen person: cut their part out of the video (scaled up so the model gets enough pixels), the rest stays as it is
      let crop = null, sendFile = file(b.token);
      if (b.crop || (Array.isArray(b.hide) && b.hide.length)) {
        const dims = await videoDims(file(b.token)), px = dims && cropPixels(b.crop || { x: 0, y: 0, w: 1, h: 1 }, dims.W, dims.H);
        const hide = dims ? hidePixels(b.hide, dims.W, dims.H) : [], text = dims ? hidePixels(b.text, dims.W, dims.H).slice(0, 4) : [];
        if (px) {
          const cut = path.join(DIR, b.token + ".crop-" + crypto.randomBytes(4).toString("hex") + ".mp4");
          const scale = cutScale(px.w, px.h);
          try {
            // everyone else is covered with plain grey first, so the model sees one person only
            const cover = hide.map((r) => `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=0x808080:t=fill,`).join("");
            await run(["-y", "-i", file(b.token), "-vf", `${cover}crop=${px.w}:${px.h}:${px.x}:${px.y},${scale},setsar=1,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", cut], DIR);
            crop = { ...px, W: dims.W, H: dims.H, hide, text, source: file(b.token) }; sendFile = cut;
          } catch (e) { console.error("face swap crop:", e.message); } // the whole video is sent instead
        }
      }
      let out;
      try {
        face = await frameToJpeg(face); // the models take JPEG or PNG
        // both files go to fal.ai's storage first: its models download them by link
        const [video, faceUrl] = await Promise.all([
          providers.falUpload(fs.readFileSync(sendFile), "video/mp4", "source.mp4"),
          providers.falUpload(Buffer.from(face.split(",")[1], "base64"), face.slice(5, face.indexOf(";")), "face." + (face.includes("png") ? "png" : "jpg")),
        ]);
        const keyframe = Number.isInteger(b.keyframe) && b.keyframe >= 1 && b.keyframe <= Math.ceil(secs * 24) ? b.keyframe : 1;
        out = await providers.submitFalApp(E.app, E.input(video, faceUrl, { keyframe }));
      } catch (e) { return send(res, e.status || 502, { error: `${E.name} refused the job: ${String(e.message).slice(0, 200)}` }), true; }
      finally { if (sendFile !== file(b.token)) fs.unlink(sendFile, () => {}); }
      jobs.set(out.id, { startedAt: Date.now(), status: "pending", model: E.app, feature: "Face swap", ...out.job, ...(voicePlan ? { voicePlan } : {}), ...(crop ? { crop } : {}), swapVideoCost: estimate(engine, secs), estimate: est });
      history.put(out.id, { kind: "swap", title: String(b.title || "Face swap").slice(0, 140), model: E.app, duration: Math.round(secs), status: "pending", provider: "fal",
        url: `/api/video/${out.id}`, thumb: `/api/video/${out.id}/thumb.jpg`, consent: true });
      return send(res, 202, { id: out.id, engine: E.name, estimate: est, cropped: !!crop, keepsSound: E.keepsSound, voice: voicePlan ? (voicePlan.mode === "real" ? `a real ${voicePlan.gender === "male" ? "man's" : "woman's"} voice (${voicePlan.voice})` : voicePlan.mode === "pitch" ? `the original voice, pitch moved for a ${voicePlan.gender === "male" ? "man" : "woman"} (free)` : "original sound") : "no sound", voiceCost }), true;
    }
    return false;
  };
  // After the swap is ready: give it the right voice (or put the original sound back). Called once from /api/jobs; the job stays "in progress" meanwhile.
  handle.finish = async (id, job) => {
    // 1. the model only saw the chosen person: put its result back into the full original frame
    const c = job.crop;
    if (c && !job.cropDone && fs.existsSync(c.source)) {
      const vid = await ensureVideo(id), tmp = vid + ".paste.mp4";
      try {
        await run(["-y", "-i", c.source, "-i", vid, "-filter_complex", pasteFilter(c, c.W, c.H, 24, c.hide || [], c.text || []), "-map", "[v]", "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp], path.dirname(vid));
        fs.renameSync(tmp, vid);
      } catch (e) { fs.unlink(tmp, () => {}); console.error("face swap paste-back:", e.message); }
      job.cropDone = true;
    }
    // 2. the voice
    const p = job.voicePlan;
    if (!p || !fs.existsSync(p.source)) return;
    const vid = await ensureVideo(id), dir = path.dirname(vid), tmpA = path.join(dir, id + ".src.m4a"), tmpV = path.join(dir, id + ".voice.m4a"), out = vid + ".voice.mp4";
    const pcm = () => new Promise((resolve) => {
      const chunks = [], pr = spawn(FFMPEG, ["-v", "error", "-i", p.source, "-vn", "-t", String(Math.max(1, p.seconds)), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
      pr.stdout.on("data", (d) => chunks.push(d)); pr.on("error", () => resolve(Buffer.alloc(0))); pr.on("close", () => resolve(Buffer.concat(chunks)));
    });
    try {
      await run(["-y", "-i", p.source, "-vn", "-t", String(Math.max(1, p.seconds)), "-c:a", "aac", "-b:a", "128k", tmpA], dir);
      let audio = tmpA;
      if (p.mode === "real") {
        const url = await providers.falUpload(fs.readFileSync(tmpA), "audio/mp4", "speech.m4a");
        const r = await fetch("https://fal.run/fal-ai/elevenlabs/voice-changer", { method: "POST", headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ audio_url: url, voice: p.voice, remove_background_noise: true, model_id: "eleven_multilingual_sts_v2", output_format: "mp3_44100_128" }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.audio?.url) throw new Error(j.detail?.[0]?.msg || j.detail || j.error || `voice changer error ${r.status}`);
        const a = await fetch(j.audio.url); fs.writeFileSync(tmpV, Buffer.from(await a.arrayBuffer())); audio = tmpV;
        spend.log("Face swap voice", voiceCostFor(p.seconds), "elevenlabs/voice-changer", id + "-voice", "fal", "other");
        job.voiceNote = `real ${p.gender} voice (${p.voice})`;
      } else if (p.mode === "pitch") {
        const f0 = estimateF0(await pcm()), st = pitchShift(f0, p.gender, p.key ? seededRnd(p.key) : Math.random);
        job.voiceNote = `${f0 ? Math.round(f0) + " Hz" : "unknown pitch"} -> ${st >= 0 ? "+" : ""}${st.toFixed(1)} semitones`;
        if (Math.abs(st) >= 0.4) {
          const src = ["-y", "-i", p.source, "-vn", "-t", String(Math.max(1, p.seconds)), "-af"];
          try { await run([...src, pitchFilter(st, true), "-c:a", "aac", "-b:a", "128k", tmpV], dir); }
          catch { await run([...src, pitchFilter(st, false), "-c:a", "aac", "-b:a", "128k", tmpV], dir); }   // ffmpeg without rubberband
          audio = tmpV;
        }
      }
      await run(["-y", "-i", vid, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out], dir);
      fs.renameSync(out, vid);
    } finally { for (const f of [tmpA, tmpV, out]) fs.unlink(f, () => {}); }
  };
  return handle;
};
module.exports.ENGINES = ENGINES;
module.exports.cropPixels = cropPixels;
module.exports.pasteFilter = pasteFilter;
module.exports.hidePixels = hidePixels;
module.exports.cutScale = cutScale;
module.exports.captionStage = captionStage;
module.exports.seededRnd = seededRnd;
module.exports.estimate = estimate;
module.exports.genderFromText = genderFromText;
module.exports.VOICES = VOICES;
module.exports.pickVoice = pickVoice;
module.exports.voiceCostFor = voiceCostFor;
module.exports.estimateF0 = estimateF0;
module.exports.pitchShift = pitchShift;
module.exports.pitchFilter = pitchFilter;
module.exports.RANGE_HZ = RANGE_HZ;
