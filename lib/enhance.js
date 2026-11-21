// Enhance a finished video on this server (ffmpeg only, no AI cost): denoise, smooth motion (motion-interpolated
// frames, which also fixes the slowed / held clips of Story budget mode), upscale (480p -> 720p, 720p -> 1080p) and
// sharpen. Runs in the render queue; results live in work/enhanced/<id>/enhanced.mp4.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HEIGHT = { "720p": 1280, "1080p": 1920 }; // long side of a 9:16 video; for landscape the short side is used

// filter chain for the chosen options; w/h = source size
function enhanceFilter({ upscale = "none", sharpen = true, denoise = true, smooth = false }, w, h) {
  const f = [];
  if (denoise) f.push("hqdn3d=1.5:1.5:6:6");
  if (smooth) f.push("minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1");
  // 720p means 720x1280 for a vertical video and 1280x720 for a landscape one: upscale only, never shrink
  const target = HEIGHT[upscale];
  if (target && w && h) {
    const want = h >= w ? target : Math.round((target * 9) / 16);
    if (h < want) f.push(`scale=-2:${want}:flags=lanczos`);
  }
  if (sharpen) f.push("unsharp=5:5:0.7:5:5:0.0");
  f.push("format=yuv420p");
  return f.join(",");
}

function createEnhance({ STORE, FFMPEG, run, renderSlot, ensureVideo, VIDEO_CACHE, history, send, readBody, serveMp4, serveThumb }) {
  const DIR = path.join(STORE, "work", "enhanced");
  fs.mkdirSync(DIR, { recursive: true });
  const jobs = new Map();
  const probe = (file) => new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
    let e = "";
    p.stderr.on("data", (d) => (e += d));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const v = e.match(/Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/), d = e.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
      resolve(v ? { w: +v[1], h: +v[2], audio: /Stream #.*Audio:/.test(e), duration: d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0 } : null);
    });
  });
  // a page's video URL -> the file on disk
  async function sourceFile(src) {
    let m;
    if ((m = src.match(/^\/api\/video\/([\w-]+)$/))) { await ensureVideo(m[1]); return { file: path.join(VIDEO_CACHE, m[1] + ".mp4"), hist: m[1] }; }
    if ((m = src.match(/^\/api\/final\/(\w+)$/))) return { file: path.join(STORE, "work", m[1], "final.mp4"), hist: "story-" + m[1] };
    if ((m = src.match(/^\/api\/shorts\/(\w+)\/short\.mp4$/))) return { file: path.join(STORE, "work", "shorts", m[1], "short.mp4"), hist: "short-" + m[1] };
    if ((m = src.match(/^\/api\/enhanced\/(e[a-f0-9]{12})$/))) return { file: path.join(DIR, m[1], "enhanced.mp4"), hist: "enh-" + m[1] };
    return null;
  }
  const statusOf = (id) => jobs.get(id) || (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, id, "status.json"), "utf8")); } catch { return null; } })();

  return async function handle(req, res, url) {
    let m;
    if (req.method === "POST" && url.pathname === "/api/enhance-video") {
      const b = await readBody(req);
      const opts = { upscale: ["none", "720p", "1080p"].includes(b.upscale) ? b.upscale : "none", sharpen: b.sharpen !== false, denoise: b.denoise !== false, smooth: !!b.smooth };
      let src;
      try { src = await sourceFile(String(b.src || "").split("?")[0]); } catch (e) { return send(res, 502, { error: "Couldn't load the video: " + e.message }), true; }
      if (!src || !fs.existsSync(src.file)) return send(res, 404, { error: "That video isn't on the server any more." }), true;
      const id = "e" + crypto.randomBytes(6).toString("hex"), dir = path.join(DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const st = { id, status: "running", step: "Waiting for a free render slot…", opts, createdAt: Date.now() };
      const save = () => { try { fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(st)); } catch {} };
      jobs.set(id, st); save();
      const parent = history && history.get(src.hist);
      try { history && history.put("enh-" + id, { kind: parent ? parent.kind : "clip", title: "Enhanced: " + (parent ? parent.title : "video"), status: "running", url: `/api/enhanced/${id}`, thumb: `/api/enhanced/${id}/thumb.jpg`, cost: 0 }); } catch {}
      renderSlot(async () => {
        const info = await probe(src.file);
        if (!info) throw new Error("Couldn't read that video.");
        st.step = `Enhancing (${[opts.denoise && "denoise", opts.smooth && "smooth motion", opts.upscale !== "none" && "upscale to " + opts.upscale, opts.sharpen && "sharpen"].filter(Boolean).join(", ")})…`; save();
        await run(["-y", "-i", src.file, "-map", "0:v:0", ...(info.audio ? ["-map", "0:a:0", "-c:a", "copy"] : []), "-vf", enhanceFilter(opts, info.w, info.h),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", "enhanced.mp4"], dir);
        const out = await probe(path.join(dir, "enhanced.mp4"));
        Object.assign(st, { status: "completed", step: "Done", from: `${info.w}×${info.h}`, to: out ? `${out.w}×${out.h}` : null }); save();
        try { history && history.put("enh-" + id, { status: "completed", res: out ? out.h + "p" : undefined, duration: Math.round(info.duration) }); } catch {}
      }).catch((e) => { Object.assign(st, { status: "failed", error: e.message.slice(-400) }); save(); try { history && history.put("enh-" + id, { status: "failed", error: st.error }); } catch {} })
        .finally(() => setTimeout(() => jobs.delete(id), 3600000));
      return send(res, 202, { id }), true;
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/enhance-video\/(e[a-f0-9]{12})$/))) {
      const st = statusOf(m[1]);
      return (st ? send(res, 200, { ...st, url: st.status === "completed" ? `/api/enhanced/${m[1]}` : null }) : send(res, 404, { error: "Unknown enhance job." })), true;
    }
    if ((req.method === "GET" || req.method === "HEAD") && (m = url.pathname.match(/^\/api\/enhanced\/(e[a-f0-9]{12})$/)))
      return serveMp4(req, res, path.join(DIR, m[1], "enhanced.mp4"), url.searchParams.has("download") ? "enhanced.mp4" : false), true;
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/enhanced\/(e[a-f0-9]{12})\/thumb\.jpg$/)))
      return serveThumb(res, path.join(DIR, m[1], "enhanced.mp4"), path.join(DIR, m[1], "thumb.jpg")), true;
    return false;
  };
}

module.exports = { createEnhance, enhanceFilter };
