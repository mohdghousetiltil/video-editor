// Backend: proxies OpenRouter (video, images, text, voice) so the API key stays server-side, renders with ffmpeg.
// Run: node server.js   (Node 18+, no dependencies). Tests: node --test
// Route files: routes/story.js (Story mode), routes/system.js (settings, spend, prices), shorts.js (Shorts maker).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { glitchFilter } = require("./glitch");
const crypto = require("crypto");
const { orFetch } = require("./lib/openrouter");
const { createLimiter } = require("./lib/queue");
const { createSpend, TTS_PER_SEC } = require("./lib/spend");
const { createPrices } = require("./lib/prices");
const { persistentMap } = require("./lib/store");
const { startCleanup } = require("./lib/cleanup");
const modelsLib = require("./lib/models");
const { createHistory } = require("./lib/history");
const providers = require("./lib/providers");
const director = require("./lib/director");
const { createThemes, themeText, qualityText, NEGATIVE } = require("./lib/themes");

// Tiny .env loader (first, so every setting below can come from .env)
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

// DATA_DIR: where influencers + generated files live. On Railway point it at a mounted volume (e.g. /data).
const STORE = process.env.DATA_DIR || __dirname;
const DATA = path.join(STORE, "data");
const IMG = path.join(DATA, "img");
const DB = path.join(DATA, "influencers.json");
const readInf = () => { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return []; } };
const writeInf = (a) => { fs.mkdirSync(IMG, { recursive: true }); fs.writeFileSync(DB, JSON.stringify(a, null, 2)); };
const imgFile = (id) => ["jpg", "png", "webp"].map((e) => path.join(IMG, `${id}.${e}`)).find((f) => fs.existsSync(f));

