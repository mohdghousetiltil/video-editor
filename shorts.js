// Shorts maker: take any long video (upload or link). A video-understanding model watches ALL of it (long videos in
// ~10 min parts with a burned-in clock, then the best candidates side by side), picks the strongest moment and edits
// it with jump cuts. ffmpeg reframes to 1080x1920 (smart crop or blurred background) with punch-in zooms, burns word
// captions + a hook line, can add an AI narrator (ducking the original sound), normalises loudness, and makes a
// thumbnail, title, description and hashtags.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { glitchFilter } = require("./glitch");
const { toSec, cleanSegments, parseTime } = require("./lib/cut");

// Narrator voices (OpenRouter /audio/speech). Kokoro costs ~$0.002 per minute; ElevenLabs sounds more natural.
const VOICES = [
  { voice: "am_michael", model: "hexgrad/kokoro-82m", label: "Michael (US male, Kokoro)" },
  { voice: "am_adam", model: "hexgrad/kokoro-82m", label: "Adam (US male, Kokoro)" },
  { voice: "af_heart", model: "hexgrad/kokoro-82m", label: "Heart (US female, Kokoro)" },
  { voice: "af_bella", model: "hexgrad/kokoro-82m", label: "Bella (US female, Kokoro)" },
  { voice: "bm_george", model: "hexgrad/kokoro-82m", label: "George (UK male, Kokoro)" },
  { voice: "bf_emma", model: "hexgrad/kokoro-82m", label: "Emma (UK female, Kokoro)" },
  { voice: "brian", model: "elevenlabs/eleven-turbo-v2.5", label: "Brian (ElevenLabs)" },
  { voice: "jessica", model: "elevenlabs/eleven-turbo-v2.5", label: "Jessica (ElevenLabs)" },
];

