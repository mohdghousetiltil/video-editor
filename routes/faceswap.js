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
    input: (v, f) => ({ video_url: v, image_url: f, mode: "person", resolution: "720p", original_sound_switch: true, keyframe_id: 1, enable_safety_checker: true }) },
  wan: { app: "fal-ai/wan/v2.2-14b/animate/replace", name: "Wan Animate Replace", perSec: () => Number(process.env.SWAP_WAN_PRICE || 0.08), keepsSound: false,
    input: (v, f) => ({ video_url: v, image_url: f, resolution: "720p", video_quality: "high", enable_safety_checker: true, enable_output_safety_checker: true }) },
};
const estimate = (engine, secs) => { const e = ENGINES[engine]; return +(e.flat ? e.flat() : e.perSec() * Math.max(1, Math.ceil(secs))).toFixed(3); };

// Voice: the swapped person should sound like the new character, not like the person in the original video. It is the SAME voice (same
// words, timing, breathing, so the lips still match), with its pitch moved up for a woman or down for a man. Free: ffmpeg only, no model, no fee.
// Where the pitch lands is picked at random inside a natural range each time, so the voice is a little different on every video.
// "Real voice": a speech-to-speech voice changer (ElevenLabs on fal.ai). Same words, timing and feeling, but an actual woman's or man's voice, and a
// different one each run. It costs about 0.3 dollars a minute (about 0.02 for a 4 second clip); nothing is generated from text.
const VOICES = {
  female: ["Rachel", "Bella", "Domi", "Elli", "Sarah", "Charlotte", "Alice", "Matilda", "Jessica", "Lily"],
  male: ["Adam", "Antoni", "Josh", "Arnold", "Sam", "Daniel", "Brian", "George", "Charlie", "Will"],
};
const VOICE_PER_MIN = () => Number(process.env.SWAP_VOICE_PRICE || 0.3);
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

module.exports = function swapRoutes(ctx) {
  const { spawn } = require("child_process");
  const { STORE, API, send, readBody, run, spend, serveMp4, mediaDuration, history, jobs, imgFile, frameToJpeg, providers, fetchLink, FFMPEG, orFetch, orHeaders, ensureVideo, readInf, hasAudio } = ctx;
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
  const dataUrlOf = (f) => `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");

  const handle = async function handle(req, res, url) {
    let m;
    // info for the page: which engines exist, what they cost, whether fal.ai is set up
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
      if (/^[\w-]+$/.test(b.influencer_id || "") && imgFile(b.influencer_id)) face = dataUrlOf(imgFile(b.influencer_id));
      else if (typeof b.face === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.face) && b.face.length < 12e6) face = b.face;
      if (!face) return send(res, 400, { error: "Choose a saved influencer with a picture, or upload a clear face picture." }), true;
      const secs = await mediaDuration(file(b.token));
      // voice: "auto" (match the character, a different voice each time), "female", "male", or "keep" (the original voice)
      const voiceMode = ["real", "auto", "female", "male", "keep"].includes(b.voice) ? b.voice : "real";
      const hasSound = await hasAudio(file(b.token)).catch(() => false);
      let voicePlan = null, voiceCost = 0;
      if (hasSound && voiceMode === "real") {
        const gender = await faceGender(b.influencer_id, face);
        voicePlan = { mode: "real", gender, voice: pickVoice(gender), source: file(b.token), seconds: secs };
        voiceCost = voiceCostFor(secs);
      } else if (hasSound && voiceMode !== "keep") {
        const gender = voiceMode === "auto" ? await faceGender(b.influencer_id, face) : voiceMode;
        voicePlan = { mode: "pitch", gender, source: file(b.token), seconds: secs };   // the pitch itself is worked out when the clip is ready
      } else if (hasSound && !E.keepsSound) voicePlan = { mode: "restore", source: file(b.token), seconds: secs }; // Wan returns silence: put the original sound back
      const est = estimate(engine, secs) + voiceCost;
      const lim = spend.videoBlock(est, 0);
      if (lim) return send(res, 429, { error: lim, limit: true }), true;
      let out;
      try {
        face = await frameToJpeg(face); // the models take JPEG or PNG
        // both files go to fal.ai's storage first: its models download them by link
        const [video, faceUrl] = await Promise.all([
          providers.falUpload(fs.readFileSync(file(b.token)), "video/mp4", "source.mp4"),
          providers.falUpload(Buffer.from(face.split(",")[1], "base64"), face.slice(5, face.indexOf(";")), "face." + (face.includes("png") ? "png" : "jpg")),
        ]);
        out = await providers.submitFalApp(E.app, E.input(video, faceUrl));
      } catch (e) { return send(res, e.status || 502, { error: `${E.name} refused the job: ${String(e.message).slice(0, 200)}` }), true; }
      jobs.set(out.id, { startedAt: Date.now(), status: "pending", model: E.app, feature: "Face swap", ...out.job, ...(voicePlan ? { voicePlan } : {}), swapVideoCost: estimate(engine, secs), estimate: est });
      history.put(out.id, { kind: "swap", title: String(b.title || "Face swap").slice(0, 140), model: E.app, duration: Math.round(secs), status: "pending", provider: "fal",
        url: `/api/video/${out.id}`, thumb: `/api/video/${out.id}/thumb.jpg`, consent: true });
      return send(res, 202, { id: out.id, engine: E.name, estimate: est, keepsSound: E.keepsSound, voice: voicePlan ? (voicePlan.mode === "real" ? `a real ${voicePlan.gender === "male" ? "man's" : "woman's"} voice (${voicePlan.voice})` : voicePlan.mode === "pitch" ? `the original voice, pitch moved for a ${voicePlan.gender === "male" ? "man" : "woman"} (free)` : "original sound") : "no sound", voiceCost }), true;
    }
    return false;
  };
  // After the swap is ready: give it the right voice (or put the original sound back). Called once from /api/jobs; the job stays "in progress" meanwhile.
  handle.finish = async (id, job) => {
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
        const f0 = estimateF0(await pcm()), st = pitchShift(f0, p.gender);
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
module.exports.estimate = estimate;
module.exports.genderFromText = genderFromText;
module.exports.VOICES = VOICES;
module.exports.pickVoice = pickVoice;
module.exports.voiceCostFor = voiceCostFor;
module.exports.estimateF0 = estimateF0;
module.exports.pitchShift = pitchShift;
module.exports.pitchFilter = pitchFilter;
module.exports.RANGE_HZ = RANGE_HZ;