// which page asked (from the Referer), so video costs can be split by feature
const pageFeature = (req) => {
  let p = "";
  try { p = new URL(req.headers.referer || "").pathname.replace(/\.html$/, ""); } catch {}
  return ({ "/story": "Story", "/ugc": "UGC", "/motion": "Poses & motion", "/influencers": "Influencers" })[p] || "Single clips";
};
const FEATURE_KIND = { "Story": "scene", "UGC": "ugc", "Poses & motion": "motion", "Influencers": "influencer", "Single clips": "clip" };
// the request as it can be sent again from History: large pictures are dropped (a saved influencer id still works)
const retryBody = (b) => Object.fromEntries(Object.entries(b).filter(([k, v]) => !(typeof v === "string" && v.length > 4000) && !(Array.isArray(v) && JSON.stringify(v).length > 4000)));
// ---- ffmpeg helpers for Story mode (stitch clips from different models into one MP4) ----
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
// Rendering limits: at most FFMPEG_SLOTS ffmpeg processes at once, and at most RENDER_JOBS whole jobs (a Short, a
// Story stitch) at once; the rest wait in line. Keeps a small server from running out of memory.
// On a public server (PUBLIC_URL set) defaults are for a small machine: one ffmpeg at a time, 2 threads each.
const SMALL = !!(process.env.PUBLIC_URL || "").trim();
const ffSlot = createLimiter(Math.max(1, Number(process.env.FFMPEG_SLOTS) || (SMALL ? 1 : 2)));
const FF_THREADS = process.env.FFMPEG_THREADS != null && process.env.FFMPEG_THREADS !== "" ? Math.max(0, Number(process.env.FFMPEG_THREADS) || 0) : SMALL ? 2 : 0;
const renderSlot = createLimiter(Math.max(1, Number(process.env.RENDER_JOBS) || (process.env.PUBLIC_URL ? 1 : 2)));
const run = (args, cwd) => ffSlot(() =>
  new Promise((resolve, reject) => {
    // -nostats: no "frame= … speed=" progress lines, so a failure shows ffmpeg's real error instead of them.
    // Threads: x264 and the filters start one thread per CPU core and each holds frames; at 1080x1920 that alone
    // reached 600-800 MB per process. Capped, a step stays under ~500 MB (FFMPEG_THREADS, 0 = no cap).
    const th = FF_THREADS ? ["-filter_threads", String(FF_THREADS), "-filter_complex_threads", String(FF_THREADS)] : [];
    const out = FF_THREADS ? [...args.slice(0, -1), "-threads", String(FF_THREADS), args[args.length - 1]] : args;
    const p = spawn(FFMPEG, ["-hide_banner", "-nostats", ...th, ...out], { cwd });
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.on("error", (e) => reject(new Error("ffmpeg not found. Install it or set FFMPEG_PATH in .env (" + e.message + ")")));
    p.on("close", (code, signal) => {
      if (code === 0) return resolve(err);
      if (signal || code === 137 || code === -9) // stopped from outside: on a server that's almost always the memory limit
        return reject(new Error(`The video renderer was stopped by the server (${signal || "code " + code}), most likely because it ran out of memory. Try a shorter clip, "Clean" editing, or give the server more memory.`));
      const lines = err.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(frame=|size=|Press \[q\]|Stream mapping|  Stream #|Input #|Output #|  Metadata|  Duration|\s{4})/.test(l));
      reject(new Error("Video render failed: " + (lines.slice(-6).join(" · ") || err.slice(-300)).slice(-500)));
    });
  }));
// Download a finished job's video and return its last frame as a JPEG data URL
async function lastFrame(id) {
  const dir = path.join(STORE, "work", "frames");
  fs.mkdirSync(dir, { recursive: true });
  await ensureVideo(id);
  fs.copyFileSync(path.join(VIDEO_CACHE, id + ".mp4"), path.join(dir, `${id}.mp4`));
  await run(["-y", "-sseof", "-0.1", "-i", `${id}.mp4`, "-update", "1", "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "2", `${id}.jpg`], dir);
  return "data:image/jpeg;base64," + fs.readFileSync(path.join(dir, `${id}.jpg`)).toString("base64");
}
// Text-to-speech through OpenRouter's /audio/speech (returns mp3 bytes)
async function tts({ model, voice, text, instructions }) {
  const body = { model, input: text, response_format: "mp3" };
  if (voice) body.voice = voice;
  if (instructions) body.instructions = instructions;
  const r = await orFetch(`${API}/audio/speech`, { method: "POST", headers: orHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Narration failed: " + (await r.text()).slice(0, 200));
  spend.log("Voiceover", (String(text).length / 15) * (TTS_PER_SEC[model] ?? 0.0005), model);
  return Buffer.from(await r.arrayBuffer());
}
const mediaDuration = (file) =>
  new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve(0));
    p.on("close", () => {
      const m = err.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0);
    });
  });
const hasAudio = (file) =>
  new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(/Audio:/.test(err)));
  });

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.VIDEO_MODEL || "bytedance/seedance-2.0-fast";
const PORT = process.env.PORT || 3000;
const ENHANCE_MODEL = process.env.ENHANCE_MODEL || "nvidia/nemotron-3-super-120b-a12b";
const API = "https://openrouter.ai/api/v1";
const settings = require("./lib/settings")(DATA);
const spend = createSpend({ DATA, API, getKey: () => KEY, getCap: () => settings.get().monthlyCap });
const logSpend = spend.log;
const prices = createPrices({ API, getKey: () => KEY });
const history = createHistory(DATA);
const themes = createThemes(DATA);
// storyboard stills: one picture per scene, approved before any video is paid for (work/stills/<id>.<ext>)
const STILLS = path.join(STORE, "work", "stills");
fs.mkdirSync(STILLS, { recursive: true });
const stillFile = (id) => /^s[a-f0-9]{16}$/.test(id || "") && ["jpg", "png", "webp"].map((e) => path.join(STILLS, `${id}.${e}`)).find((f) => fs.existsSync(f));
const fileDataUrl = (f) => `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");
// every video model with live capabilities and prices merged in (see lib/models.js)
const liveModels = async () => modelsLib.merge(await prices.live().catch(() => null), await prices().catch(() => ({})));
const textModel = () => settings.get().textModel || ENHANCE_MODEL;
// Backend locked to the Cloudflare proxy: a public server (PUBLIC_URL) without PROXY_KEY would let anyone who finds
// its address spend your OpenRouter credit, so then every /api call is refused until PROXY_KEY is set.
const PROXY_KEY = (process.env.PROXY_KEY || "").trim().replace(/^["']|["']$/g, "");
const UNLOCKED = !!PROXY_KEY || !PUBLIC_URL_RAW() || process.env.ALLOW_OPEN === "1";
function PUBLIC_URL_RAW() { return (process.env.PUBLIC_URL || "").trim(); }
if (!UNLOCKED) console.error("PROXY_KEY is not set but PUBLIC_URL is: the API is locked. Set PROXY_KEY (same value as in Cloudflare).");
// Paid endpoints are refused once the monthly cap (Settings) is reached.
const PAID = /^\/api\/(generate|plan|cast|keyframe|tts|stitch|lookframe|startframe|describe|portraits|caption|enhance|still|director|shorts(\/upload)?|shorts\/\w+\/retry|influencers\/[\w-]+\/check)$/;

const MODELS = modelsLib.VIDEO; // capabilities per model; lib/models.js
// ---- Motion page: share uploaded driving clips with the video provider (it needs a public HTTPS link) ----
// A tiny separate server exposes ONLY ./work/share/<random>.mp4. A Cloudflare quick tunnel to that port is started
// only when the user clicks the button on the Motion page, and can be stopped from there.
const SHARE_DIR = path.join(STORE, "work", "share");
const SHARE_PORT = Number(process.env.SHARE_PORT || 3101);
fs.mkdirSync(SHARE_DIR, { recursive: true });
// finished generations, downloaded once from OpenRouter so they can be served with proper range support
const VIDEO_CACHE = path.join(STORE, "work", "videos");
fs.mkdirSync(VIDEO_CACHE, { recursive: true });
const videoFetches = new Map(); // id -> in-flight download, so parallel range requests share one fetch
function ensureVideo(id) {
  const f = path.join(VIDEO_CACHE, id + ".mp4");
  if (fs.existsSync(f)) return Promise.resolve(f);
  let p = videoFetches.get(id);
  if (!p) {
    p = (async () => {
      const ext = providers.isExternal(id) && jobs.get(id)?.videoUrl;
      const r = ext ? await fetch(ext) : await orFetch(`${API}/videos/${id}/content?index=0`, { headers: { Authorization: `Bearer ${KEY}` } });
      if (!r.ok) { const t = await r.text().catch(() => ""); throw Object.assign(new Error(t.slice(0, 300) || "video not available"), { status: r.status }); }
      const tmp = f + "." + process.pid + ".part";
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      fs.renameSync(tmp, f);
      return f;
    })().finally(() => videoFetches.delete(id));
    videoFetches.set(id, p);
  }
  return p;
}
// a JPEG frame (1 s in) for sharing alongside a video; made once and kept next to it
const thumbMaking = new Map();
async function serveThumb(res, video, thumb) {
  try {
    if (!fs.existsSync(thumb)) {
      if (!fs.existsSync(video)) { res.writeHead(404); return res.end("Not found"); }
      let p = thumbMaking.get(thumb);
      if (!p) {
        const d = await mediaDuration(video);
        p = run(["-y", "-ss", String(Math.min(1, d / 3)), "-i", video, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", "-q:v", "3", thumb], path.dirname(thumb)).finally(() => thumbMaking.delete(thumb));
        thumbMaking.set(thumb, p);
      }
      await p;
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
    fs.createReadStream(thumb).pipe(res);
  } catch (e) { send(res, 500, { error: "Thumbnail failed: " + e.message.slice(-200) }); }
}
function serveMp4(req, res, f, download) {
  if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end("Not found"); }
  const size = fs.statSync(f).size, rg = (req.headers.range || "").match(/bytes=(\d*)-(\d*)/);
  const h = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" };
  if (req.method === "HEAD") { res.writeHead(200, { ...h, "Content-Length": size }); return res.end(); }
  if (download) h["Content-Disposition"] = `attachment; filename="${typeof download === "string" ? download : "motion-source.mp4"}"`;
  if (rg && (rg[1] || rg[2])) {
    // "bytes=500-" (from 500), "bytes=-500" (last 500), "bytes=0-1" (Safari's first probe)
    let s = rg[1] ? +rg[1] : Math.max(0, size - +rg[2]), e = rg[1] && rg[2] ? Math.min(+rg[2], size - 1) : size - 1;
    if (s >= size || s > e) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...h, "Content-Range": `bytes ${s}-${e}/${size}`, "Content-Length": e - s + 1 });
    return fs.createReadStream(f, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { ...h, "Content-Length": size });
  return fs.createReadStream(f).pipe(res);
}
http.createServer((req, res) => {
  const m = req.url.split("?")[0].match(/^\/s\/([a-f0-9]{24})\.mp4$/);
  serveMp4(req, res, m && path.join(SHARE_DIR, m[1] + ".mp4"));
}).listen(SHARE_PORT, "127.0.0.1");

// PUBLIC_URL (e.g. https://your-app.up.railway.app): the server itself is already public, so no tunnel is needed.
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const tunnel = PUBLIC_URL ? { status: "ready", url: PUBLIC_URL, proc: null, error: null } : { status: "off", url: null, proc: null, error: null };
function startTunnel() {
  if (PUBLIC_URL || tunnel.proc) return;
  tunnel.status = "starting"; tunnel.url = null; tunnel.error = null;
  const win = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
  const exe = process.env.CLOUDFLARED_PATH || (fs.existsSync(win) ? win : "cloudflared");
  const p = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${SHARE_PORT}`]);
  tunnel.proc = p;
  // Ready = we know the public address AND cloudflared reports a registered connection to Cloudflare.
  // (We don't test the address from this PC: local DNS can lag behind for new trycloudflare names.)
  let registered = false;
  const onData = (d) => {
    const s = String(d);
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnel.url) tunnel.url = m[0];
    if (/Registered tunnel connection/.test(s)) registered = true;
    if (tunnel.url && registered && tunnel.status === "starting") setTimeout(() => { if (tunnel.proc === p) tunnel.status = "ready"; }, 2500);
  };
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.on("error", (e) => { tunnel.status = "off"; tunnel.url = null; tunnel.proc = null; tunnel.error = "Could not start cloudflared: " + e.message; });
  p.on("close", () => { if (tunnel.proc === p) { tunnel.status = "off"; tunnel.url = null; tunnel.proc = null; } });
}
function stopTunnel() { if (PUBLIC_URL) return; if (tunnel.proc) tunnel.proc.kill(); tunnel.status = "off"; tunnel.url = null; tunnel.proc = null; }
process.on("exit", () => { try { tunnel.proc && tunnel.proc.kill(); } catch {} });
process.on("SIGINT", () => { stopTunnel(); process.exit(0); });

