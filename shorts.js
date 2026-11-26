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

// estimated voice price per second of speech (the voice service doesn't report cost); same numbers as lib/spend.js
const TTS_RATE = { "hexgrad/kokoro-82m": 0.00003, "elevenlabs/eleven-turbo-v2.5": 0.0005 };
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

const { MOOD_EXPR, MOODS, renderMood } = require("./lib/music");
const hing = require("./lib/hinglish"); // Hinglish mode
const { cameoPrompt } = require("./lib/identity-prompt");

// Influencer cameo (Pictures -> explainer): a saved influencer is drawn into up to CAMEO_MAX of the pictures.
const CAMEO_MAX = 3;
// estimated price of one cameo picture per image model (shown before paying; the real charge is what gets logged)
const CAMEO_PRICE = { "meta/muse-image": 0.01, "google/gemini-3.1-flash-image": 0.07, "bytedance-seed/seedream-5-0-lite": 0.035, "black-forest-labs/flux-3-image-klein": 0.015 };
const cameoPrice = (model) => CAMEO_PRICE[model] ?? 0.07;
// which of the n narrated pictures the person appears in: the hook first, then the payoff, then the middle
function cameoSlides(n, count) {
  const want = [0, n - 1, Math.floor((n - 1) / 2)].slice(0, Math.max(0, Math.min(CAMEO_MAX, count)));
  return [...new Set(want)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
}
// What is on screen when: one shot per line, except a line with a cameo, which opens on the person presenting and
// then crossfades to the untouched original, so nothing in the user's picture is lost. X = crossfade length.
function pictureShots(slides, X) {
  return slides.flatMap((s) => {
    if (!s.cameo) return [{ file: s.file, start: s.start, D: s.D }];
    const a = s.D * 0.55;
    return [{ file: s.cameo, start: s.start, D: a }, { file: s.file, start: s.start + a - X, D: s.D - a + X, inner: true }];
  });
}

module.exports = function createShorts({ STORE, FFMPEG, API, getKey, run, send, serveMp4, tts, logSpend = () => {}, orFetch = fetch, renderSlot = null, getModel = () => null, serveThumb, history = null,
  readInf = () => [], imgFile = () => undefined, viewFile = () => undefined, getImageModel = () => "meta/muse-image" }) {
  if (!renderSlot || !renderSlot.submit) renderSlot = require("./lib/render").createRenderer({ slots: 99 }); // stand-alone use: no limit
  const hist = (id, rec) => { try { history && history.put("short-" + id, { kind: "short", url: `/api/shorts/${id}/short.mp4`, thumb: `/api/shorts/${id}/thumb.jpg`, ...rec }); } catch {} };
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

  // length of any media file, audio-only included (probe above needs a video stream)
  const audioDuration = (file) => new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
    let e = "";
    p.stderr.on("data", (d) => (e += d));
    p.on("error", () => resolve(0));
    p.on("close", () => { const d = e.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/); resolve(d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0); });
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

  // length / title / thumbnail of a site link without downloading it (for the preflight check), or null
  function linkInfo(link) {
    const args = ["-J", "--no-playlist", "--no-warnings", "--skip-download", "--js-runtimes", "node", link];
    const attempt = (exe, pre) => new Promise((resolve) => {
      let out = "";
      const p = spawn(exe, [...pre, ...args]);
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 25000);
      p.stdout.on("data", (d) => { out += d; if (out.length > 5e6) p.kill(); });
      p.on("error", () => { clearTimeout(t); resolve(null); });
      p.on("close", () => { clearTimeout(t); try { const j = JSON.parse(out); resolve({ duration: +j.duration || null, title: j.title || "", thumbnail: j.thumbnail || null }); } catch { resolve(null); } });
    });
    return attempt(process.env.YTDLP_PATH || "yt-dlp", []);
  }
  // background music: an uploaded track (work/shorts/music/<id>.*) or one made right here from maths (ffmpeg
  // aevalsrc), so there are never any rights issues. "pad" is the older soft chord bed, kept for saved settings.
  const MUSIC = path.join(DIR, "music");
  fs.mkdirSync(MUSIC, { recursive: true });
  // the moods (upbeat, suspense, cinematic, chill, epic, funny) live in lib/music.js, shared with Single clip
  async function musicPath(m, dir, len) {
    if (m === "pad") m = "chill";
    if (MOOD_EXPR[m]) return renderMood(run, m, dir, len);
    const f = fs.readdirSync(MUSIC).find((n) => n.startsWith(m + "."));
    return f ? path.join(MUSIC, f) : null;
  }
  // sound effects, also made from maths: a sub boom for the hook, a rewind sweep into the story, a whoosh on cuts
  const SFX = {
    boom: "aevalsrc='0.9*sin(2*PI*(30+70*exp(-12*t))*t)*exp(-3.5*t)':s=48000:d=1.2",
    rewind: "aevalsrc='0.35*sin(2*PI*(1800*exp(-5*t)+120)*t)*(1-t/0.5)':s=48000:d=0.5",
    whoosh: "anoisesrc=d=0.45:c=pink:a=0.5:r=48000,afade=t=in:d=0.28,afade=t=out:st=0.28:d=0.17,bandpass=f=1800:width_type=o:w=2",
  };
  async function sfxPath(kind, dir) {
    const f = `sfx-${kind}.wav`;
    if (!fs.existsSync(path.join(dir, f))) await run(["-y", "-f", "lavfi", "-i", SFX[kind], "-ac", "2", f], dir);
    return f;
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
  // Models now and then send JSON with a stray character in it; ask once more (stricter) before giving up.
  async function askVideo(job, file, prompt, maxTokens = 3000, retry = true) {
    if (job && job.lang) prompt += "\n\n" + hing.RULE + " Here that means the JSON text fields hook, title, description, thumbnail_text, captions and voiceover are Hinglish (hashtags are short words in English letters). This replaces any instruction above about the language of the text: captions of Hindi speech are written in Roman letters too, never Devanagari.";
    try { return await askVideoOnce(job, file, prompt, maxTokens, 0.4); }
    catch (e) {
      if (!retry || !e.badJson) throw e;
      return askVideoOnce(job, file, prompt + "\nIMPORTANT: answer with ONE valid JSON object only: double-quoted keys and strings, no comments, no trailing commas.", maxTokens, 0.1);
    }
  }
  async function askVideoOnce(job, file, prompt, maxTokens, temperature) {
    const b64 = fs.readFileSync(file).toString("base64");
    const model = modelNow();
    const r = await orFetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: Math.max(maxTokens, /muse-spark/.test(model) ? 8000 : 0), temperature,
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
    try { const out = parseJson(j.choices?.[0]?.message?.content); return job && job.lang ? hing.scrubDeep(out) : out; }
    catch (e) { throw Object.assign(new Error("The AI's answer couldn't be read (" + e.message + "). Try again."), { badJson: true }); }
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
    `Return ONLY this JSON, no other text:\n{"segments":[{"start":0,"end":0}],"teaser":{"start":0,"end":0},"mood":"","framing":"crop","focus_x":0.5,"hook":"","title":"","description":"","hashtags":[],"thumbnail_time":0,"thumbnail_text":"","has_speech":true,"reason":""}\n` +
    `Rules:\n- segments/thumbnail_time: seconds in the original video.\n` +
    `- framing: "crop" if the important action stays inside a central vertical strip (one person talking, one subject) - then focus_x is that subject's horizontal centre (0 = left edge, 1 = right edge). "fit" if important things span the width (gameplay with HUD, wide shots, on-screen text, burned-in subtitles, two people far apart).\n` +
    `- teaser: 1-2 seconds of the most surprising or satisfying instant (the payoff, the reveal, the crash, the punchline) INSIDE the chosen pieces; it is flashed first as a cold open before the story starts. {"start":0,"end":0} if nothing stands out.
` +
    `- mood: the music that fits, one of: ${MOODS.join(", ")} (cinematic for dramatic, emotional or story moments).
` +
    `- hook: on-screen text for the first 3 seconds, max 6 words, creates curiosity, no emojis; "" if the clip already hooks by itself.\n` +
    `- title: Shorts title, max 70 characters, punchy and honest, no hashtags.\n- description: 1-2 sentences plus a short call to action.\n` +
    `- hashtags: 3-6 relevant tags without "#", always include "shorts".\n- thumbnail_time: the most striking sharp frame inside the chosen pieces.\n- thumbnail_text: 2-4 bold words for the thumbnail.\n` +
    `- has_speech: true if people speak in the chosen pieces.\n- reason: one sentence on why this moment wins.\n- Write text fields in the language spoken in the video (English if there is no speech).`;

  // On the finished cut: word captions, plus the narrator's lines when a voiceover is wanted.
  const VO_RULES = {
    intro: "voiceover: exactly ONE line at start 0, 4-9 words, said like a creator teasing the clip (\"Watch what this guy does next\"), to be spoken over the first ~3 seconds.",
    full: "voiceover: commentary by an energetic but natural creator narrating this clip for TikTok: an opening hook line at start 0, then short lines (max ~2.5 words per second of the gap they sit in) placed ONLY in moments where nobody in the clip is speaking, building to the payoff; leave the payoff itself and any important speech un-narrated. 2-6 lines.",
    story: "voiceover: tell this clip like a storytelling creator. The clip opens with a TEASER_S s flash of the payoff, then the story plays from the start. Line 1 at start 0, over the teaser: a curiosity hook, 3-7 words (\"Wait till you see what happens.\" / \"Nobody expected this.\"). Line 2 right after the teaser: lead into the story (\"So it happened like this.\" / \"Here's how it started.\"). Then 2-4 short lines recounting what is going on, in past tense like telling a friend, building suspense, placed ONLY where nobody in the clip is speaking (max ~2.5 words per second of the gap). Quiet or music-only stretches longer than 3 s MUST get a line, so the Short never goes silent. Let the payoff play un-narrated; optionally one short reaction line in the last 2 s. 3-7 lines in total.",
    auto: "voiceover: if people in the clip carry the story with their speech, write only ONE hook line at start 0 (4-9 words, over the first ~3 seconds). If there's little or no speech (gameplay, sports, scenery, action, music), narrate it like an energetic creator: a hook at start 0, then short lines only where nobody is speaking (max ~2.5 words per second of the gap), building to the payoff. 1-6 lines.",
  };
  const captionPrompt = (len, vo, teaser = 0) =>
    `This is a ${len.toFixed(1)} s vertical Short. Return ONLY JSON: {"captions":[{"start":0.0,"end":0.0,"text":""}]${vo ? ',"voiceover":[{"start":0.0,"text":""}]' : ""}}\n` +
    `captions: the speech in the clip as captions; each caption 1-4 words, in the spoken language, start/end in seconds from the clip start (accurate to 0.1 s), in order, not overlapping. Spoken words only (no song lyrics, no sound descriptions); [] if nobody speaks.\n` +
    (vo ? `${VO_RULES[vo].replace("TEASER_S", teaser.toFixed(1))} Never describe the obvious or say "in this video". Write it in the spoken language of the clip (English if none). start is seconds from the clip start.` : "");

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
  // caption looks: bold (white Anton, black outline), box (white on a black box), minimal (smaller, thin outline)
  const CAP_STYLE = {
    bold: { cap: "Anton,124,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3", vo: "Anton,112,&H0000E5FF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3" },
    box: { cap: "Anton,96,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,3,14,0", vo: "Anton,92,&H0000E5FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,3,14,0" },
    minimal: { cap: "Anton,84,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,3,1", vo: "Anton,80,&H00DDDDDD,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,3,1" },
  };
  function assDoc(events, look = "bold") {
    const st = CAP_STYLE[look] || CAP_STYLE.bold;
    return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n` +
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
      `Style: Cap,${st.cap},2,80,80,600,1\n` +
      `Style: Vo,${st.vo},2,80,80,600,1\n` +
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
    job.lang = opts.lang || ""; // Hinglish mode: every question to the AI carries the Hinglish rule
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
      // a source shorter than the Short: make a shorter Short (default), or loop / pad the cut up to the minimum later
      const target = min;
      if (span < min) {
        const fit = opts.fit || "short";
        min = Math.max(3, Math.min(fit === "short" ? 8 : min, Math.floor(span))); max = Math.max(min, Math.min(fit === "short" ? 15 : max, Math.floor(span)));
        job.fit = { mode: fit, source: +span.toFixed(1), target };
        if (fit === "short") job.warning = `The source is only ${span.toFixed(0)} s, so this is a ${min}-${max} s Short instead of ${target}+ s.`;
      }
      job.range = ranged ? [Math.round(lo), Math.round(hi)] : null;
      const total = hi;
      const base = { ...src, duration: src.duration, min, max, hint: opts.hint, title: srcTitle, range: ranged ? [lo, hi] : null };

      // 1. watch the WHOLE video. Short ones in one go; long ones in ~10 min parts (timestamps stay accurate),
      //    then the best candidates from every part are compared side by side.
      setStep(job, 1, 16);
      let plan = null;
      if (opts.reusePlan) { try { plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")); job.reused = true; } catch {} }
      if (plan) setStep(job, 2, 40);
      else if (span <= SINGLE_MAX) {
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

      fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
      fs.writeFileSync(path.join(dir, "opts.json"), JSON.stringify({ ...opts, file: path.basename(srcFile) }));
      // 2. sanity-check the edit
      const segs = cleanSegments(plan, lo, hi, min, max);
      // story voiceover: flash 1-2 s of the payoff first (a cold open), then tell it from the start
      let tz = null;
      if (opts.narration === "story") {
        const a = toSec(plan.teaser && plan.teaser.start), b0 = toSec(plan.teaser && plan.teaser.end), b = Math.min(b0, a + 2);
        if (b - a >= 0.8 && segs.some((x) => a >= x.start - 0.05 && b <= x.end + 0.05)) tz = { start: a, end: b };
        else { const l = segs[segs.length - 1]; if (l.end - l.start >= 4) tz = { start: l.end - 2.5, end: l.end - 1 }; }
      }
      const pieces = tz ? [tz, ...segs] : segs;
      const start = Math.min(...pieces.map((x) => x.start)), end = Math.max(...pieces.map((x) => x.end));
      const len = pieces.reduce((a, s) => a + s.end - s.start, 0);
      const framing = plan.framing === "crop" ? "crop" : "fit";
      const focusX = Math.max(0, Math.min(1, Number(plan.focus_x) || 0.5));
      let thumbT = toSec(plan.thumbnail_time);
      if (!segs.some((s) => thumbT >= s.start && thumbT <= s.end)) thumbT = segs[0].start + (segs[0].end - segs[0].start) * 0.35;
      job.plan = { start, end, framing, segments: segs, teaser: tz, mood: MOODS.includes(plan.mood) ? plan.mood : null, reason: plan.reason || "" };

      // 3. the edit: jump cuts between pieces, and a punch-in zoom that alternates every few seconds
      //    (the "beat" rhythm short-form editors use) so the picture never sits still for long.
      setStep(job, 3, 50);
      const zoom = opts.edit !== "clean";
      // punch-in: at most 1.25x and anchored on the subject, not the frame centre. With crop safety on and a smart
      // crop that's already tight, the zoom stays at 1.06x so the subject keeps about a 10% margin.
      const safe = opts.safe !== false;
      const zf = Math.min(1.25, safe ? (framing === "crop" ? 1.06 : 1.12) : 1.2);
      const zw = even(1080 * zf), zh = even(1920 * zf);
      const zx = Math.round((zw - 1080) * (framing === "crop" ? 0.5 : focusX)), zy = Math.round((zh - 1920) * (safe ? 0.4 : 0.5));
      job.edit = { cuts: segs.length, zoom: zoom ? +zf.toFixed(2) : 1, framing };
      // Each beat is rendered on its own (seek, frame it, zoom, encode) and the beats are then joined without
      // re-encoding. Doing it in one filter graph (split -> trim -> concat) made every later beat buffer full-size
      // frames while waiting its turn: gigabytes of memory on a 30 s clip, and the server killed ffmpeg.
      // Lengths are whole frames so the separately cut audio stays in sync.
      const FPS = 30, beats = [], audioSegs = [];
      for (const s of pieces) {
        const F = Math.max(1, Math.round((s.end - s.start) * FPS)), k = zoom ? Math.max(1, Math.round(F / FPS / 4.5)) : 1;
        let f0 = 0;
        for (let i = 0; i < k; i++) {
          const f1 = Math.round((F * (i + 1)) / k);
          beats.push({ t: s.start + f0 / FPS, frames: f1 - f0, z: zoom && beats.length % 2 === 1 });
          f0 = f1;
        }
        audioSegs.push({ a: s.start - start, b: s.start - start + F / FPS });
      }
      // where each piece starts in the finished cut: the teaser's end gets the rewind sound, other joins a whoosh
      const joins = []; { let t = 0; for (const x of audioSegs) { if (t > 0) joins.push(+t.toFixed(3)); t += x.b - x.a; } }
      const teaserLen = tz ? joins[0] || 0 : 0;
      await pool(beats, 2, (b, i) => run(["-y", "-ss", b.t.toFixed(3), "-i", srcFile, "-filter_complex",
        frameFilter(src, framing, focusX, "[0:v]fps=30,", i) + (b.z ? `,scale=${zw}:${zh},crop=1080:1920:${zx}:${zy},setsar=1` : "") + ",format=yuv420p[v]",
        "-map", "[v]", "-frames:v", String(b.frames), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-video_track_timescale", "15360", `beat${i}.mp4`], dir)
        .then(() => setStep(job, 3, 50 + ((i + 1) / beats.length) * 10)));
      fs.writeFileSync(path.join(dir, "beats.txt"), beats.map((_, i) => `file 'beat${i}.mp4'`).join("\n"));
      let afc = "";
      if (src.audio) {
        afc = `[1:a]asplit=${audioSegs.length}${audioSegs.map((_, i) => `[as${i}]`).join("")};`;
        audioSegs.forEach(({ a, b }, i) => {
          afc += `[as${i}]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${(b - a - 0.04).toFixed(3)}:d=0.04[a${i}];`;
        });
        afc += audioSegs.map((_, i) => `[a${i}]`).join("") + `concat=n=${audioSegs.length}:v=0:a=1[ac]`;
      }
      await run(["-y", "-f", "concat", "-safe", "0", "-i", "beats.txt",
        ...(src.audio ? ["-ss", start.toFixed(3), "-t", (end - start + 0.1).toFixed(3), "-i", srcFile, "-filter_complex", afc, "-map", "0:v", "-map", "[ac]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : ["-map", "0:v", "-an"]),
        "-c:v", "copy", "cut.mp4"], dir);
      let cutLen = (await audioLen(path.join(dir, "cut.mp4"))) || len;
      if (job.fit && job.fit.mode !== "short" && cutLen < job.fit.target - 0.3) {
        const T = job.fit.target;
        if (job.fit.mode === "loop") {
          await run(["-y", "-stream_loop", String(Math.ceil(T / cutLen)), "-i", "cut.mp4", "-t", T.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", ...(src.audio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]), "cut2.mp4"], dir);
        } else { // pad: hold the last frame, with silence
          const hold = (T - cutLen).toFixed(3);
          await run(["-y", "-i", "cut.mp4", "-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${hold}[v]` + (src.audio ? `;[0:a]apad=pad_dur=${hold}[a]` : ""),
            "-map", "[v]", ...(src.audio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]), "-t", T.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "cut2.mp4"], dir);
        }
        fs.renameSync(path.join(dir, "cut2.mp4"), path.join(dir, "cut.mp4"));
        cutLen = (await audioLen(path.join(dir, "cut.mp4"))) || T;
        job.warning = `The source is only ${job.fit.source} s, so the cut was ${job.fit.mode === "loop" ? "looped" : "padded with a held last frame"} to ${T} s.`;
      }

      // 4. captions + voiceover script, from the finished cut (so timings match what viewers see)
      setStep(job, 4, 62);
      const vo = ["story", "intro", "full", "auto"].includes(opts.narration) ? opts.narration : null;
      let captions = [], lines = [];
      if ((src.audio && plan.has_speech !== false) || vo) {
        await run(["-y", "-i", "cut.mp4", "-vf", "scale=-2:360,fps=4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
          ...(src.audio ? ["-c:a", "aac", "-ac", "1", "-b:a", "64k"] : ["-an"]), "cap.mp4"], dir);
        try {
          const c = await askVideo(job, path.join(dir, "cap.mp4"), captionPrompt(cutLen, vo, teaserLen), 4000);
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
            .slice(0, vo === "intro" ? 1 : vo === "story" ? 7 : 6);
          // story: always a hook over the teaser and a lead-in right after it, even if the AI left them out
          if (vo === "story") {
            if (!lines.some((l) => l.start < 0.5)) lines.unshift({ start: 0, text: "Wait till you see what happens." });
            if (teaserLen && !lines.some((l) => l.start >= teaserLen - 0.4 && l.start <= teaserLen + 1.5))
              lines.splice(1, 0, { start: teaserLen, text: "So it happened like this." });
            lines.sort((a, b) => a.start - b.start);
          }
        } catch (e) { job.warning = "Captions skipped: " + e.message; }
      }

      // 5. voice the narrator lines; each line gets the time until the next line (sped up a little if needed)
      const voiced = [];
      if (lines.length && tts) {
        setStep(job, 4, 70);
        const voice = opts.voice || VOICES[0].voice, model = (VOICES.find((v) => v.voice === voice) || VOICES[0]).model;
        await pool(lines, 3, async (l, i) => {
          try {
            fs.writeFileSync(path.join(dir, `vo${i}.mp3`), await tts({ model, voice, text: l.text, lang: opts.lang }));
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
      if (opts.captions !== "off") {
        for (const c of captions) events.push({ start: c.start, end: c.end, style: "Cap", text: c.text, fx: "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" });
        for (const c of voCaps) events.push({ start: c.start, end: c.end, style: "Vo", text: c.text, fx: "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" });
      }
      fs.writeFileSync(path.join(dir, "subs.ass"), assDoc(events, opts.capStyle));

      // 6. final render: captions burned in; original sound ducked under the narrator; loudness to -14 LUFS
      setStep(job, 5, 76);
      // sound effects: a boom under the hook, a rewind sweep where the teaser ends, a whoosh on the other cuts
      const fx = [];
      if (opts.sfx !== false && vo === "story") {
        if (teaserLen) fx.push({ kind: "boom", at: 0, vol: 0.7 }, { kind: "rewind", at: Math.max(0, teaserLen - 0.35), vol: 0.5 });
        for (const j of joins.slice(teaserLen ? 1 : 0)) fx.push({ kind: "whoosh", at: Math.max(0, j - 0.25), vol: 0.9 });
      }
      // 6a. narrator lines + sound effects -> one full-length track (voice.wav). Mixing short inputs that end early
      //     straight into the big video graph deadlocks ffmpeg, so they are pre-mixed over silence of the clip's length.
      const lay = [...voiced.map((l) => ({ file: l.file, t: ((l.end - l.start) * l.tempo).toFixed(3), f: `atempo=${l.tempo.toFixed(3)},afade=t=out:st=${Math.max(0, l.end - l.start - 0.08).toFixed(3)}:d=0.08,volume=1.5`, at: l.start })),
        ...(await Promise.all(fx.map(async (f) => ({ file: await sfxPath(f.kind, dir), f: `volume=${f.vol}`, at: f.at }))))];
      if (lay.length) {
        const vin = ["-f", "lavfi", "-t", cutLen.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo"];
        lay.forEach((x) => vin.push(...(x.t ? ["-t", x.t] : []), "-i", x.file));
        const ms = (s) => Math.round(s * 1000);
        const g = lay.map((x, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,${x.f},adelay=${ms(x.at)}|${ms(x.at)}[l${i}];`).join("") +
          `[0:a]${lay.map((_, i) => `[l${i}]`).join("")}amix=inputs=${lay.length + 1}:duration=first:normalize=0[a]`;
        await run(["-y", ...vin, "-filter_complex", g, "-map", "[a]", "-c:a", "pcm_s16le", "voice.wav"], dir);
      }
      const mood = opts.music === "auto" ? (job.plan.mood || "chill") : opts.music;
      const musicFile = mood && mood !== "none" ? await musicPath(mood, dir, cutLen) : null;
      job.sound = { music: musicFile ? mood : null, effects: fx.length };
      // 6b. the video: cut sound (ducked) + voice.wav + music, all full length
      const ins = ["-i", "cut.mp4"];
      if (!src.audio) ins.push("-f", "lavfi", "-t", cutLen.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
      const o = src.audio ? "0:a" : "1:a";
      let next = src.audio ? 1 : 2;
      const vIn = lay.length ? next++ : null;
      if (lay.length) ins.push("-i", "voice.wav");
      const mIn = musicFile ? next++ : null;
      if (musicFile) ins.push("-stream_loop", "-1", "-t", cutLen.toFixed(3), "-i", musicFile);
      // original sound: mute / low (25%) / keep (100%). Under the narrator it glides down (0.25 s) to a quiet bed and
      // back up (0.3 s) after, so the voice is always clear and the clip's sound never jumps.
      const origVol = { mute: 0, low: 0.25, keep: 1 }[opts.orig] ?? 1, duckVol = Math.min(origVol, opts.orig === "keep" ? 0.18 : 0.1);
      // optional neon-glitch look goes under the captions, so the text stays sharp; a quick white flash where the
      // teaser cuts back to the start of the story
      const flash = teaserLen ? `drawbox=c=white@0.85:t=fill:enable='between(t,${(teaserLen - 0.05).toFixed(2)},${(teaserLen + 0.07).toFixed(2)})',` : "";
      let af = (opts.look === "glitch" ? glitchFilter("[0:v]", "[gv];[gv]", 1080, 1920, cutLen, cutLen) : "[0:v]") + `${flash}subtitles=subs.ass:fontsdir=${fontsArg(dir)}[v];`;
      if (voiced.length) {
        const ramp = (l) => `clip((t-(${(l.start - 0.3).toFixed(2)}))/0.25,0,1)*clip((${(l.end + 0.35).toFixed(2)}-t)/0.3,0,1)`;
        const d = voiced.map(ramp).reduce((acc, x) => (acc ? `max(${acc},${x})` : x), "");
        af += `[${o}]volume='${origVol}-${(origVol - duckVol).toFixed(3)}*${d}':eval=frame[orig];`;
      } else af += `[${o}]volume=${origVol}[orig];`;
      // speech = the clip's sound + the narrator. Music sits under it: it fills quiet stretches and is pushed down
      // automatically (sidechain) whenever someone talks, so it never fights the voice.
      af += vIn != null ? `[orig][${vIn}:a]amix=inputs=2:duration=first:normalize=0[sp];` : `[orig]anull[sp];`;
      if (mIn != null) {
        af += `[${mIn}:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.3,afade=t=out:st=${Math.max(0, cutLen - 1.5).toFixed(2)}:d=1.5[mu];` +
          `[sp]asplit[sp1][sp2];[mu][sp1]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=450[mud];` +
          `[sp2][mud]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
      } else af += `[sp]loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
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
        hookBurned: !!hook, teaser: teaserLen ? +teaserLen.toFixed(1) : 0, sound: job.sound || null, edit: job.edit || null, fit: job.fit || null,
        opts: { orig: opts.orig, captions: opts.captions, capStyle: opts.capStyle, music: opts.music, safe: opts.safe, fit: opts.fit, narration: opts.narration, voice: opts.voice, len: opts.len },
      };
      saveMeta(id, meta);
      Object.assign(job, { status: "done", pct: 100, step: "Done" });
      hist(id, { status: "completed", title: meta.title || srcTitle || "Short", model: modelNow(), duration: meta.length, cost: meta.cost });
    } catch (e) {
      Object.assign(job, { status: "failed", error: e.message.slice(0, 500) });
      saveMeta(id, { id, status: "failed", createdAt: job.createdAt, error: job.error, source: job.source || null, retryable: fs.existsSync(path.join(dir, "plan.json")) });
      hist(id, { status: "failed", error: job.error, retry: { endpoint: `/api/shorts/${id}/retry`, body: {} } });
    } finally {
      logSpend("Shorts", (job.cost || 0) - (job.ttsCost || 0), modelNow(), "short-" + id); // voice is logged by tts() itself
      const keepSrc = job.status === "failed" && fs.existsSync(path.join(dir, "plan.json"));
      for (const f of fs.readdirSync(dir)) if (!(keepSrc && /^src\./.test(f)) && /^(src\.|proxy\.mp4|part\d+\.mp4|win\d+\.mp4|wins\.txt|beat\d+\.mp4|beats\.txt|reel\.mp4|cut\.mp4|cap\.mp4|vo\d+\.mp3|cookies\.txt|.*\.part$)/.test(f)) fs.rm(path.join(dir, f), { force: true }, () => {});
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
    }
  }

  // ---------- Pictures -> explainer Short: a vision model studies the pictures and writes the explanation, a narrator
  // reads it, and every picture gets a slow, smooth push-in with crossfades, captions, music and a thumbnail. No video
  // model is used, so it costs cents. ----------
  const PIC_TRANS = ["fade", "smoothleft", "dissolve", "smoothup"];
  async function askPictures(job, files, opts) {
    const n = files.length, words = opts.len === "30-60" ? 115 : 60;
    const prompt = [
      `You are making a vertical explainer Short from these ${n} pictures (numbered 1 to ${n} in the order given).`,
      "Look at every picture carefully: read any text, numbers, charts, labels and diagrams, and notice the objects, people, places and details. Work out what they show together, then explain it to a viewer the way a great explainer creator would.",
      opts.hint ? `The user wants this explained: "${opts.hint}".` : "Decide yourself what is most interesting or useful to explain about them.",
      `Structure: the first line is a hook that makes people stay; then one clear point per picture, each building on the last; end with a takeaway or payoff. Natural spoken language, short sentences, about ${words} words in total. Never say "this picture", "this image" or "in the photo": talk about the subject itself.`,
      "Use every picture once, in the order that explains best (skip one only if it is a duplicate).",
      `Return ONLY JSON: {"title":"","hook":"on-screen hook, max 6 words","thumbnail_text":"max 4 words","description":"","hashtags":["",""],"mood":"one of ${MOODS.join(", ")}","slides":[{"image":1,"narration":""}]}`,
      ...(opts.lang ? [hing.RULE + " Here that means title, hook, thumbnail_text, description and every narration line are Hinglish."] : []),
    ].join("\n");
    const content = [{ type: "text", text: prompt }, ...files.map((f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` } }))];
    const model = modelNow();
    const r = await orFetch(`${API}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${getKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 3000, temperature: 0.5, messages: [{ role: "user", content }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error("Picture analysis failed: " + (j.error?.message || r.status));
    job.cost = (job.cost || 0) + (j.usage?.cost || 0);
    const plan = opts.lang ? hing.scrubDeep(parseJson(j.choices?.[0]?.message?.content)) : parseJson(j.choices?.[0]?.message?.content);
    const seen = new Set();
    plan.slides = (Array.isArray(plan.slides) ? plan.slides : [])
      .map((s) => ({ image: Math.round(+s.image) - 1, narration: String(s.narration || "").trim() }))
      .filter((s) => s.image >= 0 && s.image < n && s.narration && !seen.has(s.image) && seen.add(s.image));
    if (!plan.slides.length) throw new Error("The AI couldn't write an explanation for these pictures. Try again or add a topic.");
    return plan;
  }

  // One cameo picture: the influencer (main picture + front / half-body poses) presenting the user's picture.
  // Each one is logged as spent the moment it comes back, under the image model.
  async function drawCameo(job, dir, cameo, subject, narration, out) {
    const url = (f) => `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`;
    const model = getImageModel(), prompt = cameoPrompt({ refs: cameo.refs.length, desc: cameo.desc, narration });
    const r = await orFetch(`${API}/images`, {
      method: "POST", headers: { Authorization: `Bearer ${getKey()}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: "9:16", input_references: [...cameo.refs, subject].map((f) => ({ type: "image_url", image_url: { url: url(f) } })) }),
    }, { safe: false });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error?.message || `image failed (${r.status})`);
    const cost = Number(j.usage?.cost) || 0;
    job.cameoCost = (job.cameoCost || 0) + cost;
    logSpend("Shorts", cost, model);
    const d = j.data?.[0];
    if (!d?.b64_json) throw new Error("the image model returned no picture");
    const file = `${out}.${/png/.test(d.media_type || "") ? "png" : /webp/.test(d.media_type || "") ? "webp" : "jpg"}`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(d.b64_json, "base64"));
    return file;
  }

  async function runPictures(id, opts) {
    const job = jobs.get(id), dir = dirOf(id);
    job.lang = opts.lang || "";
    const W = 1080, H = 1920, X = 0.35; // X = crossfade length
    try {
      const files = opts.images.map((_, i) => path.join(dir, `pic${i}.jpg`));
      Object.assign(job, { step: "Looking at your pictures", pct: 8 });
      const plan = opts.reusePlan && fs.existsSync(path.join(dir, "plan.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")) : await askPictures(job, files, opts);
      fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
      job.plan = { title: plan.title, hook: plan.hook };

      // the cameo pictures (only with an influencer picked); one that can't be made leaves just the original
      const cameos = new Map(); // line number -> picture file
      if (opts.cameo) {
        const at = cameoSlides(plan.slides.length, opts.cameo.count);
        let done = 0;
        Object.assign(job, { step: `Adding ${opts.cameo.name} to the pictures`, pct: 14 });
        await pool(at, 2, async (i) => {
          const s = plan.slides[i];
          // a retry keeps the cameo pictures the first attempt already paid for
          const had = opts.reusePlan && fs.readdirSync(dir).find((f) => new RegExp(`^cameo${i}\\.(png|jpg|webp)$`).test(f));
          try { cameos.set(i, had || await drawCameo(job, dir, opts.cameo, path.basename(files[s.image]), s.narration, `cameo${i}`)); }
          catch (e) { job.warning = `${opts.cameo.name} is missing from picture ${s.image + 1}: ${String(e.message).slice(0, 160)}`; }
          job.pct = 14 + Math.round((++done / at.length) * 6);
        });
      }

      // 1. narrator: one line per picture (silence trimmed so the lines flow)
      const v = VOICES.find((x) => x.voice === opts.voice) || VOICES[0];
      const slides = [];
      for (let i = 0; i < plan.slides.length; i++) {
        Object.assign(job, { step: `Voicing ${i + 1}/${plan.slides.length}`, pct: 20 + Math.round((i / plan.slides.length) * 25) });
        const s = plan.slides[i];
        fs.writeFileSync(path.join(dir, `vo${i}.mp3`), await tts({ model: v.model, voice: v.voice, text: s.narration, lang: opts.lang }));
        try { await run(["-y", "-i", `vo${i}.mp3`, "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse", `vt${i}.wav`], dir); } catch {}
        const vf = fs.existsSync(path.join(dir, `vt${i}.wav`)) ? `vt${i}.wav` : `vo${i}.mp3`;
        const vd = await audioDuration(path.join(dir, vf));
        if (!vd) throw new Error(`The narrator's line for picture ${s.image + 1} came back empty. Try again.`);
        job.ttsCost = (job.ttsCost || 0) + vd * (TTS_RATE[v.model] ?? 0.0005);
        slides.push({ ...s, file: path.basename(files[s.image]), cameo: cameos.get(i), voice: vf, vd, D: Math.max(2.5, vd + 0.6) });
      }
      let t = 0;
      slides.forEach((s, k) => { s.start = t; t += s.D - X; });
      const total = slides.reduce((a, s) => a + s.D, 0) - X * (slides.length - 1);

      // 2. every picture: fitted over a blurred fill of itself, then a slow push-in (or pull-out) for its whole line
      const shots = pictureShots(slides, X);
      for (let k = 0; k < shots.length; k++) {
        const s = shots[k];
        Object.assign(job, { step: `Animating picture ${k + 1}/${shots.length}`, pct: 45 + Math.round((k / shots.length) * 25) });
        await run(["-y", "-i", s.file, "-filter_complex",
          `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},boxblur=40:2,eq=brightness=-0.1:saturation=0.8[bg];` +
          `[0:v]scale=${W * 2 - 120}:${H * 2 - 400}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[o]`,
          "-map", "[o]", "-frames:v", "1", `slide${k}.png`], dir);
        const frames = Math.round(s.D * 30), [z0, z1] = k % 2 ? [1.08, 1] : [1, 1.08];
        await run(["-y", "-loop", "1", "-framerate", "30", "-t", s.D.toFixed(3), "-i", `slide${k}.png`, "-vf",
          `zoompan=z='${z0}+(${(z1 - z0).toFixed(3)})*on/${Math.max(1, frames - 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,format=yuv420p`,
          "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", `s${k}.mp4`], dir);
      }

      // 3. captions: the narration in short chunks, timed to each line; the hook on top for the first seconds
      const events = [];
      const hook = String(plan.hook || "").trim();
      if (hook) events.push({ start: 0, end: Math.min(2.8, total), style: "Hook", text: hook });
      if (opts.captions !== "off") for (const s of slides) {
        const w = s.narration.split(/\s+/).filter(Boolean), chunks = [];
        for (let i = 0; i < w.length; i += 3) chunks.push(w.slice(i, i + 3).join(" "));
        const chars = chunks.reduce((a, c) => a + c.length + 1, 0);
        let at = s.start + 0.25;
        for (const c of chunks) { const d = (s.vd * (c.length + 1)) / chars; events.push({ start: at, end: at + d, style: "Cap", text: c, fx: "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" }); at += d; }
      }
      fs.writeFileSync(path.join(dir, "subs.ass"), assDoc(events, opts.capStyle));

      // 4. sound: the lines at their slide's start, a whoosh into every new picture, all over silence of full length
      Object.assign(job, { step: "Rendering the Short", pct: 75 });
      const ms = (x) => Math.round(x * 1000);
      const lay = slides.map((s) => ({ file: s.voice, at: s.start + 0.25, f: "volume=1.4" }));
      if (opts.sfx !== false) for (const s of slides.slice(1)) lay.push({ file: await sfxPath("whoosh", dir), at: Math.max(0, s.start - 0.1), f: "volume=0.8" });
      const vin = ["-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo"];
      lay.forEach((x) => vin.push("-i", x.file));
      await run(["-y", ...vin, "-filter_complex", lay.map((x, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,${x.f},adelay=${ms(x.at)}|${ms(x.at)}[l${i}];`).join("") +
        `[0:a]${lay.map((_, i) => `[l${i}]`).join("")}amix=inputs=${lay.length + 1}:duration=first:normalize=0[a]`, "-map", "[a]", "-c:a", "pcm_s16le", "voice.wav"], dir);
      const mood = opts.music === "auto" ? (MOODS.includes(plan.mood) ? plan.mood : "chill") : opts.music;
      const musicFile = mood && mood !== "none" ? await musicPath(mood, dir, total) : null;

      // 5. the video: pictures crossfaded, captions burned in, music ducked under the voice, loudness to -14 LUFS
      const ins = [];
      shots.forEach((_, k) => ins.push("-i", `s${k}.mp4`));
      ins.push("-i", "voice.wav");
      if (musicFile) ins.push("-stream_loop", "-1", "-t", total.toFixed(3), "-i", musicFile);
      const n = shots.length, aV = n, aM = n + 1;
      let g = "", last = "[0:v]";
      for (let k = 1; k < n; k++) { g += `${last}[${k}:v]xfade=transition=${shots[k].inner ? "fade" : PIC_TRANS[k % PIC_TRANS.length]}:duration=${X}:offset=${shots[k].start.toFixed(3)}[x${k}];`; last = `[x${k}]`; }
      g += `${last}fade=t=in:d=0.3,subtitles=subs.ass:fontsdir=${fontsArg(dir)},format=yuv420p[v];`;
      g += musicFile
        ? `[${aM}:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.3,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[mu];[${aV}:a]asplit[sp1][sp2];[mu][sp1]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=450[mud];[sp2][mud]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]`
        : `[${aV}:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
      await run(["-y", ...ins, "-filter_complex", g, "-map", "[v]", "-map", "[a]", "-t", total.toFixed(3),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-movflags", "+faststart", "short.mp4"], dir);

      // 6. thumbnail: the first picture with big text
      Object.assign(job, { step: "Making the thumbnail", pct: 92 });
      const tt = String(plan.thumbnail_text || hook || "").trim();
      fs.writeFileSync(path.join(dir, "thumb.ass"), assDoc(tt ? [{ start: 0, end: 10, style: "Thumb", text: tt }] : []));
      await run(["-y", "-i", "slide0.png", "-vf", `scale=${W}:${H},eq=contrast=1.08:saturation=1.2,subtitles=thumb.ass:fontsdir=${fontsArg(dir)}`, "-frames:v", "1", "-q:v", "2", "thumb.jpg"], dir);

      const tags = (Array.isArray(plan.hashtags) ? plan.hashtags : []).map((x) => String(x).replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean);
      if (!tags.some((x) => x.toLowerCase() === "shorts")) tags.push("shorts");
      job.cost = (job.cost || 0) + (job.ttsCost || 0);
      const meta = {
        id, status: "done", kind: "pictures", createdAt: job.createdAt, source: { title: opts.title || plan.title || "Pictures", pictures: files.length },
        length: +total.toFixed(1), hook, captions: events.length, voiceover: slides.map((s) => s.narration),
        title: String(plan.title || "").slice(0, 100), description: String(plan.description || ""), hashtags: tags.slice(0, 8),
        thumbnailText: tt, cost: +((job.cost || 0) + (job.cameoCost || 0)).toFixed(4), sound: { music: musicFile ? mood : null, effects: opts.sfx !== false ? slides.length - 1 : 0 },
        ...(opts.cameo ? { cameo: { name: opts.cameo.name, pictures: slides.filter((s) => s.cameo).map((s) => s.image + 1) }, warning: job.warning || null } : {}),
        opts: { captions: opts.captions, capStyle: opts.capStyle, music: opts.music, voice: opts.voice, len: opts.len },
      };
      saveMeta(id, meta);
      Object.assign(job, { status: "done", pct: 100, step: "Done" });
      hist(id, { status: "completed", title: meta.title || "Picture explainer", model: modelNow(), duration: meta.length, cost: meta.cost });
    } catch (e) {
      Object.assign(job, { status: "failed", error: e.message.slice(0, 500) });
      saveMeta(id, { id, status: "failed", kind: "pictures", createdAt: job.createdAt, error: job.error, source: { title: opts.title || "Pictures" } });
      hist(id, { status: "failed", error: job.error });
    } finally {
      logSpend("Shorts", (job.cost || 0) - (job.ttsCost || 0), modelNow(), "short-" + id);
      for (const f of fs.readdirSync(dir)) if (/^(s\d+\.mp4|slide\d+\.png|vo\d+\.mp3|vt\d+\.wav|voice\.wav|sfx-.*\.wav|music-.*\.m4a|cameoref\d+\.(jpg|png|webp)|cameo\d+\.(jpg|png|webp))$/.test(f)) fs.rm(path.join(dir, f), { force: true }, () => {});
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref?.(); // (never keeps the process alive by itself)
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
  // (With the render queue they live on in the queue and finish on a render worker.)
  if (!renderSlot.durable) for (const d of fs.readdirSync(DIR)) {
    const m = /^\w+$/.test(d) && readMeta(d);
    if (m && m.status === "running") saveMeta(d, { ...m, status: "failed", error: "The server restarted while this Short was being made. Make it again." });
  }
  const start = (id, opts) => {
    const job = jobs.get(id);
    const q = renderSlot.stats ? renderSlot.stats() : null, ahead = q ? q.waiting + (q.active >= q.slots ? 1 : 0) : 0;
    job.step = ahead ? `Waiting for ${ahead} other video${ahead > 1 ? "s" : ""} to finish rendering` : "Starting"; // another Short or Story is rendering
    saveMeta(id, { id, status: "running", createdAt: job.createdAt, source: { title: opts.title || "", link: opts.link || null } });
    hist(id, { status: "running", title: opts.title || opts.link || "Short", t: job.createdAt, ...(opts.link ? { retry: { endpoint: "/api/shorts", body: { ...opts, url: opts.link, link: undefined, file: undefined } } } : {}) });
    renderSlot.submit("short", { id, opts: { ...opts, file: opts.file ? path.basename(opts.file) : opts.file } });
  };
  // Shorts render through lib/render.js: in this process, or on a render worker that gets the Short's folder, the
  // chosen music track and the settings, and sends the folder back. The source file is always in the Short's folder.
  const failJob = ({ id, opts }, e) => {
    const job = jobs.get(id) || {};
    Object.assign(job, { status: "failed", error: String(e.message || e).slice(0, 500) });
    jobs.set(id, job);
    try { saveMeta(id, { id, status: "failed", ...(opts && opts.images ? { kind: "pictures" } : {}), createdAt: job.createdAt, error: job.error, source: job.source || { title: (opts && opts.title) || "" } }); } catch {}
    hist(id, { status: "failed", error: job.error });
  };
  // A retry (the first worker was lost) reuses the plan the first attempt already paid for, when it was saved.
  const shortJob = (runIt) => ({
    ref: ({ id }) => "short-" + id,
    run: (p, { attempt = 1 } = {}) => {
      const opts = p.opts && p.opts.file ? { ...p.opts, file: path.join(dirOf(p.id), p.opts.file) } : { ...p.opts };
      if (attempt > 1 && fs.existsSync(path.join(dirOf(p.id), "plan.json"))) opts.reusePlan = true;
      return runIt(p.id, opts);
    },
    onError: failJob,
    state: ({ id }) => jobs.get(id),
    setState: ({ id }, st) => jobs.set(id, st),
    inputs: ({ id, opts }) => [`work/shorts/${id}/`, "data/settings.json", ...(/^m[a-f0-9]{16}$/.test((opts && opts.music) || "") ? [`work/shorts/music/${opts.music}`] : [])],
    outputs: ({ id }) => [`work/shorts/${id}/`],
  });
  renderSlot.define("short", shortJob((id, opts) => runShort(id, opts)));
  renderSlot.define("pictures", shortJob((id, opts) => runPictures(id, opts)));
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
    // "story" (default): a cold-open teaser, a hook line, then the clip told like a story ("so it happened like this…")
    narration: ["story", "auto", "intro", "full", "off"].includes(get("narration")) ? get("narration") : "story",
    voice: VOICES.some((v) => v.voice === get("voice")) ? get("voice") : VOICES[0].voice,
    edit: get("edit") === "clean" ? "clean" : "dynamic",
    from: parseTime(get("from")), to: parseTime(get("to")),
    look: get("look") === "glitch" ? "glitch" : "clean",
    fit: ["short", "loop", "pad"].includes(get("fit")) ? get("fit") : "short",
    orig: ["mute", "low", "keep"].includes(get("orig")) ? get("orig") : "keep",
    captions: get("captions") === "off" ? "off" : "on",
    capStyle: ["bold", "box", "minimal"].includes(get("capStyle")) ? get("capStyle") : "bold",
    // generated music (no rights issues): auto = the mood the AI read from the clip
    music: ["auto", ...MOODS, "pad", "none"].includes(get("music")) || /^m[a-f0-9]{16}$/.test(get("music") || "") ? get("music") : "auto",
    sfx: get("sfx") !== "0" && get("sfx") !== "false",
    safe: get("safe") !== "0" && get("safe") !== "false",
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
      start(id, { ...readOpts((k) => url.searchParams.get(k)), file, title: name, lang: hing.isHinglish(req) ? "hinglish" : "" });
      return send(res, 200, { id }), true;
    }
    // pictures -> explainer Short: JSON {images:[data URLs], hint, voice, len, captions, capStyle, music, sfx,
    // influencer_id?, cameos? (how many pictures that influencer appears in, 1-3)}
    if (req.method === "POST" && url.pathname === "/api/shorts/pictures") {
      if (!getKey()) return send(res, 500, { error: "OPENROUTER_API_KEY missing." }), true;
      let b = "";
      for await (const c of req) { b += c; if (b.length > 40e6) return send(res, 413, { error: "Pictures too large (max about 40 MB together)." }), true; }
      let body = {};
      try { body = JSON.parse(b || "{}"); } catch {}
      const imgs = (Array.isArray(body.images) ? body.images : []).map((u) => String(u).match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/)).filter(Boolean);
      if (!imgs.length) return send(res, 400, { error: "Add at least one picture." }), true;
      if (imgs.length > 10) return send(res, 400, { error: "Up to 10 pictures at a time." }), true;
      let inf = null, main = null;
      if (body.influencer_id) {
        inf = /^[\w-]+$/.test(body.influencer_id) && readInf().find((x) => x.id === body.influencer_id);
        main = inf && imgFile(inf.id);
        if (!main) return send(res, 400, { error: "That influencer has no saved picture." }), true;
      }
      const id = newJob(), dir = dirOf(id);
      // every picture is stored as JPEG (the vision model and ffmpeg both read it)
      for (let i = 0; i < imgs.length; i++) {
        const raw = path.join(dir, `in${i}.${imgs[i][1] === "jpg" ? "jpeg" : imgs[i][1]}`);
        fs.writeFileSync(raw, Buffer.from(imgs[i][2], "base64"));
        if (/jpe?g$/.test(raw)) fs.renameSync(raw, path.join(dir, `pic${i}.jpg`));
        else { try { await run(["-y", "-i", path.basename(raw), "-frames:v", "1", "-q:v", "2", `pic${i}.jpg`], dir); } finally { fs.rm(raw, { force: true }, () => {}); } }
      }
      const get = (k) => (body[k] == null ? null : String(body[k]));
      const opts = { ...readOpts(get), images: imgs.map(() => 1), title: String(body.title || "").slice(0, 120), lang: hing.isHinglish(req) ? "hinglish" : "" };
      if (inf) { // the reference pictures travel in the Short's folder, so a render worker has them too
        const refs = [main, viewFile(inf.id, "front"), viewFile(inf.id, "half")].filter(Boolean).map((f, i) => {
          const name = `cameoref${i}${path.extname(f)}`;
          fs.copyFileSync(f, path.join(dir, name));
          return name;
        });
        opts.cameo = { name: String(inf.name || "Influencer").slice(0, 60), desc: String(inf.desc || "").slice(0, 600), refs, count: Math.max(1, Math.min(CAMEO_MAX, Math.round(+body.cameos) || 2)) };
      }
      const q = renderSlot.stats ? renderSlot.stats() : null, ahead = q ? q.waiting + (q.active >= q.slots ? 1 : 0) : 0;
      const job = jobs.get(id);
      job.step = ahead ? `Waiting for ${ahead} other video${ahead > 1 ? "s" : ""} to finish rendering` : "Starting";
      saveMeta(id, { id, status: "running", kind: "pictures", createdAt: job.createdAt, source: { title: opts.title || "Pictures" } });
      hist(id, { status: "running", title: opts.title || "Picture explainer", t: job.createdAt });
      renderSlot.submit("pictures", { id, opts });
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
      const info = await linkInfo(link).catch(() => null);
      return send(res, 200, { ok: true, kind: "site", site: host, duration: info?.duration || null, title: info?.title || null, thumbnail: info?.thumbnail || null }), true;
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
      start(id, { ...readOpts((k) => (body[k] == null ? null : String(body[k]))), link, lang: hing.isHinglish(req) ? "hinglish" : "" });
      return send(res, 200, { id }), true;
    }
    if (req.method === "POST" && url.pathname === "/api/shorts/music") { // a music track to mix under the Short
      const ext = (String(req.headers["x-filename"] || "").match(/\.(mp3|m4a|aac|wav|ogg)$/i) || [null, "mp3"])[1].toLowerCase();
      const mid = "m" + crypto.randomBytes(8).toString("hex"), f = path.join(MUSIC, `${mid}.${ext}`);
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 30 * 1048576) return send(res, 413, { error: "Music file too large (max 30 MB)." }), true; chunks.push(c); }
      if (!size) return send(res, 400, { error: "Empty upload." }), true;
      fs.writeFileSync(f, Buffer.concat(chunks));
      return send(res, 200, { id: mid }), true;
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/shorts\/(\w+)\/retry$/))) {
      const id = m[1], dir = dirOf(id);
      if (jobs.get(id)?.status === "running") return send(res, 409, { error: "Still working on it." }), true;
      let o = null;
      try { o = JSON.parse(fs.readFileSync(path.join(dir, "opts.json"), "utf8")); } catch {}
      const src = o && o.file && path.join(dir, o.file);
      if (!o || !fs.existsSync(src) || !fs.existsSync(path.join(dir, "plan.json"))) return send(res, 400, { error: "This Short can't be retried without starting over (the source is gone). Make it again." }), true;
      jobs.set(id, { status: "running", step: STEPS[0], pct: 0, createdAt: Date.now() });
      start(id, { ...o, link: null, file: src, reusePlan: true });
      return send(res, 200, { id }), true;
    }
    if (req.method === "GET" && url.pathname === "/api/shorts/voices") return send(res, 200, { voices: VOICES.filter((v) => !hing.isHinglish(req) || /eleven/.test(v.model)).map((v) => (hing.isHinglish(req) ? { ...v, model: hing.HINGLISH_TTS, label: v.label.replace("ElevenLabs", "ElevenLabs v3") } : v)).map(({ voice, label, model }) => ({ voice, label, model, perSec: TTS_RATE[model] ?? 0.0005 })), vision: modelNow(), cameo: { model: getImageModel(), perPicture: cameoPrice(getImageModel()) } }), true;
    if (req.method === "GET" && url.pathname === "/api/shorts") {
      const ids = fs.readdirSync(DIR).filter((d) => /^\w+$/.test(d)).sort().reverse().slice(0, 30);
      return send(res, 200, { shorts: ids.map(publicView).filter(Boolean) }), true;
    }
    if ((m = url.pathname.match(/^\/api\/shorts\/(\w+)$/))) {
      if (req.method === "DELETE") {
        if (jobs.get(m[1])?.status === "running") return send(res, 409, { error: "Still working on it." }), true;
        jobs.delete(m[1]);
        try { history && history.del("short-" + m[1]); } catch {}
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
Object.assign(module.exports, { cameoSlides, pictureShots });
