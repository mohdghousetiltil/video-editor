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
  pixverse: { app: "fal-ai/pixverse/swap", name: "PixVerse Swap", flat: () => Number(process.env.SWAP_PIXVERSE_PRICE || 0.05), keepsSound: true,
    input: (v, f) => ({ video_url: v, image_url: f, mode: "person", resolution: "720p", original_sound_switch: true, keyframe_id: 1, enable_safety_checker: true }) },
  wan: { app: "fal-ai/wan/v2.2-14b/animate/replace", name: "Wan Animate Replace", perSec: () => Number(process.env.SWAP_WAN_PRICE || 0.08), keepsSound: false,
    input: (v, f) => ({ video_url: v, image_url: f, resolution: "720p", video_quality: "high", enable_safety_checker: true, enable_output_safety_checker: true }) },
};
const estimate = (engine, secs) => { const e = ENGINES[engine]; return +(e.flat ? e.flat() : e.perSec() * Math.max(1, Math.ceil(secs))).toFixed(3); };

module.exports = function swapRoutes(ctx) {
  const { STORE, send, readBody, run, spend, serveMp4, mediaDuration, history, jobs, imgFile, frameToJpeg, providers } = ctx;
  const DIR = path.join(STORE, "work", "swap");
  fs.mkdirSync(DIR, { recursive: true });
  const MAX_UPLOAD = 100 * 1024 * 1024, MAX_VIDEO_FILE = 24 * 1024 * 1024; // the file travels to fal.ai inside the request
  const file = (t) => path.join(DIR, t + ".mp4");
  const dataUrlOf = (f) => `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");

  return async function handle(req, res, url) {
    let m;
    // info for the page: which engines exist, what they cost, whether fal.ai is set up
    if (req.method === "GET" && url.pathname === "/api/swap/engines") {
      return send(res, 200, { ready: !!providers.configured().fal, engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, keepsSound: e.keepsSound, price: e.flat ? { flat: e.flat() } : { perSecond: e.perSec() } })) }), true;
    }
    if (req.method === "POST" && url.pathname === "/api/swap/source") {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) return send(res, 413, { error: "Video too large (max 100 MB)." }), true; chunks.push(c); }
      if (!size) return send(res, 400, { error: "Empty upload." }), true;
      const token = crypto.randomBytes(12).toString("hex"), raw = path.join(DIR, token + ".src");
      fs.writeFileSync(raw, Buffer.concat(chunks));
      try {
        // first 15 s, short side at most 720 px, the sound is kept (PixVerse hands it back), a size small enough to send inline
        await run(["-y", "-i", raw, "-t", "15", "-vf", "scale='if(lt(iw,ih),min(iw,720),-2)':'if(lt(iw,ih),-2,min(ih,720))',fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", file(token)], DIR);
      } catch (e) { fs.unlink(raw, () => {}); return send(res, 400, { error: "Couldn't read that video: " + String(e.message).slice(-160) }), true; }
      fs.unlink(raw, () => {});
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
      const est = estimate(engine, secs);
      const lim = spend.videoBlock(est, 0);
      if (lim) return send(res, 429, { error: lim, limit: true }), true;
      let out;
      try {
        face = await frameToJpeg(face); // the models take JPEG or PNG
        const video = "data:video/mp4;base64," + fs.readFileSync(file(b.token)).toString("base64");
        out = await providers.submitFalApp(E.app, E.input(video, face));
      } catch (e) { return send(res, e.status || 502, { error: `${E.name} refused the job: ${String(e.message).slice(0, 200)}` }), true; }
      jobs.set(out.id, { startedAt: Date.now(), status: "pending", model: E.app, feature: "Face swap", ...out.job, estimate: est });
      history.put(out.id, { kind: "swap", title: String(b.title || "Face swap").slice(0, 140), model: E.app, duration: Math.round(secs), status: "pending", provider: "fal",
        url: `/api/video/${out.id}`, thumb: `/api/video/${out.id}/thumb.jpg`, consent: true });
      return send(res, 202, { id: out.id, engine: E.name, estimate: est, keepsSound: E.keepsSound }), true;
    }
    return false;
  };
};
module.exports.ENGINES = ENGINES;
module.exports.estimate = estimate;
