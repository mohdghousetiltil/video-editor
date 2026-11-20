// Shorts maker: take any long video (upload or link), let a video-understanding model pick the best
// 15-60 s moment, then cut it to 1080x1920 with ffmpeg (smart crop or blurred background), burn
// word captions + a hook line, normalise loudness, and make a thumbnail, title, description and hashtags.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

module.exports = function createShorts({ STORE, FFMPEG, API, getKey, run, send, serveMp4 }) {
  const DIR = path.join(STORE, "work", "shorts");
  const MODEL = process.env.SHORTS_MODEL || "google/gemini-3.5-flash-lite";
  const FONTS = path.join(__dirname, "fonts"); // Anton (SIL OFL), used by the caption/thumbnail styles
  const MAX_UPLOAD = 500 * 1024 * 1024;
  const MAX_LINK = 1500 * 1024 * 1024; // direct-link downloads (same cap as yt-dlp)
  const ANALYSE_MAX = 30 * 60; // only the first 30 min of very long videos is analysed
  const jobs = new Map(); // id -> live job (status lives on disk in meta.json once finished)
  fs.mkdirSync(DIR, { recursive: true });

  const STEPS = ["Getting the video", "Watching the video", "Cutting the best moment", "Writing captions", "Rendering the Short", "Making the thumbnail"];
  const setStep = (job, i, pct) => { job.step = STEPS[i]; job.pct = Math.round(Math.max(job.pct || 0, pct ?? (i / STEPS.length) * 100)); };
  const dirOf = (id) => path.join(DIR, id);
  const metaFile = (id) => path.join(dirOf(id), "meta.json");
  const readMeta = (id) => { try { return JSON.parse(fs.readFileSync(metaFile(id), "utf8")); } catch { return null; } };
  const saveMeta = (id, m) => fs.writeFileSync(metaFile(id), JSON.stringify(m, null, 2));

  // ---------- media helpers ----------
  const probe = (file) =>
    new Promise((resolve) => {
      const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
      let e = "";
      p.stderr.on("data", (d) => (e += d));
      p.on("error", () => resolve(null));
      p.on("close", () => {
        const d = e.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
        const v = e.match(/Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
        if (!d || !v) return resolve(null);
        let [w, h] = [+v[1], +v[2]];
        const rot = e.match(/rotation of (-?\d+(\.\d+)?)|rotate\s*:\s*(-?\d+)/);
        if (rot && Math.abs(Math.round(+(rot[1] ?? rot[3]))) % 180 === 90) [w, h] = [h, w]; // ffmpeg auto-rotates phone videos
        resolve({ duration: +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]), w, h, audio: /Stream #.*Audio:/.test(e) });
      });
    });

  // yt-dlp: works for YouTube, X, Instagram, TikTok, Reddit, Vimeo and ~1800 other sites.
  function download(link, dir, job) {
    const args = [
      "--no-playlist", "--no-simulate", "--newline", "--progress", "--print", "after_move:TITLE:%(title)s",
      "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format", "mp4", "--max-filesize", "1500M", "--match-filter", "duration <=? 10800",
      "--js-runtimes", "node", "-o", "src.%(ext)s",
    ];
    if (FFMPEG !== "ffmpeg") args.push("--ffmpeg-location", FFMPEG);
    // YouTube often blocks cloud servers; cookies exported from a logged-in browser (Netscape format) get past it.
    if (process.env.YT_COOKIES) { fs.writeFileSync(path.join(dir, "cookies.txt"), process.env.YT_COOKIES.replace(/\\n/g, "\n")); args.push("--cookies", "cookies.txt"); }
    args.push(link);
    const attempt = (exe, pre) =>
      new Promise((resolve, reject) => {
        const p = spawn(exe, [...pre, ...args], { cwd: dir });
        let err = "", title = "";
        const onLine = (line) => {
          const m = line.match(/\[download\]\s+(\d+(\.\d+)?)%/);
          if (m) setStep(job, 0, Math.min(14, +m[1] * 0.14));
          const t = line.match(/^TITLE:(.*)$/);
          if (t) title = t[1].trim();
        };
        let buf = "";
        p.stdout.on("data", (d) => { buf += d; const ls = buf.split(/\r?\n/); buf = ls.pop(); ls.forEach(onLine); });
        p.stderr.on("data", (d) => (err += d));
        p.on("error", (e) => reject(Object.assign(e, { spawnFailed: true })));
        p.on("close", (code) => {
          const f = fs.readdirSync(dir).find((n) => /^src\.(mp4|mkv|webm|mov)$/.test(n));
          if (code === 0 && f) return resolve({ file: path.join(dir, f), title });
          if (code === 0) return reject(new Error("No video was downloaded from that link (it may be longer than 3 hours, private, or not a video page)."));
          const msg = (err.match(/ERROR:.*$/m) || [err.trim().split("\n").pop() || "unknown error"])[0];
          if (/Sign in to confirm|bot|cookies/i.test(msg)) return reject(new Error("YouTube blocked the download from this server. Upload the video file instead, or add YT_COOKIES (see README)."));
          reject(new Error("Couldn't download that link: " + msg.slice(0, 300)));
        });
      });
    const exe = process.env.YTDLP_PATH || "yt-dlp";
    return attempt(exe, []).catch((e) => (e.spawnFailed ? attempt("python", ["-m", "yt_dlp"]).catch((e2) => {
      throw e2.spawnFailed ? new Error("yt-dlp is not installed on the server (set YTDLP_PATH).") : e2;
    }) : Promise.reject(e)));
  }

  function safeLink(u) {
    let x;
    try { x = new URL(u); } catch { return null; }
    if (!/^https?:$/.test(x.protocol)) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(x.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(x.hostname)) return null;
    return x.toString();
  }

  // ---------- direct file links (https://…/clip.mp4, Dropbox, Google Drive, S3, CDNs) ----------
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|3gp)$/i;
  function normalizeLink(u) {
    const x = new URL(u);
    if (/(^|\.)dropbox\.com$/i.test(x.hostname)) { x.searchParams.set("dl", "1"); return x.toString(); }
    const g = x.hostname === "drive.google.com" && (x.pathname.match(/\/file\/d\/([\w-]{10,})/) || [null, x.searchParams.get("id")]);
    if (g && g[1]) return `https://drive.usercontent.google.com/download?id=${g[1]}&export=download&confirm=t`;
    return u;
  }
  // Starts the download and decides from the response whether it's a video file. Returns the open response
  // when it is (caller reads or cancels it), or { direct: false } for a web page that yt-dlp should handle.
  async function probeDirect(link) {
    const r = await fetch(normalizeLink(link), { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 VideoStudio" }, signal: AbortSignal.timeout(20000) });
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const cd = r.headers.get("content-disposition") || "";
    let name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i) || [])[1] || "");
    if (!name) try { name = decodeURIComponent(new URL(r.url).pathname.split("/").pop() || ""); } catch {}
    const looksVideo = /^video\//.test(ct) || (/(octet-stream|binary|download)/.test(ct) && VIDEO_EXT.test(name));
    if (!r.ok || !looksVideo) { r.body?.cancel().catch(() => {}); return { direct: false, status: r.status, type: ct }; }
    const size = Number(r.headers.get("content-length")) || 0;
    return { direct: true, res: r, type: ct, size, name };
  }
  async function saveDirect(d, dir, job) {
    if (d.size > MAX_LINK) { d.res.body?.cancel().catch(() => {}); throw new Error(`That file is ${(d.size / 1048576).toFixed(0)} MB; the limit is ${MAX_LINK / 1048576} MB.`); }
    const ext = (d.name.match(VIDEO_EXT) || [, d.type.split("/")[1] || "mp4"])[1].toLowerCase().replace("quicktime", "mov");
    const file = path.join(dir, "src." + ext.replace(/[^a-z0-9]/g, ""));
    const ws = fs.createWriteStream(file);
    let got = 0;
    for await (const c of d.res.body) {
      got += c.length;
      if (got > MAX_LINK) { ws.destroy(); throw new Error(`That file is bigger than ${MAX_LINK / 1048576} MB.`); }
      if (!ws.write(c)) await new Promise((r) => ws.once("drain", r));
      if (d.size) setStep(job, 0, Math.min(14, (got / d.size) * 14));
    }
    await new Promise((r) => ws.end(r));
    return file;
  }

  // ---------- model calls ----------
  const parseJson = (t) => {
    const s = String(t || "").replace(/```(json)?/g, "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("The model didn't return JSON");
    return JSON.parse(s.slice(a, b + 1));
  };
  async function askVideo(job, file, prompt, maxTokens = 3000) {
    const b64 = fs.readFileSync(file).toString("base64");
    const r = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: maxTokens, temperature: 0.4,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } }] }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error("Video analysis failed: " + (j.error?.message || r.status));
    job.cost = (job.cost || 0) + (j.usage?.cost || 0);
    return parseJson(j.choices?.[0]?.message?.content);
  }

  const analysisPrompt = ({ duration, analysed, w, h, min, max, hint, title }) =>
    `You are a top YouTube Shorts editor. Watch this video${title ? ` (original title: "${title}")` : ""}. It is ${Math.round(duration)} s long, ${w}x${h}` +
    (analysed < duration ? `; you are seeing only the first ${Math.round(analysed)} s.` : ".") +
    ` Pick the single most engaging CONTINUOUS moment of ${min}-${max} seconds that works as a standalone vertical Short: a strong hook in the first 2 seconds, clear action or payoff, no dead air, starting and ending at natural cut points (never mid-sentence).` +
    (hint ? ` The creator asked for: ${hint}.` : "") +
    `\nReturn ONLY this JSON, no other text:\n{"start":0,"end":0,"framing":"crop","focus_x":0.5,"hook":"","title":"","description":"","hashtags":[],"thumbnail_time":0,"thumbnail_text":"","has_speech":true,"reason":""}\n` +
    `Rules:\n- start/end/thumbnail_time: seconds from the start of the video (numbers). end - start must be between ${min} and ${max}.\n` +
    `- framing: "crop" if the important action stays inside a central vertical strip (one person talking, one subject) - then focus_x is that subject's horizontal centre (0 = left edge, 1 = right edge). "fit" if important things span the width (gameplay with HUD, wide shots, on-screen text, burned-in subtitles, two people far apart).\n` +
    `- hook: on-screen text for the first 3 seconds, max 6 words, creates curiosity, no emojis; "" if the clip already hooks by itself.\n` +
    `- title: YouTube Shorts title, max 70 characters, punchy and honest, no hashtags.\n- description: 1-2 sentences plus a short call to action.\n` +
    `- hashtags: 3-6 relevant tags without "#", always include "shorts".\n- thumbnail_time: the most striking sharp frame inside the chosen moment.\n- thumbnail_text: 2-4 bold words for the thumbnail.\n` +
    `- has_speech: true if people speak during the chosen moment.\n- reason: one sentence on why this moment.\n- Write text fields in the language spoken in the video (English if there is no speech).`;

  const captionPrompt = (len) =>
    `Transcribe the speech in this ${len.toFixed(1)} s clip as captions for a vertical video. Return ONLY JSON: {"captions":[{"start":0.0,"end":0.0,"text":""}]}\n` +
    `Each caption is 1-4 words, in the spoken language, with start/end in seconds from the clip start (accurate to 0.1 s), in order and not overlapping. ` +
    `Spoken words only (no song lyrics, no sound descriptions). If nobody speaks, return {"captions":[]}.`;

  // ---------- editing ----------
  const even = (n) => Math.round(n / 2) * 2;
  function frameFilter(src, framing, focusX) {
    const sw = even((src.w * 1920) / src.h);
    if (framing === "crop" && sw >= 1080) {
      const x = Math.max(0, Math.min(sw - 1080, Math.round((focusX ?? 0.5) * sw - 540)));
      return `[0:v]scale=${sw}:1920,crop=1080:1920:${x}:0,setsar=1`;
    }
    // full frame on top of a blurred, darkened copy of itself
    return "[0:v]split=2[bga][fga];[bga]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.12[bg];" +
      "[fga]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1";
  }
  const assTime = (s) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
  };
  const assText = (t) => String(t || "").replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
  function assDoc(events) {
    return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n` +
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
      "Style: Cap,Anton,124,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3,2,80,80,600,1\n" +
      "Style: Hook,Anton,100,&H0000E5FF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3,8,70,70,250,1\n" +
      "Style: Thumb,Anton,176,&H0000E5FF,&H000000FF,&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,12,7,8,60,60,330,1\n\n" +
      "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
      events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.fx || ""}${assText(e.text)}`).join("\n") + "\n";
  }
  // relative path keeps Windows drive letters ("C:") out of the ffmpeg filter string
  const fontsArg = (cwd) => path.relative(cwd, FONTS).split(path.sep).join("/") || ".";

  // ---------- the pipeline ----------
  async function runShort(id, opts) {
    const job = jobs.get(id), dir = dirOf(id);
    const [min, max] = opts.len === "30-60" ? [30, 60] : [15, 30];
    try {
      setStep(job, 0, 1);
      let srcFile = opts.file, srcTitle = opts.title || "";
      if (opts.link) {
        // direct video file -> plain download; anything else (YouTube, X, Instagram…) -> yt-dlp
        const d = await probeDirect(opts.link).catch(() => ({ direct: false }));
        if (d.direct) { srcFile = await saveDirect(d, dir, job); srcTitle = d.name.replace(VIDEO_EXT, ""); }
        else ({ file: srcFile, title: srcTitle } = await download(opts.link, dir, job));
      }
      const src = await probe(srcFile);
      if (!src) throw new Error("That file isn't a readable video.");
      job.source = { title: srcTitle, link: opts.link || null, duration: Math.round(src.duration), w: src.w, h: src.h };

      // 1. cheap low-res proxy (1 fps, 240p, mono audio) so the model can watch the whole thing
      setStep(job, 1, 16);
      const analysed = Math.min(src.duration, ANALYSE_MAX);
      const proxy = path.join(dir, "proxy.mp4");
      await run(["-y", "-i", srcFile, "-t", String(analysed), "-vf", "scale=-2:240,fps=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "34",
        ...(src.audio ? ["-c:a", "aac", "-ac", "1", "-ar", "16000", "-b:a", "24k"] : ["-an"]), "proxy.mp4"], dir);
      setStep(job, 1, 24);
      const plan = await askVideo(job, proxy, analysisPrompt({ ...src, analysed, min, max, hint: opts.hint, title: srcTitle }));

      // 2. sanity-check the model's choice
      const total = analysed;
      let start = Math.max(0, Math.min(+plan.start || 0, total));
      let end = Math.min(total, +plan.end || start + max);
      if (total <= min) { start = 0; end = total; }
      else {
        if (end - start < min) end = Math.min(total, start + min);
        if (end - start < min) start = Math.max(0, end - min);
        if (end - start > max) end = start + max;
      }
      const len = end - start;
      const framing = plan.framing === "crop" ? "crop" : "fit";
      const focusX = Math.max(0, Math.min(1, Number(plan.focus_x) || 0.5));
      let thumbT = +plan.thumbnail_time;
      if (!(thumbT >= start && thumbT <= end)) thumbT = start + len * 0.35;
      job.plan = { start, end, framing, reason: plan.reason || "" };

      // 3. captions from the chosen moment only (precise timing on a short clip)
      setStep(job, 2, 40);
      let captions = [];
      if (src.audio && plan.has_speech !== false) {
        setStep(job, 3, 46);
        await run(["-y", "-ss", String(start), "-t", String(len), "-i", srcFile, "-vf", "scale=-2:360,fps=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
          "-c:a", "aac", "-ac", "1", "-b:a", "64k", "cap.mp4"], dir);
        try {
          const c = await askVideo(job, path.join(dir, "cap.mp4"), captionPrompt(len), 4000);
          captions = (Array.isArray(c.captions) ? c.captions : [])
            .map((x) => ({ start: +x.start, end: +x.end, text: String(x.text || "").trim() }))
            .filter((x) => x.text && x.end > x.start && x.start < len)
            .sort((a, b) => a.start - b.start);
          for (let i = 0; i < captions.length; i++) { // no overlaps, no flicker between close chunks
            const nx = captions[i + 1];
            if (nx && (captions[i].end > nx.start || nx.start - captions[i].end < 0.25)) captions[i].end = nx.start;
            captions[i].end = Math.min(captions[i].end, len);
          }
        } catch (e) { job.warning = "Captions skipped: " + e.message; }
      }
      const hook = String(plan.hook || "").trim();
      const events = [];
      if (hook) events.push({ start: 0, end: Math.min(3, len), style: "Hook", text: hook, fx: "{\\fad(120,250)}" });
      for (const c of captions) events.push({ start: c.start, end: c.end, style: "Cap", text: c.text, fx: "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" });
      fs.writeFileSync(path.join(dir, "subs.ass"), assDoc(events));

      // 4. render 1080x1920 @30fps, loudness to YouTube's -14 LUFS
      setStep(job, 4, 60);
      const fc = frameFilter(src, framing, focusX) + `[v0];[v0]fps=30,format=yuv420p,subtitles=subs.ass:fontsdir=${fontsArg(dir)}[v]`;
      await run(["-y", "-ss", String(start), "-t", String(len), "-i", srcFile, "-filter_complex", fc, "-map", "[v]",
        ...(src.audio ? ["-map", "0:a:0", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : ["-an"]),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-movflags", "+faststart", "short.mp4"], dir);

      // 5. thumbnail: best frame, same framing, big text
      setStep(job, 5, 90);
      const tt = String(plan.thumbnail_text || hook || "").trim();
      fs.writeFileSync(path.join(dir, "thumb.ass"), assDoc(tt ? [{ start: 0, end: 10, style: "Thumb", text: tt }] : []));
      await run(["-y", "-ss", String(thumbT), "-i", srcFile, "-frames:v", "1", "-filter_complex",
        frameFilter(src, framing, focusX) + `[v0];[v0]eq=contrast=1.08:saturation=1.2,subtitles=thumb.ass:fontsdir=${fontsArg(dir)}[v]`, "-map", "[v]", "-q:v", "2", "thumb.jpg"], dir);

      const tags = (Array.isArray(plan.hashtags) ? plan.hashtags : []).map((t) => String(t).replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean);
      if (!tags.some((t) => t.toLowerCase() === "shorts")) tags.push("shorts");
      const meta = {
        id, status: "done", createdAt: job.createdAt, source: job.source,
        start: +start.toFixed(2), end: +end.toFixed(2), framing, hook, captions: captions.length, reason: plan.reason || "",
        title: String(plan.title || srcTitle || "").slice(0, 100), description: String(plan.description || ""), hashtags: tags.slice(0, 8),
        thumbnailText: tt, cost: +(job.cost || 0).toFixed(4), warning: job.warning || null,
      };
      saveMeta(id, meta);
      Object.assign(job, { status: "done", pct: 100, step: "Done" });
    } catch (e) {
      Object.assign(job, { status: "failed", error: e.message.slice(0, 500) });
      saveMeta(id, { id, status: "failed", createdAt: job.createdAt, error: job.error, source: job.source || null });
    } finally {
      for (const f of fs.readdirSync(dir)) if (/^(src\.|proxy\.mp4|cap\.mp4|cookies\.txt|.*\.part$)/.test(f)) fs.rm(path.join(dir, f), { force: true }, () => {});
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
    }
  }

  const publicView = (id) => {
    const live = jobs.get(id);
    const m = live && live.status !== "done" ? { id, status: live.status, step: live.step, pct: live.pct, error: live.error, source: live.source, plan: live.plan, createdAt: live.createdAt } : readMeta(id);
    if (!m) return null;
    if (m.status === "done") Object.assign(m, { videoUrl: `/api/shorts/${id}/short.mp4`, thumbUrl: `/api/shorts/${id}/thumb.jpg` });
    return m;
  };
  const newJob = () => {
    const id = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    fs.mkdirSync(dirOf(id), { recursive: true });
    jobs.set(id, { status: "running", step: STEPS[0], pct: 0, createdAt: Date.now() });
    return id;
  };
  const readOpts = (q) => ({ len: q.get("len") === "30-60" ? "30-60" : "15-30", hint: String(q.get("hint") || "").slice(0, 300) });

  // ---------- routes; returns true when the request was handled ----------
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/shorts")) return false;
    let m;
    if (req.method === "POST" && url.pathname === "/api/shorts/upload") {
      if (!getKey()) return send(res, 500, { error: "OPENROUTER_API_KEY missing." }), true;
      const id = newJob(), file = path.join(dirOf(id), "src.upload");
      const ws = fs.createWriteStream(file);
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_UPLOAD) { ws.destroy(); jobs.delete(id); fs.rm(dirOf(id), { recursive: true, force: true }, () => {}); return send(res, 413, { error: "Video too large (max 500 MB). Paste a link instead." }), true; }
        if (!ws.write(c)) await new Promise((r) => ws.once("drain", r));
      }
      await new Promise((r) => ws.end(r));
      if (!size) { jobs.delete(id); fs.rm(dirOf(id), { recursive: true, force: true }, () => {}); return send(res, 400, { error: "Empty upload." }), true; }
      const name = decodeURIComponent(req.headers["x-filename"] || "").replace(/\.[a-z0-9]+$/i, "").slice(0, 120);
      runShort(id, { ...readOpts(url.searchParams), file, title: name });
      return send(res, 200, { id }), true;
    }
    if (req.method === "POST" && url.pathname === "/api/shorts/check") {
      let b = "";
      for await (const c of req) { b += c; if (b.length > 1e4) break; }
      let link = null;
      try { link = safeLink(String(JSON.parse(b || "{}").url || "").trim()); } catch {}
      if (!link) return send(res, 200, { ok: false, error: "Paste a full link starting with https://" }), true;
      const d = await probeDirect(link).catch((e) => ({ direct: false, error: e.name === "TimeoutError" ? "timeout" : e.message }));
      if (d.direct) { d.res.body?.cancel().catch(() => {}); return send(res, 200, { ok: true, kind: "direct", name: d.name, size: d.size, type: d.type }), true; }
      const host = new URL(link).hostname.replace(/^www\./, "");
      if (d.status === 404 || d.status === 410) return send(res, 200, { ok: false, error: `That link returns "not found" (${d.status}).` }), true;
      return send(res, 200, { ok: true, kind: "site", site: host }), true;
    }
    if (req.method === "POST" && url.pathname === "/api/shorts") {
      if (!getKey()) return send(res, 500, { error: "OPENROUTER_API_KEY missing." }), true;
      let b = "";
      for await (const c of req) { b += c; if (b.length > 1e5) break; }
      let body = {};
      try { body = JSON.parse(b || "{}"); } catch {}
      const link = safeLink(String(body.url || "").trim());
      if (!link) return send(res, 400, { error: "Paste a full video link starting with https://" }), true;
      const id = newJob();
      runShort(id, { len: body.len === "30-60" ? "30-60" : "15-30", hint: String(body.hint || "").slice(0, 300), link });
      return send(res, 200, { id }), true;
    }
    if (req.method === "GET" && url.pathname === "/api/shorts") {
      const ids = fs.readdirSync(DIR).filter((d) => /^\w+$/.test(d)).sort().reverse().slice(0, 30);
      return send(res, 200, { shorts: ids.map(publicView).filter(Boolean) }), true;
    }
    if ((m = url.pathname.match(/^\/api\/shorts\/(\w+)$/))) {
      if (req.method === "DELETE") {
        if (jobs.get(m[1])?.status === "running") return send(res, 409, { error: "Still working on it." }), true;
        jobs.delete(m[1]);
        fs.rmSync(dirOf(m[1]), { recursive: true, force: true });
        return send(res, 200, { ok: true }), true;
      }
      const v = publicView(m[1]);
      return (v ? send(res, 200, v) : send(res, 404, { error: "Unknown short" })), true;
    }
    if ((req.method === "GET" || req.method === "HEAD") && (m = url.pathname.match(/^\/api\/shorts\/(\w+)\/(short\.mp4|thumb\.jpg)$/))) {
      const f = path.join(dirOf(m[1]), m[2]), dl = url.searchParams.has("dl");
      if (m[2] === "short.mp4") return serveMp4(req, res, f, dl ? `short-${m[1]}.mp4` : false), true;
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end("Not found"), true; }
      const h = { "Content-Type": "image/jpeg" };
      if (dl) h["Content-Disposition"] = `attachment; filename="thumbnail-${m[1]}.jpg"`;
      res.writeHead(200, h);
      return fs.createReadStream(f).pipe(res), true;
    }
    return false;
  };
};