module.exports = function createShorts({ STORE, FFMPEG, API, getKey, run, send, serveMp4, tts, logSpend = () => {}, orFetch = fetch, renderSlot = (fn) => fn(), getModel = () => null, serveThumb }) {
  const DIR = path.join(STORE, "work", "shorts");
  // video-understanding model: Settings page choice, else SHORTS_MODEL, else Gemini Flash Lite
  const modelNow = () => getModel() || process.env.SHORTS_MODEL || "google/gemini-3.5-flash-lite";
  const FONTS = path.join(__dirname, "fonts"); // Anton (SIL OFL), used by the caption/thumbnail styles
  const MAX_UPLOAD = 500 * 1024 * 1024;
  const MAX_LINK = 1500 * 1024 * 1024; // direct-link downloads (same cap as yt-dlp)
  const ANALYSE_MAX = 3 * 3600; // same 3 h cap as downloads
  const SINGLE_MAX = 12 * 60; // up to this long, the model watches the video in one go
  const CHUNK = 10 * 60; // longer videos are scouted in parts of about this length
  const jobs = new Map(); // id -> live job (status lives on disk in meta.json once finished)
  fs.mkdirSync(DIR, { recursive: true });

  const STEPS = ["Getting the video", "Watching the whole video", "Picking the best moment", "Editing the cut", "Writing captions & voiceover", "Rendering the Short", "Making the thumbnail"];
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
    const model = modelNow();
    const r = await orFetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: Math.max(maxTokens, /muse-spark/.test(model) ? 8000 : 0), temperature: 0.4,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } }] }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const msg = j.error?.message || String(r.status);
      // OpenRouter answers 402 both when the account is empty and when this API key's own spend limit is used up.
      // The second is easy to miss: the account can show $5 while the key has only cents left.
      if (r.status === 402 || /credit|limit|afford/i.test(msg)) {
        const k = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${getKey()}` } }).then((x) => x.json()).catch(() => null);
        const left = k?.data?.limit_remaining;
        if (k?.data?.limit != null && left != null)
          throw new Error(`Video analysis failed: this OpenRouter API key has a $${k.data.limit} spend limit and only $${left.toFixed(2)} of it is left, ` +
            `even if your account has more credit. Raise or remove the key's limit at openrouter.ai/settings/keys. (OpenRouter said: ${msg})`);
        throw new Error(`Video analysis failed: OpenRouter needs more credit for this video. Add credit at openrouter.ai/settings/credits, or try a shorter video. (OpenRouter said: ${msg})`);
      }
      throw new Error("Video analysis failed: " + msg);
    }
    job.cost = (job.cost || 0) + (j.usage?.cost || 0);
    return parseJson(j.choices?.[0]?.message?.content);
  }

  const hms = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const CLOCK_NOTE = "Every frame shows a yellow clock in its top-left corner: that is the frame's exact time in the ORIGINAL full video (H:MM:SS.mmm). Read all times from that clock and give them as seconds from the start of the original video.";
  const WHAT_WORKS = "What works as a Short: a hook in the first 1-2 seconds (a bold claim, a question, a surprising visual, mid-action), a clear payoff (punchline, reveal, result, emotional peak), it makes sense without the rest of the video, and nothing boring in between. Avoid intros, greetings, sponsor reads, 'subscribe' asks, setup that needs earlier context, and dead air.";

  // Pass 1 on long videos: scout one ~10 min part for candidate moments.
  const scoutPrompt = ({ from, to, part, parts, min, max, hint, title }) =>
    `You are scouting a long video${title ? ` ("${title}")` : ""} for the best YouTube Shorts. This clip is part ${part} of ${parts} and covers ${hms(from)}-${hms(to)} of the full video. ${CLOCK_NOTE}\n` +
    `${WHAT_WORKS}${hint ? ` The creator wants: ${hint}.` : ""}\n` +
    `Find up to 3 of the strongest standalone moments in this part, each ${min}-${max} seconds, starting and ending at natural cut points. Score each 1-10 honestly against the other moments you see (10 = would go viral, 5 = fine, below 4 = don't bother). If nothing here is good, return fewer or none.\n` +
    `Return ONLY JSON: {"moments":[{"start":0,"end":0,"score":0,"summary":""}]}  (summary: one sentence on what happens and why it hooks)`;

  // Final pass: choose and edit the moment (on the whole video if short, else on a reel of the best candidates).
  const editPrompt = ({ duration, w, h, min, max, hint, title, candidates, range }) =>
    `You are a top short-form editor (TikTok, Reels, YouTube Shorts). ` +
    (range && !candidates ? `The creator chose the part ${hms(range[0])}-${hms(range[1])} of a ${hms(duration)} long video${title ? ` ("${title}")` : ""}; this clip is that part. Pick ONLY from it. ` : "") +
    (candidates
      ? `This clip is a reel of ${candidates.length} candidate windows cut from a ${hms(duration)} long video${title ? ` ("${title}")` : ""}. Scouts noted:\n` +
        candidates.map((c, i) => `${i + 1}) ${hms(c.start)}-${hms(c.end)}, score ${c.score}: ${c.summary}`).join("\n") + "\n"
      : range ? "" : `Watch this ${Math.round(duration)} s video${title ? ` ("${title}")` : ""}. `) +
    `Source frame size ${w}x${h}. ${CLOCK_NOTE}\n${WHAT_WORKS}${hint ? ` The creator asked for: ${hint}.` : ""}\n` +
    `Pick the single best moment and EDIT it into a ${min}-${max} second vertical Short: keep the strongest part, and cut out pauses, filler words, repetition and slow bits with jump cuts. The edit is a list of 1-4 pieces in time order, all from the same moment, each at least 2 seconds; together they must total ${min}-${max} seconds. Use one piece if it already flows. Never cut mid-word or mid-sentence. The first piece must open on the hook.\n` +
    `Return ONLY this JSON, no other text:\n{"segments":[{"start":0,"end":0}],"framing":"crop","focus_x":0.5,"hook":"","title":"","description":"","hashtags":[],"thumbnail_time":0,"thumbnail_text":"","has_speech":true,"reason":""}\n` +
    `Rules:\n- segments/thumbnail_time: seconds in the original video.\n` +
    `- framing: "crop" if the important action stays inside a central vertical strip (one person talking, one subject) - then focus_x is that subject's horizontal centre (0 = left edge, 1 = right edge). "fit" if important things span the width (gameplay with HUD, wide shots, on-screen text, burned-in subtitles, two people far apart).\n` +
    `- hook: on-screen text for the first 3 seconds, max 6 words, creates curiosity, no emojis; "" if the clip already hooks by itself.\n` +
    `- title: Shorts title, max 70 characters, punchy and honest, no hashtags.\n- description: 1-2 sentences plus a short call to action.\n` +
    `- hashtags: 3-6 relevant tags without "#", always include "shorts".\n- thumbnail_time: the most striking sharp frame inside the chosen pieces.\n- thumbnail_text: 2-4 bold words for the thumbnail.\n` +
    `- has_speech: true if people speak in the chosen pieces.\n- reason: one sentence on why this moment wins.\n- Write text fields in the language spoken in the video (English if there is no speech).`;

  // On the finished cut: word captions, plus the narrator's lines when a voiceover is wanted.
  const VO_RULES = {
    intro: "voiceover: exactly ONE line at start 0, 4-9 words, said like a creator teasing the clip (\"Watch what this guy does next\"), to be spoken over the first ~3 seconds.",
    full: "voiceover: commentary by an energetic but natural creator narrating this clip for TikTok: an opening hook line at start 0, then short lines (max ~2.5 words per second of the gap they sit in) placed ONLY in moments where nobody in the clip is speaking, building to the payoff; leave the payoff itself and any important speech un-narrated. 2-6 lines.",
    auto: "voiceover: if people in the clip carry the story with their speech, write only ONE hook line at start 0 (4-9 words, over the first ~3 seconds). If there's little or no speech (gameplay, sports, scenery, action, music), narrate it like an energetic creator: a hook at start 0, then short lines only where nobody is speaking (max ~2.5 words per second of the gap), building to the payoff. 1-6 lines.",
  };
  const captionPrompt = (len, vo) =>
    `This is a ${len.toFixed(1)} s vertical Short. Return ONLY JSON: {"captions":[{"start":0.0,"end":0.0,"text":""}]${vo ? ',"voiceover":[{"start":0.0,"text":""}]' : ""}}\n` +
    `captions: the speech in the clip as captions; each caption 1-4 words, in the spoken language, start/end in seconds from the clip start (accurate to 0.1 s), in order, not overlapping. Spoken words only (no song lyrics, no sound descriptions); [] if nobody speaks.\n` +
    (vo ? `${VO_RULES[vo]} Never describe the obvious or say "in this video". Write it in the spoken language of the clip (English if none). start is seconds from the clip start.` : "");

  // ---------- editing ----------
  const even = (n) => Math.round(n / 2) * 2;
  // 9:16 framing of input `inp` -> 1080x1920; `t` keeps the internal labels unique when used several times.
  function frameFilter(src, framing, focusX, inp = "[0:v]", t = "") {
    const sw = even((src.w * 1920) / src.h);
    if (framing === "crop" && sw >= 1080) {
      const x = Math.max(0, Math.min(sw - 1080, Math.round((focusX ?? 0.5) * sw - 540)));
      return `${inp}scale=${sw}:1920,crop=1080:1920:${x}:0,setsar=1`;
    }
    // full frame on top of a blurred, darkened copy of itself
    return `${inp}split=2[bga${t}][fga${t}];[bga${t}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.12[bg${t}];` +
      `[fga${t}]scale=1080:1920:force_original_aspect_ratio=decrease[fg${t}];[bg${t}][fg${t}]overlay=(W-w)/2:(H-h)/2,setsar=1`;
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
      "Style: Vo,Anton,112,&H0000E5FF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3,2,80,80,600,1\n" +
      "Style: Hook,Anton,100,&H0000E5FF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3,8,70,70,250,1\n" +
      "Style: Thumb,Anton,176,&H0000E5FF,&H000000FF,&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,12,7,8,60,60,330,1\n\n" +
      "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
      events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.fx || ""}${assText(e.text)}`).join("\n") + "\n";
  }
  // relative path keeps Windows drive letters ("C:") out of the ffmpeg filter string
  const fontsArg = (cwd) => path.relative(cwd, FONTS).split(path.sep).join("/") || ".";
  // low-res copy for the model, with the original-video time burned into every frame
  const clockVf = (dir, offset, height, fps) =>
    `scale=-2:${height},fps=${fps},drawtext=fontfile=${fontsArg(dir)}/Anton-Regular.ttf:text='%{pts\\:hms\\:${offset.toFixed(3)}}':x=6:y=6:fontsize=${Math.round(height / 9)}:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=4`;
  async function proxyClip(dir, srcFile, src, from, len, out, height = 240, fps = 1) {
    await run(["-y", "-ss", from.toFixed(3), "-t", len.toFixed(3), "-i", srcFile, "-vf", clockVf(dir, from, height, fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "34", ...(src.audio ? ["-c:a", "aac", "-ac", "1", "-ar", "16000", "-b:a", "24k"] : ["-an"]), out], dir);
    return path.join(dir, out);
  }
  const audioLen = (file) =>
    new Promise((resolve) => {
      const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
      let e = "";
      p.stderr.on("data", (d) => (e += d));
      p.on("error", () => resolve(0));
      p.on("close", () => { const d = e.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/); resolve(d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0); });
    });
  // run async fn over items, `n` at a time
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
    return out;
  }

  // Clean up the model's edit: in-range, ordered, no overlaps, each piece >= 1.5 s, total within [min, max].
  // ---------- the pipeline ----------
  async function runShort(id, opts) {
    const job = jobs.get(id), dir = dirOf(id);
    let [min, max] = opts.len === "30-60" ? [30, 60] : [15, 30];
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
      // the part to search: the creator's time range, or the whole video
      let lo = 0, hi = src.duration;
      if (opts.from != null || opts.to != null) {
        const a = Math.max(0, Math.min(opts.from ?? 0, src.duration)), b = Math.min(src.duration, opts.to ?? src.duration);
        if (b - a >= 3) { lo = a; hi = b; } else job.warning = `The time range ${hms(opts.from ?? 0)}-${hms(opts.to ?? src.duration)} doesn't fit this ${hms(src.duration)} video, so the whole video was searched.`;
      }
      if (hi - lo > ANALYSE_MAX) { hi = lo + ANALYSE_MAX; job.warning = `Only ${hms(lo)}-${hms(hi)} was searched (3 hour limit).`; }
      const span = hi - lo, ranged = lo > 0 || hi < src.duration;
      if (span < min) { min = Math.max(3, Math.floor(span)); max = Math.max(min, Math.floor(span)); } // a short range is used as it is
      job.range = ranged ? [Math.round(lo), Math.round(hi)] : null;
      const total = hi;
      const base = { ...src, duration: src.duration, min, max, hint: opts.hint, title: srcTitle, range: ranged ? [lo, hi] : null };

      // 1. watch the WHOLE video. Short ones in one go; long ones in ~10 min parts (timestamps stay accurate),
      //    then the best candidates from every part are compared side by side.
      setStep(job, 1, 16);
      let plan;
      if (span <= SINGLE_MAX) {
        const proxy = await proxyClip(dir, srcFile, src, lo, span, "proxy.mp4");
        setStep(job, 2, 30);
        plan = await askVideo(job, proxy, editPrompt(base));
      } else {
        const n = Math.round(span / CHUNK) || 1, size = span / n;
        const parts = Array.from({ length: n }, (_, i) => ({ from: lo + i * size, to: Math.min(hi, lo + (i + 1) * size) }));
        let done = 0;
        const found = await pool(parts, 3, async (p, i) => {
          const f = await proxyClip(dir, srcFile, src, p.from, p.to - p.from, `part${i}.mp4`);
          const r = await askVideo(job, f, scoutPrompt({ ...base, ...p, part: i + 1, parts: n }), 1200).catch(() => ({ moments: [] }));
          setStep(job, 1, 16 + (++done / n) * 22);
          return (Array.isArray(r.moments) ? r.moments : [])
            .map((m) => ({ start: Math.max(p.from - 5, toSec(m.start)), end: Math.min(p.to + 5, toSec(m.end)), score: Math.max(0, Math.min(10, +m.score || 0)), summary: String(m.summary || "").slice(0, 200) }))
            .filter((m) => isFinite(m.start) && isFinite(m.end) && m.end - m.start >= 5);
        });
        const all = found.flat().sort((a, b) => b.score - a.score), cands = [];
        for (const m of all) {
          if (cands.length >= 4) break;
          if (!cands.some((c) => Math.min(c.end, m.end) - Math.max(c.start, m.start) > 0.5 * (m.end - m.start))) cands.push(m);
        }
        if (!cands.length) throw new Error("The AI couldn't find a moment worth posting in this video. Try a hint (e.g. \"the funniest part\").");
        job.candidates = cands.length;
        // reel of the candidate windows (a little context either side), clock still showing original-video time
        setStep(job, 2, 40);
        cands.sort((a, b) => a.start - b.start);
        const list = [];
        for (let i = 0; i < cands.length; i++) {
          const ws = Math.max(lo, cands[i].start - 6), we = Math.min(hi, cands[i].end + 6);
          await proxyClip(dir, srcFile, src, ws, we - ws, `win${i}.mp4`, 360, 2);
          list.push(`file 'win${i}.mp4'`);
        }
        fs.writeFileSync(path.join(dir, "wins.txt"), list.join("\n"));
        await run(["-y", "-f", "concat", "-safe", "0", "-i", "wins.txt", "-c", "copy", "reel.mp4"], dir);
        plan = await askVideo(job, path.join(dir, "reel.mp4"), editPrompt({ ...base, candidates: cands }));
      }

      // 2. sanity-check the edit
      const segs = cleanSegments(plan, lo, hi, min, max);
      const start = segs[0].start, end = segs[segs.length - 1].end;
      const len = segs.reduce((a, s) => a + s.end - s.start, 0);
      const framing = plan.framing === "crop" ? "crop" : "fit";
      const focusX = Math.max(0, Math.min(1, Number(plan.focus_x) || 0.5));
      let thumbT = toSec(plan.thumbnail_time);
      if (!segs.some((s) => thumbT >= s.start && thumbT <= s.end)) thumbT = segs[0].start + (segs[0].end - segs[0].start) * 0.35;
      job.plan = { start, end, framing, segments: segs, reason: plan.reason || "" };

      // 3. the edit: jump cuts between pieces, and a punch-in zoom that alternates every few seconds
      //    (the "beat" rhythm short-form editors use) so the picture never sits still for long.
      setStep(job, 3, 50);
      const zoom = opts.edit !== "clean";
      const beats = [];
      for (const s of segs) {
        const d = s.end - s.start, k = zoom ? Math.max(1, Math.round(d / 4.5)) : 1;
        for (let i = 0; i < k; i++) beats.push({ start: s.start + (d * i) / k - start, end: s.start + (d * (i + 1)) / k - start, z: zoom && beats.length % 2 === 1 });
      }
      let fc = `[0:v]fps=30,split=${beats.length}${beats.map((_, i) => `[s${i}]`).join("")};`;
      beats.forEach((b, i) => {
        fc += frameFilter(src, framing, focusX, `[s${i}]trim=start=${b.start.toFixed(3)}:end=${b.end.toFixed(3)},setpts=PTS-STARTPTS,`, i) +
          (b.z ? ",scale=1210:2150,crop=1080:1920,setsar=1" : "") + `[v${i}];`;
      });
      fc += beats.map((_, i) => `[v${i}]`).join("") + `concat=n=${beats.length}:v=1:a=0[vc]`;
      if (src.audio) {
        fc += `;[0:a]asplit=${segs.length}${segs.map((_, i) => `[as${i}]`).join("")};`;
        segs.forEach((s, i) => {
          const a = s.start - start, b = s.end - start;
          fc += `[as${i}]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${(b - a - 0.04).toFixed(3)}:d=0.04[a${i}];`;
        });
        fc += segs.map((_, i) => `[a${i}]`).join("") + `concat=n=${segs.length}:v=0:a=1[ac]`;
      }
      await run(["-y", "-ss", start.toFixed(3), "-t", (end - start + 0.1).toFixed(3), "-i", srcFile, "-filter_complex", fc, "-map", "[vc]",
        ...(src.audio ? ["-map", "[ac]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : ["-an"]),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "cut.mp4"], dir);
      const cutLen = (await audioLen(path.join(dir, "cut.mp4"))) || len;

      // 4. captions + voiceover script, from the finished cut (so timings match what viewers see)
      setStep(job, 4, 62);
      const vo = ["intro", "full", "auto"].includes(opts.narration) ? opts.narration : null;
      let captions = [], lines = [];
      if ((src.audio && plan.has_speech !== false) || vo) {
        await run(["-y", "-i", "cut.mp4", "-vf", "scale=-2:360,fps=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
          ...(src.audio ? ["-c:a", "aac", "-ac", "1", "-b:a", "64k"] : ["-an"]), "cap.mp4"], dir);
        try {
          const c = await askVideo(job, path.join(dir, "cap.mp4"), captionPrompt(cutLen, vo), 4000);
          captions = (Array.isArray(c.captions) ? c.captions : [])
            .map((x) => ({ start: +x.start, end: +x.end, text: String(x.text || "").trim() }))
            .filter((x) => x.text && x.end > x.start && x.start < cutLen)
            .sort((a, b) => a.start - b.start)
            // the model sometimes returns whole sentences: split into 3-word pop-ups timed by length
            .flatMap((x) => {
              const w = x.text.split(/\s+/);
              if (w.length <= 4) return [x];
              const parts = [];
              for (let i = 0; i < w.length; i += 3) parts.push(w.slice(i, i + 3).join(" "));
              const chars = parts.reduce((a, p) => a + p.length + 1, 0);
              let t = x.start;
              return parts.map((p) => { const d = ((p.length + 1) / chars) * (x.end - x.start), c = { start: t, end: t + d, text: p }; t += d; return c; });
            });
          lines = (Array.isArray(c.voiceover) ? c.voiceover : [])
            .map((x) => ({ start: Math.max(0, +x.start || 0), text: String(x.text || "").replace(/\s+/g, " ").trim().slice(0, 300) }))
            .filter((x) => x.text && x.start < cutLen - 1)
            .sort((a, b) => a.start - b.start)
            .slice(0, vo === "intro" ? 1 : 6);
        } catch (e) { job.warning = "Captions skipped: " + e.message; }
      }

      // 5. voice the narrator lines; each line gets the time until the next line (sped up a little if needed)
      const voiced = [];
      if (lines.length && tts) {
        setStep(job, 4, 70);
        const voice = opts.voice || VOICES[0].voice, model = (VOICES.find((v) => v.voice === voice) || VOICES[0]).model;
        await pool(lines, 3, async (l, i) => {
          try {
            fs.writeFileSync(path.join(dir, `vo${i}.mp3`), await tts({ model, voice, text: l.text }));
            l.file = `vo${i}.mp3`; l.dur = await audioLen(path.join(dir, l.file));
          } catch (e) { job.warning = "Voiceover partly skipped: " + e.message.slice(0, 160); }
        });
        let cursor = 0;
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (!l.file || !l.dur) continue;
          l.start = Math.max(l.start, cursor);
          const room = Math.min(lines[i + 1] ? Math.max(lines[i + 1].start, l.start + 1) : cutLen, cutLen) - l.start - 0.1;
          if (room < 0.8) continue;
          l.tempo = Math.max(1, Math.min(1.25, l.dur / room));
          l.end = l.start + Math.min(room, l.dur / l.tempo);
          cursor = l.end + 0.15;
          voiced.push(l);
          job.ttsCost = (job.ttsCost || 0) + l.dur * (/eleven/.test(model) ? 0.0005 : 0.00003);
          job.cost = (job.cost || 0) + l.dur * (/eleven/.test(model) ? 0.0005 : 0.00003);
        }
      }

      // speech captions, then narrator captions wherever nobody is being captioned
      for (let i = 0; i < captions.length; i++) { // no overlaps, no flicker between close chunks
        const nx = captions[i + 1];
        if (nx && (captions[i].end > nx.start || nx.start - captions[i].end < 0.25)) captions[i].end = nx.start;
        captions[i].end = Math.min(captions[i].end, cutLen);
      }
      const voCaps = [];
      for (const l of voiced) {
        const words = l.text.split(" "), chunks = [];
        for (let i = 0; i < words.length; i += 3) chunks.push(words.slice(i, i + 3).join(" "));
        const chars = chunks.reduce((a, c) => a + c.length + 1, 0);
        let t = l.start;
        for (const c of chunks) {
          const d = ((c.length + 1) / chars) * (l.end - l.start);
          if (!captions.some((x) => x.start < t + d && x.end > t)) voCaps.push({ start: t, end: t + d, text: c });
          t += d;
        }
      }
      const hook = String(plan.hook || "").trim();
      const events = [];
      if (hook) events.push({ start: 0, end: Math.min(3, cutLen), style: "Hook", text: hook, fx: "{\\fad(120,250)}" });
      for (const c of captions) events.push({ start: c.start, end: c.end, style: "Cap", text: c.text, fx: "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" });
      for (const c of voCaps) events.push({ start: c.start, end: c.end, style: "Vo", text: c.text, fx: "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" });
      fs.writeFileSync(path.join(dir, "subs.ass"), assDoc(events));

      // 6. final render: captions burned in; original sound ducked under the narrator; loudness to -14 LUFS
      setStep(job, 5, 76);
      const ins = ["-i", "cut.mp4"];
      if (!src.audio) ins.push("-f", "lavfi", "-t", cutLen.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
      voiced.forEach((l) => ins.push("-i", l.file));
      const o = src.audio ? "0:a" : "1:a", first = src.audio ? 1 : 2;
      // optional neon-glitch look goes under the captions, so the text stays sharp
      let af = (opts.look === "glitch" ? glitchFilter("[0:v]", "[gv];[gv]", 1080, 1920, cutLen, cutLen) : "[0:v]") + `subtitles=subs.ass:fontsdir=${fontsArg(dir)}[v];`;
      if (voiced.length) {
        const duck = voiced.map((l) => `between(t,${(l.start - 0.1).toFixed(2)},${(l.end + 0.2).toFixed(2)})`).join("+");
        af += `[${o}]volume='if(${duck},0.22,1)':eval=frame[orig];`;
        voiced.forEach((l, i) => {
          const ms = Math.round(l.start * 1000);
          af += `[${first + i}:a]aresample=48000,atempo=${l.tempo.toFixed(3)},atrim=end=${(l.end - l.start).toFixed(3)},afade=t=out:st=${Math.max(0, l.end - l.start - 0.08).toFixed(3)}:d=0.08,adelay=${ms}|${ms},volume=1.5[n${i}];`;
        });
        af += `[orig]${voiced.map((_, i) => `[n${i}]`).join("")}amix=inputs=${voiced.length + 1}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
      } else af += `[${o}]loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
      await run(["-y", ...ins, "-filter_complex", af, "-map", "[v]", "-map", "[a]", "-t", cutLen.toFixed(3),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-movflags", "+faststart", "short.mp4"], dir);

      // 7. thumbnail: best frame, same framing, big text
      setStep(job, 6, 92);
      const tt = String(plan.thumbnail_text || hook || "").trim();
      fs.writeFileSync(path.join(dir, "thumb.ass"), assDoc(tt ? [{ start: 0, end: 10, style: "Thumb", text: tt }] : []));
      await run(["-y", "-ss", String(thumbT), "-i", srcFile, "-frames:v", "1", "-filter_complex",
        frameFilter(src, framing, focusX) + `[v0];[v0]eq=contrast=1.08:saturation=1.2,subtitles=thumb.ass:fontsdir=${fontsArg(dir)}[v]`, "-map", "[v]", "-q:v", "2", "thumb.jpg"], dir);

      const tags = (Array.isArray(plan.hashtags) ? plan.hashtags : []).map((t) => String(t).replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean);
      if (!tags.some((t) => t.toLowerCase() === "shorts")) tags.push("shorts");
      const meta = {
        id, status: "done", createdAt: job.createdAt, source: job.source,
        start, end, segments: segs, range: job.range, length: +cutLen.toFixed(1), framing, hook, captions: captions.length, reason: plan.reason || "",
        voiceover: voiced.map((l) => l.text), candidates: job.candidates || 0,
        title: String(plan.title || srcTitle || "").slice(0, 100), description: String(plan.description || ""), hashtags: tags.slice(0, 8),
        look: opts.look, thumbnailText: tt, cost: +(job.cost || 0).toFixed(4), warning: job.warning || null,
      };
      saveMeta(id, meta);
      Object.assign(job, { status: "done", pct: 100, step: "Done" });
    } catch (e) {
      Object.assign(job, { status: "failed", error: e.message.slice(0, 500) });
      saveMeta(id, { id, status: "failed", createdAt: job.createdAt, error: job.error, source: job.source || null });
    } finally {
      logSpend("Shorts", (job.cost || 0) - (job.ttsCost || 0), modelNow(), "short-" + id); // voice is logged by tts() itself
      for (const f of fs.readdirSync(dir)) if (/^(src\.|proxy\.mp4|part\d+\.mp4|win\d+\.mp4|wins\.txt|reel\.mp4|cut\.mp4|cap\.mp4|vo\d+\.mp3|cookies\.txt|.*\.part$)/.test(f)) fs.rm(path.join(dir, f), { force: true }, () => {});
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
    }
  }

  const publicView = (id) => {
    const live = jobs.get(id);
    const m = live && live.status !== "done" ? { id, status: live.status, step: live.step, pct: live.pct, error: live.error, source: live.source, plan: live.plan, range: live.range, createdAt: live.createdAt } : readMeta(id);
    if (!m) return null;
    if (m.status === "done") Object.assign(m, { videoUrl: `/api/shorts/${id}/short.mp4`, thumbUrl: `/api/shorts/${id}/thumb.jpg` });
    return m;
  };
  // Shorts that were mid-way when the server stopped can't be resumed; mark them so they don't spin forever.
  for (const d of fs.readdirSync(DIR)) {
    const m = /^\w+$/.test(d) && readMeta(d);
    if (m && m.status === "running") saveMeta(d, { ...m, status: "failed", error: "The server restarted while this Short was being made. Make it again." });
  }
  const start = (id, opts) => {
    const job = jobs.get(id);
    job.step = "Waiting for a free render slot"; // another Short or Story is rendering
    saveMeta(id, { id, status: "running", createdAt: job.createdAt, source: { title: opts.title || "", link: opts.link || null } });
    renderSlot(() => runShort(id, opts));
  };
  const newJob = () => {
    const id = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    fs.mkdirSync(dirOf(id), { recursive: true });
    jobs.set(id, { status: "running", step: STEPS[0], pct: 0, createdAt: Date.now() });
    return id;
  };
  // get = (name) => value, from the query string (uploads) or the JSON body (links)
  const readOpts = (get) => ({
    len: get("len") === "30-60" ? "30-60" : "15-30",
    hint: String(get("hint") || "").slice(0, 300),
    narration: ["auto", "intro", "full"].includes(get("narration")) ? get("narration") : "off",
    voice: VOICES.some((v) => v.voice === get("voice")) ? get("voice") : VOICES[0].voice,
    edit: get("edit") === "clean" ? "clean" : "dynamic",
    from: parseTime(get("from")), to: parseTime(get("to")),
    look: get("look") === "glitch" ? "glitch" : "clean",
  });

  // ---------- routes; returns true when the request was handled ----------
  const busy = (id) => jobs.get(id)?.status === "running";
  return { busy, handle: async function handle(req, res, url) {
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
      start(id, { ...readOpts((k) => url.searchParams.get(k)), file, title: name });
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
      start(id, { ...readOpts((k) => (body[k] == null ? null : String(body[k]))), link });
      return send(res, 200, { id }), true;
    }
    if (req.method === "GET" && url.pathname === "/api/shorts/voices") return send(res, 200, { voices: VOICES.map(({ voice, label }) => ({ voice, label })) }), true;
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
  } };
};