// A pasted link must be a direct MP4 file. Video pages (YouTube, TikTok, Instagram...) are web pages, not video files.
async function checkVideoLink(u) {
  let host = "";
  try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { return "That isn't a valid link."; }
  if (/(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com)$/.test(host))
    return "That link is a video PAGE (" + host + "), not a video file, so the provider can't read it. Save the clip as an MP4 on your computer (only footage you have the rights to use), then upload the file here instead.";
  try {
    const r = await fetch(u, { headers: { Range: "bytes=0-1023" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!r.ok && r.status !== 206) return `The link answered with an error (${r.status}).`;
    if (!/^video\//.test(ct) && !/\.mp4(\?|$)/i.test(u)) return "That link doesn't point to an MP4 video file (it returned " + (ct || "an unknown type") + "). Upload the MP4 instead.";
  } catch { return "Couldn't reach that link. Upload the MP4 file instead."; }
  return null;
}

// video jobs (id -> { startedAt, status, model, feature, error }), kept in data/jobs.json so a restart doesn't lose them
const jobs = persistentMap(path.join(DATA, "jobs.json"), { max: 400 });

const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
// JSON body, refused past `max` bytes (pictures arrive as data URLs, so the default allows ~25 MB)
const readBody = (req, max = 25e6) =>
  new Promise((resolve, reject) => {
    let d = "", n = 0;
    // past the limit: answer 413 straight away and let the rest of the upload drain into nothing
    req.on("data", (c) => { n += c.length; if (n > max) { if (d !== null) reject(Object.assign(new Error("Request too large."), { status: 413 })); d = null; } else if (d !== null) d += c; });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { reject(Object.assign(new Error("Bad JSON in request."), { status: 400 })); } });
    req.on("error", reject);
  });
const orHeaders = () => ({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
// Shorts maker (long video -> analysed, cut, captioned 9:16 Short + thumbnail + title); see shorts.js
const shorts = require("./shorts")({ STORE, FFMPEG, API, getKey: () => KEY, run, send, serveMp4, tts, logSpend, orFetch, renderSlot, getModel: () => settings.get().visionModel, serveThumb, history });
const shortsRoutes = shorts.handle;
const ctx = { STORE, DATA, API, getKey: () => KEY, orFetch, orHeaders, send, readBody, run, tts, spend, settings, serveMp4, serveThumb, mediaDuration, hasAudio, glitchFilter, renderSlot, prices, imgFile, history, liveModels, jobs, ensureVideo, themes, themeText, readInf, STILLS, stillFile, fileDataUrl };
const story = require("./routes/story")(ctx);
const systemRoutes = require("./routes/system")(ctx);
const themeRoutes = require("./routes/themes")(ctx);
const enhanceRoutes = require("./lib/enhance").createEnhance({ ...ctx, FFMPEG, VIDEO_CACHE });
startCleanup(STORE, () => settings.get(), (id) => story.busy(id) || shorts.busy(id));

// OpenRouter reports only a status, never a percentage, so pages show the stage and the time elapsed (no countdown).
function stage(job) {
  if (job.status === "completed") return "done";
  if (job.status === "failed") return "failed";
  return job.status === "pending" || job.status === "queued" ? "queued" : "generating";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    // Clips shared with the video provider: public, but only by their random 24-hex name.
    const sm0 = url.pathname.match(/^\/s\/([a-f0-9]{24})\.mp4$/);
    if (sm0) return serveMp4(req, res, path.join(SHARE_DIR, sm0[1] + ".mp4"));
    if (url.pathname === "/healthz") return send(res, 200, { ok: true }); // Railway health check (no key needed)
    // When PROXY_KEY is set, only the Cloudflare proxy (which adds this header) may use the backend.
    if (PROXY_KEY && String(req.headers["x-proxy-key"] || "").trim() !== PROXY_KEY) { res.writeHead(401); return res.end("Unauthorized"); }
    if (!UNLOCKED && url.pathname.startsWith("/api/")) return send(res, 503, { error: "This server is public (PUBLIC_URL is set) but PROXY_KEY isn't, so the API is locked to protect your credit. Set PROXY_KEY on the server and in Cloudflare." });
    if (req.method === "POST" && PAID.test(url.pathname)) {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing. Put it in .env and restart." });
      const blocked = await spend.capBlock();
      if (blocked) return send(res, 402, { error: blocked, cap: true });
    }
    if (await systemRoutes(req, res, url)) return;
    if (await themeRoutes(req, res, url)) return;
    if (await enhanceRoutes(req, res, url)) return;
    if (await story.handle(req, res, url)) return;
    if (await shortsRoutes(req, res, url)) return;
    if (req.method === "POST" && url.pathname === "/api/generate") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing. Put it in .env and restart." });
      const b = await readBody(req);
      if (!b.prompt || !b.prompt.trim()) return send(res, 400, { error: "Script/prompt is empty." });
      b.prompt = String(b.prompt).slice(0, 2500);
      const model = MODELS[b.model] ? b.model : MODEL;
      const live = (await liveModels())[model];
      if (b.duration && !MODELS[model]?.bare) {
        const d = modelsLib.allowedDuration(live, b.duration);
        if (!d) return send(res, 400, { error: `${live.name} can't make a ${b.duration} s clip. Allowed: ${live.durs.length < 8 ? live.durs.join(", ") : live.durs[0] + "–" + live.durs[live.durs.length - 1]} s.` });
        b.duration = d;
      }
      if (b.resolution && live.res.length && !live.res.includes(b.resolution)) b.resolution = live.res[0];
      // Models sometimes turn a prompt with several beats (or a cartoon style) into a comic page or split screen,
      // e.g. three small panels next to one big one inside a 9:16 frame. Ask for one full-frame shot every time.
      const ar = String(b.aspect_ratio || "");
      const frameRule = " Framing: one single continuous full-frame shot" + (ar ? ` composed for ${ar}${ar === "9:16" ? " vertical" : ""}` : "") +
        ". No split screen, no comic panels, no collage, no grid, no picture-in-picture, no borders or letterboxing.";
      // Theme Lock: the saved look (style, palette, lighting, camera, character, outfit) goes into every prompt.
      // A page can pass theme_id to use a theme once, or no_theme to skip it (e.g. copying a real video's motion).
      const st = settings.get();
      const theme = b.no_theme ? null : themes.get(typeof b.theme_id === "string" ? b.theme_id : st.themeLock ? st.themeId : null);
      const charDesc = theme && theme.influencerId ? (readInf().find((x) => x.id === theme.influencerId) || {}).desc : null;
      const extra = MODELS[model]?.bare ? "" : themeText(theme, charDesc) + qualityText({ booster: b.quality !== false, negative: b.negative, theme });
      const body = { model, prompt: b.prompt.trim() + (MODELS[model]?.bare ? "" : frameRule) + extra };
      if (b.duration) body.duration = Number(b.duration);
      if (b.resolution) body.resolution = b.resolution;
      if (b.aspect_ratio) body.aspect_ratio = b.aspect_ratio;
      if (MODELS[model]?.audio && typeof b.generate_audio === "boolean") body.generate_audio = b.generate_audio;
      if (Number.isInteger(b.seed) && live.seed !== false) body.seed = b.seed;
      if (Array.isArray(b.input_references) && b.input_references.length) body.input_references = b.input_references.slice(0, 4);
      // Story mode chaining: start this clip from the last frame of a previous clip
      let note;
      if (b.frame_from_job && /^[\w-]+$/.test(b.frame_from_job)) {
        try {
          const frameUrl = await lastFrame(b.frame_from_job);
          body.frame_images = [{ type: "image_url", image_url: { url: frameUrl }, frame_type: "first_frame" }];
        } catch (e) { note = "Couldn't grab previous end frame, generated without it (" + e.message.slice(0, 80) + ")"; }
      }
      // Motion page: driving video (HTTPS link) and optionally the influencer picture as a reference
      let refImageAdded = false;
      {
        const refs = body.input_references || [];
        if (/^[a-f0-9]{24}$/.test(b.driver_token || "")) {
          if (tunnel.status !== "ready") return send(res, 400, { error: "Start the secure public link first, so the video provider can reach your uploaded clip." });
          refs.push({ type: "video_url", video_url: { url: `${tunnel.url}/s/${b.driver_token}.mp4` } });
        } else if (typeof b.video_url === "string" && /^https:\/\//.test(b.video_url)) {
          const bad = await checkVideoLink(b.video_url);
          if (bad) return send(res, 400, { error: bad });
          refs.push({ type: "video_url", video_url: { url: b.video_url } });
        }
        const rf = /^[\w-]+$/.test(b.ref_influencer_id || "") && imgFile(b.ref_influencer_id);
        if (typeof b.ref_image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.ref_image) && !MODELS[model]?.bare) {
          refs.push({ type: "image_url", image_url: { url: b.ref_image } });
          refImageAdded = true;
        } else if (rf && !MODELS[model]?.bare) {
          refs.push({ type: "image_url", image_url: { url: `data:image/${path.extname(rf).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(rf).toString("base64") } });
          refImageAdded = true;
        }
        if (refs.length) body.input_references = refs;
        if (MODELS[model]?.bare) { delete body.duration; delete body.resolution; delete body.aspect_ratio; delete body.seed; delete body.generate_audio; }
      }
      // Storyboard stills: the approved picture is the first frame; the next scene's picture can be the last frame
      const sf = stillFile(b.still_id), lf = stillFile(b.last_still_id);
      if (sf && !body.frame_images) { body.frame_images = [{ type: "image_url", image_url: { url: fileDataUrl(sf) }, frame_type: "first_frame" }]; delete body.input_references; }
      if (lf && (live.frames || []).includes("last_frame")) body.frame_images = [...(body.frame_images || []), { type: "image_url", image_url: { url: fileDataUrl(lf) }, frame_type: "last_frame" }];
      // A start frame composed on the UGC page (influencer + product)
      if (typeof b.frame_image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.frame_image) && !body.frame_images) {
        body.frame_images = [{ type: "image_url", image_url: { url: b.frame_image }, frame_type: "first_frame" }];
        delete body.input_references;
        note = typeof b.frame_note === "string" ? b.frame_note.slice(0, 200) : "Started from your start frame (influencer holding the product).";
      }
      // Saved influencer picture as the first frame (keeps the same face)
      if (b.influencer_id && b.use_frame && /^[\w-]+$/.test(b.influencer_id) && !body.frame_images) {
        const f = imgFile(b.influencer_id);
        if (f) {
          const mime = "image/" + path.extname(f).slice(1).replace("jpg", "jpeg");
          body.frame_images = [{ type: "image_url", image_url: { url: `data:${mime};base64,` + fs.readFileSync(f).toString("base64") }, frame_type: "first_frame" }];
          delete body.input_references; // frame_images takes precedence anyway
          note = "Started from the saved influencer picture.";
        }
      }
      // the theme's style picture guides the look when the clip doesn't already start from a picture
      if (theme && !body.frame_images && !MODELS[model]?.bare && (body.input_references || []).length < 4) {
        const sd = themes.styleDataUrl(theme.id);
        if (sd) { body.input_references = [...(body.input_references || []), { type: "image_url", image_url: { url: sd } }]; body.prompt += " Use the reference picture only for the visual style, colours and rendering."; refImageAdded = true; }
      }
      // cheapest configured provider for this model (fal.ai / BytePlus when their keys are set, else OpenRouter)
      // end frame (Kling, Seedance, Veo, Wan…): the clip ends on this picture, so the next scene can start from it
      if (typeof b.last_frame_image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.last_frame_image) && (live.frames || []).includes("last_frame"))
        body.frame_images = [...(body.frame_images || []), { type: "image_url", image_url: { url: b.last_frame_image }, frame_type: "last_frame" }];
      const route = providers.pickRoute(model, { orAvailable: live.live !== false });
      let extJob = null;
      const submit = async () => {
        if (route.provider !== "openrouter") {
          try {
            const out = await providers.submit(route, body, fetch, { negative: [b.quality !== false && NEGATIVE, theme && theme.negative, b.negative].filter(Boolean).join(", ") });
            extJob = out.job;
            return { r: { ok: true, status: 202 }, j: { id: out.id, status: "pending" } };
          } catch (e) {
            // refused at submit (no balance, model not activated, bad key): nothing was charged, so fall back to
            // OpenRouter when it still has the model
            if (live.live === false) return { r: { ok: false, status: e.status || 502 }, j: { error: { message: `${route.provider}: ${e.message}` } } };
            note = `${route.provider === "byteplus" ? "BytePlus" : "fal.ai"} refused this job (${String(e.message).slice(0, 120)}), so it was made through OpenRouter instead.`;
            console.error("provider fallback:", route.provider, e.message);
            route.provider = "openrouter"; route.factor = 1; route.price = null; extJob = null;
          }
        }
        const r = await orFetch(`${API}/videos`, { method: "POST", headers: orHeaders(), body: JSON.stringify(body) }, { safe: false });
        return { r, j: await r.json().catch(() => ({})) };
      };
      let { r, j } = await submit();
      if (!r.ok && body.frame_images && /real person|sensitive/i.test(JSON.stringify(j))) {
        delete body.frame_images; // provider rejected the start frame, retry as plain text-to-video
        note = "Start frame was rejected by the provider (looks like a real person), generated without it. The look may change.";
        ({ r, j } = await submit());
      }
      if (!r.ok && refImageAdded && /real person|sensitive/i.test(JSON.stringify(j))) {
        body.input_references = body.input_references.filter((x) => x.type !== "image_url");
        note = "A reference picture was rejected by the provider (it looks like a real person), so this was made without it.";
        ({ r, j } = await submit());
      }
      if (!r.ok) return send(res, r.status, { error: j.error?.message || JSON.stringify(j) });
      const feature = pageFeature(req);
      // estimated price for routes that don't report cost (OpenRouter's own figure replaces it when it does)
      const rate = route.price != null ? route.price : (live.price[body.resolution || live.res[0]] || [0, 0])[body.generate_audio === false ? 1 : 0] * (route.factor || 1);
      jobs.set(j.id, { startedAt: Date.now(), status: j.status || "pending", polling_url: j.polling_url, model, feature, ...(extJob || {}), estimate: +(rate * (body.duration || modelsLib.defaultDur(live))).toFixed(4) });
      history.put(j.id, { kind: FEATURE_KIND[feature] || "clip", title: String(b.title || b.prompt).slice(0, 140), model, duration: body.duration, res: body.resolution, status: "pending", provider: route.provider,
        url: `/api/video/${j.id}`, thumb: `/api/video/${j.id}/thumb.jpg`, retry: { endpoint: "/api/generate", body: retryBody(b) } });
      if (theme) history.put(j.id, { theme: theme.name });
      return send(res, 202, { id: j.id, note, provider: route.provider, seed: body.seed ?? null, theme: theme ? theme.name : null });
    }

    // ---- Motion page: upload a driving video, prepare it, and manage the public link ----
    if (url.pathname === "/api/tunnel" && req.method === "GET") return send(res, 200, { status: tunnel.status, url: tunnel.url, error: tunnel.error });
    if (url.pathname === "/api/tunnel/start" && req.method === "POST") { startTunnel(); return send(res, 200, { status: tunnel.status }); }
    if (url.pathname === "/api/tunnel/stop" && req.method === "POST") { stopTunnel(); return send(res, 200, { status: tunnel.status }); }
    if (url.pathname === "/api/driver" && req.method === "POST") {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 120 * 1024 * 1024) return send(res, 413, { error: "Video too large (max 120 MB)." }); chunks.push(c); }
      if (!size) return send(res, 400, { error: "Empty upload." });
      const token = crypto.randomBytes(12).toString("hex");
      const raw = path.join(SHARE_DIR, token + ".src");
      fs.writeFileSync(raw, Buffer.concat(chunks));
      try {
        // first 15 s, audio removed, upscaled so the short side is 720px (providers require a minimum resolution)
        await run(["-y", "-i", raw, "-t", "15", "-an", "-vf", "scale='if(lt(iw,ih),720,-2)':'if(lt(iw,ih),-2,720)',fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", path.join(SHARE_DIR, token + ".mp4")], SHARE_DIR);
      } catch (e) { fs.unlink(raw, () => {}); return send(res, 400, { error: "Couldn't read that video: " + e.message.slice(-160) }); }
      fs.unlink(raw, () => {});
      return send(res, 200, { token, duration: await mediaDuration(path.join(SHARE_DIR, token + ".mp4")), previewUrl: `/api/driver/${token}.mp4` });
    }
    let dm;
    if (req.method === "GET" && (dm = url.pathname.match(/^\/api\/driver\/([a-f0-9]{24})\.mp4$/))) return serveMp4(req, res, path.join(SHARE_DIR, dm[1] + ".mp4"));

    // ---- New look: same influencer, different outfit and/or makeup (used as the first frame of pose clips) ----
    if (req.method === "POST" && url.pathname === "/api/lookframe") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const b = await readBody(req);
      const f = /^[\w-]+$/.test(b.influencer_id || "") && imgFile(b.influencer_id);
      if (!f) return send(res, 400, { error: "That influencer has no saved picture." });
      const outfit = String(b.outfit || "").trim().slice(0, 300), makeup = String(b.makeup || "").trim().slice(0, 300);
      const outfitImg = typeof b.outfit_image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.outfit_image) ? b.outfit_image : null;
      if (!outfit && !makeup && !outfitImg) return send(res, 400, { error: "Choose an outfit or makeup first." });
      const FRAME_MODELS = ["google/gemini-3.1-flash-image", "openai/gpt-image-2", "bytedance-seed/seedream-5-0-lite"];
      const model = FRAME_MODELS.includes(b.model) ? b.model : FRAME_MODELS[0];
      const person = `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");
      const prompt = "Edit image 1. Keep exactly the same person: identical face, facial features, hair, skin tone, body proportions, pose, framing and the same background. " +
        (outfitImg ? "Image 2 shows an outfit. Dress the person from image 1 in exactly that outfit (same garments, colors, patterns, fit and accessories as image 2); do not copy the face, body or background of image 2. Change ONLY their clothing. " : outfit ? `Change ONLY their clothing to: ${outfit}. ` : "Keep the clothing exactly the same. ") +
        (makeup ? `Change ONLY their makeup to: ${makeup}. ` : "Keep the makeup exactly the same. ") +
        "Realistic vertical 9:16 smartphone selfie photo, natural skin texture, no beauty filter, nothing else changed.";
      try {
        const r = await orFetch(`${API}/images`, { method: "POST", headers: orHeaders(), body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: "9:16", input_references: [{ type: "image_url", image_url: { url: person } }, ...(outfitImg ? [{ type: "image_url", image_url: { url: outfitImg } }] : [])] }) }, { safe: false });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return send(res, r.status, { error: j.error?.message || "Look change failed (" + r.status + ")" });
        const d = j.data?.[0];
        if (!d?.b64_json) return send(res, 502, { error: "The image model returned no picture." });
        logSpend("Images", j.usage?.cost, model);
        return send(res, 200, { image: `data:${d.media_type || "image/png"};base64,${d.b64_json}`, cost: j.usage?.cost || 0 });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }

    // ---- UGC start frame: saved influencer + uploaded product photo -> one image of them holding it ----
    if (req.method === "POST" && url.pathname === "/api/startframe") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const b = await readBody(req);
      const f = /^[\w-]+$/.test(b.influencer_id || "") && imgFile(b.influencer_id);
      if (!f) return send(res, 400, { error: "That influencer has no saved picture." });
      if (typeof b.product !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(b.product)) return send(res, 400, { error: "Add the product photo first." });
      const FRAME_MODELS = ["google/gemini-3.1-flash-image", "openai/gpt-image-2", "bytedance-seed/seedream-5-0-lite"];
      const model = FRAME_MODELS.includes(b.model) ? b.model : FRAME_MODELS[0];
      const mime = "image/" + path.extname(f).slice(1).replace("jpg", "jpeg");
      const person = `data:${mime};base64,` + fs.readFileSync(f).toString("base64");
      const prompt = "Image 1 shows a person. Image 2 shows a product. Create one realistic vertical 9:16 smartphone selfie photo of exactly the same person as image 1 (identical face, hair, skin tone and outfit) holding exactly the product from image 2 up near the camera with its label facing the lens. " +
        "The product must keep its exact shape, size, colors, label text and packaging from image 2, with nothing added or changed. Natural window light, casual home setting, natural skin texture, no beauty filter, relaxed friendly expression, looking at the camera. " + String(b.extra || "").slice(0, 300);
      try {
        const r = await orFetch(`${API}/images`, { method: "POST", headers: orHeaders(), body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: "9:16", input_references: [{ type: "image_url", image_url: { url: person } }, { type: "image_url", image_url: { url: b.product } }] }) }, { safe: false });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return send(res, r.status, { error: j.error?.message || "Start frame failed (" + r.status + ")" });
        const d = j.data?.[0];
        if (!d?.b64_json) return send(res, 502, { error: "The image model returned no picture." });
        logSpend("Images", j.usage?.cost, model);
        return send(res, 200, { image: `data:${d.media_type || "image/png"};base64,${d.b64_json}`, cost: j.usage?.cost || 0 });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }

    // ---- Write a text description of an influencer from their picture (used by text-only edit models) ----
    if (req.method === "POST" && url.pathname === "/api/describe") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const b = await readBody(req);
      let img = typeof b.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) ? b.image : null;
      if (!img && /^[\w-]+$/.test(b.influencer_id || "")) {
        const f = imgFile(b.influencer_id);
        if (f) img = `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");
      }
      if (!img) return send(res, 400, { error: "That influencer has no picture to describe." });
      const prompt = "Describe the person in this picture so an AI image or video generator can recreate the same look. Write 2 to 3 plain sentences covering: apparent age range, gender presentation, skin tone, face shape, hair color, length and style, facial hair if any, eye color, notable features, and clothing and accessories. No names, no opinions, no background description.";
      const r = await orFetch(`${API}/chat/completions`, {
        method: "POST", headers: orHeaders(),
        body: JSON.stringify({ model: process.env.DESCRIBE_MODEL || "nvidia/nemotron-3.5-super-vl", max_tokens: 600, reasoning: { enabled: false },
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: img } }] }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: j.error?.message || "Describe failed" });
      logSpend("Influencers", j.usage?.cost, "describe");
      const text = j.choices?.[0]?.message?.content?.trim();
      return text ? send(res, 200, { description: text }) : send(res, 502, { error: "The model returned no description. Try again." });
    }

    // ---- Generate candidate pictures for an AI influencer from a description ----
    if (req.method === "POST" && url.pathname === "/api/portraits") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const b = await readBody(req);
      const desc = String(b.desc || "").trim().slice(0, 1200);
      if (!desc) return send(res, 400, { error: "Write a description first." });
      const IMAGE_MODELS = ["qwen/qwen-image-3", "x-ai/grok-imagine-image-2.0", "bytedance-seed/seedream-5-0-lite", "google/gemini-3.1-flash-image"];
      const model = IMAGE_MODELS.includes(b.model) ? b.model : IMAGE_MODELS[0];
      const lead = { photo: "Realistic smartphone selfie portrait photo of ", studio: "Professional studio portrait photograph of ", cartoon3d: "High-quality 3D animated character render in a Pixar-like style of ", anime: "Anime style illustration portrait of ", stylized: "Semi-realistic digital painting portrait, clearly an illustration and not a photograph, of " }[b.style] || "Realistic smartphone selfie portrait photo of ";
      const prompt = `${lead}${desc}. Head and shoulders, looking at the camera, front-facing, relaxed expression with a slight smile, soft natural light, clean simple background${(b.style || "photo") === "photo" ? ", natural skin texture and pores, no beauty filter" : ""}. Vertical 9:16 framing.`;
      const n = Math.max(1, Math.min(4, Number(b.count) || 4));
      const call = async (k) => {
        const r = await orFetch(`${API}/images`, { method: "POST", headers: orHeaders(), body: JSON.stringify({ model, prompt, n: k, aspect_ratio: "9:16" }) }, { safe: false });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error?.message || "Image generation failed (" + r.status + ")");
        return j;
      };
      try {
        let parts;
        try { parts = [await call(n)]; } catch (e) { if (n === 1) throw e; parts = await Promise.all(Array.from({ length: n }, () => call(1))); }
        const images = parts.flatMap((j) => (j.data || []).map((d) => `data:${d.media_type || "image/png"};base64,${d.b64_json}`));
        const cost = parts.reduce((a, j) => a + (j.usage?.cost || 0), 0);
        logSpend("Influencers", cost, model);
        return send(res, 200, { images, cost });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }

    // ---- Influencer library (saved on disk in ./data so every page can use it) ----
    const pub = (p) => ({ id: p.id, name: p.name, desc: p.desc, seed: p.seed, seedance: p.seedance || null, image: imgFile(p.id) ? `/api/influencers/${p.id}/image?v=${p.updated || 0}` : null });
    if (url.pathname === "/api/influencers" && req.method === "GET") return send(res, 200, { influencers: readInf().map(pub) });
    if (url.pathname === "/api/influencers" && req.method === "POST") {
      const b = await readBody(req);
      const name = String(b.name || "").trim().slice(0, 60), desc = String(b.desc || "").trim().slice(0, 1500);
      if (!name) return send(res, 400, { error: "Name is required." });
      const all = readInf();
      let p = b.id && all.find((x) => x.id === b.id);
      if (!p) { p = { id: crypto.randomBytes(5).toString("hex") }; all.push(p); }
      Object.assign(p, { name, desc, seed: Number.isInteger(b.seed) ? b.seed : p.seed ?? Math.floor(Math.random() * 2e9), updated: Date.now() });
      writeInf(all);
      if (b.removeImage) { const f = imgFile(p.id); if (f) fs.unlinkSync(f); }
      const m = typeof b.image === "string" && b.image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (m) {
        const old = imgFile(p.id); if (old) fs.unlinkSync(old);
        p.seedance = null; writeInf(all); // new picture: earlier Seedance test no longer applies
        fs.writeFileSync(path.join(IMG, `${p.id}.${m[1] === "jpeg" ? "jpg" : m[1]}`), Buffer.from(m[2], "base64"));
      }
      return send(res, 200, pub(p));
    }
    // Does Seedance accept this influencer's picture? A rejection costs nothing; an acceptance makes a real 4 s clip.
    let cm;
    if (req.method === "POST" && (cm = url.pathname.match(/^\/api\/influencers\/([\w-]+)\/check$/))) {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const all = readInf(), p = all.find((x) => x.id === cm[1]), f = p && imgFile(p.id);
      if (!f) return send(res, 400, { error: "This influencer has no picture to test." });
      const dataUrl = `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");
      const r = await orFetch(`${API}/videos`, { method: "POST", headers: orHeaders(), body: JSON.stringify({
        model: "bytedance/seedance-2.0-mini", prompt: "The person smiles and waves at the camera, natural handheld selfie video.",
        duration: 4, resolution: "480p", aspect_ratio: "9:16", generate_audio: false,
        input_references: [{ type: "image_url", image_url: { url: dataUrl } }] }) }, { safe: false });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (/real person|sensitive/i.test(JSON.stringify(j))) { p.seedance = "blocked"; writeInf(all); return send(res, 200, { result: "blocked" }); }
        return send(res, r.status, { error: j.error?.message || JSON.stringify(j).slice(0, 200) });
      }
      p.seedance = "ok"; writeInf(all);
      jobs.set(j.id, { startedAt: Date.now(), status: j.status || "pending", polling_url: j.polling_url, model: "bytedance/seedance-2.0-mini", feature: "Influencers" });
      return send(res, 200, { result: "ok", id: j.id });
    }
    let im;
    if ((im = url.pathname.match(/^\/api\/influencers\/([\w-]+)(\/image)?$/))) {
      const id = im[1];
      if (im[2] && req.method === "GET") {
        const f = imgFile(id);
        if (!f) { res.writeHead(404); return res.end("No image"); }
        res.writeHead(200, { "Content-Type": "image/" + path.extname(f).slice(1).replace("jpg", "jpeg") });
        return fs.createReadStream(f).pipe(res);
      }
      if (!im[2] && req.method === "DELETE") {
        const all = readInf();
        if (!all.some((x) => x.id === id)) return send(res, 404, { error: "Not found" });
        writeInf(all.filter((x) => x.id !== id));
        const f = imgFile(id); if (f) fs.unlinkSync(f);
        return send(res, 200, { ok: true });
      }
    }

    // Social caption for a finished video, written from the prompt that made it (used by the Share box)
    if (req.method === "POST" && url.pathname === "/api/caption") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const b = await readBody(req);
      const p = String(b.prompt || "").trim().slice(0, 3000);
      if (!p) return send(res, 400, { error: "No prompt to write a caption from." });
      const sys = "You write captions for short vertical videos posted on TikTok, Instagram Reels and YouTube Shorts. " +
        "The user gives you the prompt that was used to generate the video. Write: one or two short, punchy sentences that make people want to watch (a hook, not a description of the prompt; max 1 emoji), " +
        "then a blank line, then 4 to 6 relevant hashtags on one line (always include #shorts). Write in the language of the prompt. " +
        "Never mention AI prompts, models or 'this video was generated'. Output ONLY the caption text.";
      const r = await orFetch(`${API}/chat/completions`, {
        method: "POST", headers: orHeaders(),
        body: JSON.stringify({ model: textModel(), max_tokens: 400, reasoning: { enabled: false }, messages: [{ role: "system", content: sys }, { role: "user", content: p }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: j.error?.message || "Caption failed" });
      logSpend("Captions", j.usage?.cost, textModel());
      const caption = (j.choices?.[0]?.message?.content || "").replace(/^["']|["']$/g, "").trim();
      if (!caption) return send(res, 502, { error: "No caption came back, write your own." });
      return send(res, 200, { caption });
    }

    if (req.method === "POST" && url.pathname === "/api/enhance") {
      if (!KEY) return send(res, 500, { error: "OPENROUTER_API_KEY missing." });
      const b = await readBody(req);
      if (!b.prompt || !b.prompt.trim()) return send(res, 400, { error: "Write something first." });
      // No duration given: let the enhancer choose one the selected model accepts (e.g. Veo only does 4, 6 or 8 s).
      const allowed = (Array.isArray(b.durations) ? b.durations : []).map(Number).filter((n) => n > 0 && n <= 60).sort((x, y) => x - y);
      const auto = !(Number(b.duration) > 0);
      const lenRule = auto
        ? "Choose the clip length yourself: just long enough for the action to play out naturally without rushing or dead time" +
          (allowed.length ? ", and it MUST be one of these numbers of seconds: " + allowed.join(", ") : ", between 4 and 15 seconds") +
          '. Reply with ONLY JSON, no markdown: {"seconds":N,"prompt":"..."} where prompt is the final prompt written for exactly that length. '
        : "Clip length: " + b.duration + " seconds. ";
      const sys = "You rewrite rough ideas into prompts for an AI text-to-video model. " +
        (auto ? "" : "Output ONLY the final prompt, no preamble or quotes. ") +
        "Write one vivid paragraph in present tense: subject and consistent appearance (hair, clothes, colors), setting, lighting, concrete visible action in time order that fits the clip length, camera shot and movement, mood. " +
        "Describe only what can be seen and heard in one continuous shot, following any timed beats given at the end; no abstract story, no on-screen text unless essential. " +
        "Never describe split screens, comic panels, multiple frames or a storyboard: the whole frame shows one scene. " +
        "End with a short 'Sound:' line (ambience, effects, any short spoken line in quotes). Keep under " + (Number(b.max_words) || 140) + " words. " +
        lenRule + "Aspect ratio: " + (b.aspect_ratio || "9:16") + ". " +
        (b.style ? "Visual style to respect: " + b.style + " " : "") + (b.extra || "");
      const r = await orFetch(`${API}/chat/completions`, {
        method: "POST", headers: orHeaders(),
        body: JSON.stringify({ model: textModel(), max_tokens: 2000, reasoning: { enabled: false }, messages: [{ role: "system", content: sys }, { role: "user", content: b.prompt.trim() }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: j.error?.message || "Enhance failed" });
      logSpend("Prompt writing", j.usage?.cost, textModel());
      const out = j.choices?.[0]?.message?.content?.trim();
      if (!out) return send(res, 502, { error: "Enhancer returned nothing, try again." });
      if (!auto) return send(res, 200, { prompt: out });
      const raw = out.replace(/```(json)?/g, "").trim();
      let pj = null;
      try { pj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch {}
      const text = (pj && typeof pj.prompt === "string" && pj.prompt.trim()) || raw;
      let secs = Math.round(Number(pj && pj.seconds)) || 0;
      if (!secs) secs = allowed.length ? allowed[Math.floor(allowed.length / 2)] : 6;
      // snap to the nearest length the model supports
      if (allowed.length) secs = allowed.reduce((best, n) => (Math.abs(n - secs) < Math.abs(best - secs) ? n : best), allowed[0]);
      return send(res, 200, { prompt: text, duration: secs });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const list = [...jobs.entries()].map(([id, j]) => ({ id, status: j.status, stage: stage(j), model: j.model, feature: j.feature, startedAt: j.startedAt, videoUrl: `/api/video/${id}` })).sort((a, b) => b.startedAt - a.startedAt);
      return send(res, 200, { jobs: list });
    }

    let m;
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/))) {
      const id = m[1];
      const known = jobs.get(id);
      let j;
      try {
        if (providers.isExternal(id)) {
          if (!known) return send(res, 404, { error: "No job with that ID on this server." });
          j = await providers.poll(id, known);
        } else {
          const r = await orFetch(`${API}/videos/${id}`, { headers: orHeaders() });
          j = await r.json().catch(() => ({}));
          // unknown or malformed id: say so and remember nothing (it used to be saved as a stuck "pending" job)
          if (r.status === 404 || r.status === 400 || r.status === 422) return send(res, 404, { error: "No job with that ID. Check it and try again." });
          if (!r.ok) return send(res, r.status, { error: j.error?.message || "Couldn't check the job (" + r.status + ")" });
        }
      } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? "No job with that ID." : "Couldn't check the job: " + e.message }); }
      const job = known || { startedAt: j.created_at ? Date.parse(j.created_at) || Date.now() : Date.now(), status: "pending" };
      job.status = j.status;
      if (j.videoUrl) job.videoUrl = j.videoUrl;
      if (j.status === "failed") job.error = typeof j.error === "string" ? j.error : j.error?.message || "Generation failed";
      const cost = j.usage?.cost ?? (j.status === "completed" && job.provider ? job.estimate : undefined);
      if (j.status === "completed") logSpend(job.feature || "Video clips", cost, job.model, id, job.provider);
      jobs.set(id, job);
      if (history.get(id) || j.status === "completed") history.put(id, { kind: history.get(id)?.kind || FEATURE_KIND[job.feature] || "clip", model: job.model, status: j.status, error: job.error, cost, url: `/api/video/${id}`, thumb: `/api/video/${id}/thumb.jpg`, ...(history.get(id) ? {} : { title: "Fetched job " + id.slice(-8) }) });
      const ty = MODELS[job.model]?.typical;
      return send(res, 200, {
        status: job.status,
        stage: stage(job),
        elapsed: Math.round((Date.now() - job.startedAt) / 1000),
        typical: ty || null,
        cost,
        estimated: !j.usage?.cost && cost != null,
        error: job.error,
        videoUrl: job.status === "completed" ? `/api/video/${id}` : null,
      });
    }

    // ---- 🧠 the Director: picks the model and the process for the best quality within the budget ----
    if (req.method === "POST" && url.pathname === "/api/director") {
      const b = await readBody(req);
      const st = settings.get();
      const page = String(b.page || "clip");
      const budget = Number(b.budget) > 0 ? Math.min(50, Number(b.budget)) : (st.directorBudget || {})[page] ?? null;
      const theme = st.themeLock ? themes.get(st.themeId) : null;
      const reqD = {
        page, prompt: String(b.prompt || "").slice(0, 2000), aspect: ["9:16", "16:9", "1:1"].includes(b.aspect) ? b.aspect : "9:16",
        duration: Number(b.duration) || null, resolution: ["480p", "720p", "1080p"].includes(b.resolution) ? b.resolution : "720p",
        audio: b.audio === false ? false : b.audio === true ? true : undefined, startPicture: !!b.startPicture, budget,
        theme: theme ? [theme.name, theme.style].filter(Boolean).join(": ") : (typeof b.style === "string" ? b.style.slice(0, 200) : null),
        scenes: Array.isArray(b.scenes) ? b.scenes.slice(0, 40).map((s) => ({ title: String(s.title || "").slice(0, 80), prompt: String(s.prompt || "").slice(0, 600), seconds: Number(s.seconds) || 4, key: !!s.key })) : undefined,
      };
      const catalog = await liveModels();
      const available = (m) => m.live !== false || providers.pickRoute(m.id, { orAvailable: false }).provider !== "openrouter";
      const brainModel = st.directorModel || "google/gemini-3.5-flash";
      const callBrain = async (messages) => {
        const r = await orFetch(`${API}/chat/completions`, { method: "POST", headers: orHeaders(),
          body: JSON.stringify({ model: brainModel, max_tokens: 6000, temperature: 0.2, reasoning: { effort: "low" }, response_format: { type: "json_object" }, messages }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error?.message || `Director brain failed (${r.status})`);
        logSpend("Director", j.usage?.cost, brainModel);
        return { text: j.choices?.[0]?.message?.content || "", cost: j.usage?.cost || 0 };
      };
      try {
        const out = await director.decide(reqD, { catalog, available, callBrain });
        return send(res, 200, { ...out, brain: brainModel });
      } catch (e) { return send(res, e.status || 502, { error: e.message }); }
    }

    // ---- History: everything made, across features ----
    if (req.method === "GET" && url.pathname === "/api/history") {
      const q = url.searchParams, ts = (k) => (q.get(k) ? Date.parse(q.get(k)) || undefined : undefined);
      return send(res, 200, { items: history.list({ q: q.get("q"), kind: q.get("kind") || undefined, status: q.get("status") || undefined, from: ts("from"), to: ts("to") && ts("to") + 86399999, limit: Number(q.get("limit")) || 200 }) });
    }
    if ((m = url.pathname.match(/^\/api\/history\/([\w-]+)$/))) {
      const rec = history.get(m[1]);
      if (!rec) return send(res, 404, { error: "Not in history." });
      if (req.method === "DELETE") {
        history.del(m[1]);
        jobs.delete(m[1]);
        for (const f of [path.join(VIDEO_CACHE, m[1] + ".mp4"), path.join(VIDEO_CACHE, m[1] + ".jpg")]) { try { fs.unlinkSync(f); } catch {} }
        return send(res, 200, { ok: true });
      }
      if (req.method === "PATCH") { // rename, or a 1-5 rating for later model suggestions
        const b = await readBody(req);
        return send(res, 200, history.put(m[1], { title: typeof b.title === "string" ? b.title : undefined, rating: Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5 ? b.rating : undefined, kept: typeof b.kept === "boolean" ? b.kept : undefined }));
      }
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const all = await liveModels();
      const out = Object.values(all).filter((x) => !x.hidden).map((x) => {
        const rt = providers.pickRoute(x.id, { orAvailable: x.live !== false });
        const price = rt.price != null ? Object.fromEntries(x.res.map((r) => [r, [rt.price, rt.price]])) : rt.factor !== 1 ? Object.fromEntries(Object.entries(x.price).map(([r, p]) => [r, p.map((v) => +(v * rt.factor).toFixed(4))])) : x.price;
        return { ...x, price, defaultDur: modelsLib.defaultDur(x), notes: modelsLib.notes(x), route: rt.provider };
      })
        // a model OpenRouter no longer lists (and no other provider has a key for) can't be generated: leave it out
        .filter((x) => x.live !== false || x.route !== "openrouter");
      return send(res, 200, { models: out, default: modelsLib.DEFAULT_MODEL, providers: providers.configured() });
    }

    if ((req.method === "GET" || req.method === "HEAD") && (m = url.pathname.match(/^\/api\/video\/([\w-]+)$/))) {
      // iPhone Safari only plays video that answers byte-range requests with 206 + Content-Range. OpenRouter's
      // content endpoint doesn't reliably do that, so keep one copy on disk and serve ranges from it ourselves.
      let f;
      try { f = await ensureVideo(m[1]); } catch (e) { return send(res, e.status || 502, { error: "Couldn't load the video: " + e.message }); }
      return serveMp4(req, res, f, url.searchParams.has("download") ? "video.mp4" : false);
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/video\/([\w-]+)\/thumb\.jpg$/))) {
      try { await ensureVideo(m[1]); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
      return serveThumb(res, path.join(VIDEO_CACHE, m[1] + ".mp4"), path.join(VIDEO_CACHE, m[1] + ".jpg"));
    }

    // static files
    let file = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html"; // clean URLs: /shorts -> shorts.html (same as Cloudflare)
    if (!file.startsWith(path.join(__dirname, "public")) || !fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
    const MIME = { ".webp": "image/webp", ".ico": "image/x-icon", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json" };
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}  (model: ${MODEL}, key ${KEY ? "loaded" : "MISSING"})`));
