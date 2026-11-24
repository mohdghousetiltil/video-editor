// Get a video from a link, so nobody has to download it first: a direct video file (.mp4, .mov, .webm) is fetched as it is, and a page on
// Instagram, X, TikTok, YouTube, Reddit, Vimeo and ~1800 other sites goes through yt-dlp (installed in the Railway image, see Dockerfile).
// Used by "Copy motion" and "Face swap". The video lands in the folder you give it as src.<ext>.
//
// Safety: only public http(s) addresses (nothing on the server's own network), a size cap, and a time cap.
// Rights: this fetches what the user could watch in a browser; using other people's footage is the user's responsibility (the pages say so).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)(\?|#|$)/i;

// true for a public web address; false for localhost, private ranges and anything that is not http(s)
function isPublicUrl(link) {
  let u;
  try { u = new URL(link); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0") return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h === "::1" || /^(fc|fd|fe80)/.test(h)) return false;
  return true;
}

function ytdlp(link, dir, { maxMb, ffmpeg }) {
  const args = ["--no-playlist", "--no-warnings", "-f", "b[height<=720][ext=mp4]/b[height<=720]/bv*[height<=720]+ba/b",
    "--merge-output-format", "mp4", "--max-filesize", maxMb + "M", "--match-filter", "duration <=? 900", "--js-runtimes", "node", "-o", "src.%(ext)s"];
  if (ffmpeg && ffmpeg !== "ffmpeg") args.push("--ffmpeg-location", ffmpeg);
  // sites like Instagram and YouTube often want a logged-in browser's cookies when asked from a server (Netscape cookie text in YT_COOKIES)
  if (process.env.YT_COOKIES) { fs.writeFileSync(path.join(dir, "cookies.txt"), process.env.YT_COOKIES.replace(/\\n/g, "\n")); args.push("--cookies", "cookies.txt"); }
  args.push(link);
  const attempt = (exe, pre) => new Promise((resolve, reject) => {
    const p = spawn(exe, [...pre, ...args], { cwd: dir });
    let err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 120000);
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(Object.assign(e, { spawnFailed: true })); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const f = fs.readdirSync(dir).find((n) => /^src\.(mp4|mkv|webm|mov)$/.test(n));
      if (code === 0 && f) return resolve(path.join(dir, f));
      if (code === 0) return reject(new Error("No video came from that link (it may be too long, private, or not a video page)."));
      const msg = (err.match(/ERROR:.*$/m) || [err.trim().split("\n").pop() || "unknown error"])[0];
      if (/login|log in|sign in|cookies|rate-limit|not available|private/i.test(msg)) return reject(new Error("That site wouldn't give the video to this server (it wants a login, or the post is private). Open it in your browser, save the video and upload it here instead."));
      reject(new Error("Couldn't get a video from that link: " + msg.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "").slice(0, 240)));
    });
  });
  const exe = process.env.YTDLP_PATH || "yt-dlp";
  return attempt(exe, []).catch((e) => (e.spawnFailed ? attempt("python", ["-m", "yt_dlp"]).catch((e2) => { throw e2.spawnFailed ? new Error("The video downloader (yt-dlp) is not installed on this server.") : e2; }) : Promise.reject(e)));
}

async function direct(link, dir, { maxMb }) {
  const r = await fetch(link, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 VideoStudio" }, signal: AbortSignal.timeout(30000) });
  const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!r.ok || !(/^video\//.test(ct) || (/octet-stream|binary/.test(ct) && VIDEO_EXT.test(new URL(r.url).pathname)))) { r.body?.cancel().catch(() => {}); return null; }
  const size = Number(r.headers.get("content-length")) || 0;
  if (size > maxMb * 1048576) { r.body?.cancel().catch(() => {}); throw new Error(`That video is ${(size / 1048576).toFixed(0)} MB; the limit is ${maxMb} MB.`); }
  const file = path.join(dir, "src.mp4");
  const ws = fs.createWriteStream(file);
  let got = 0;
  for await (const c of r.body) {
    got += c.length;
    if (got > maxMb * 1048576) { ws.destroy(); throw new Error(`That video is bigger than ${maxMb} MB.`); }
    if (!ws.write(c)) await new Promise((ok) => ws.once("drain", ok));
  }
  await new Promise((ok) => ws.end(ok));
  return file;
}

// -> path of the downloaded video (dir/src.<ext>)
async function fetchLink(link, dir, { maxMb = 200, ffmpeg = "ffmpeg" } = {}) {
  link = String(link || "").trim();
  if (!isPublicUrl(link)) throw Object.assign(new Error("Paste a public web link that starts with https://"), { status: 400 });
  fs.mkdirSync(dir, { recursive: true });
  const f = await direct(link, dir, { maxMb }).catch((e) => { if (/limit|bigger/.test(e.message)) throw e; return null; });
  if (f) return f;
  return ytdlp(link, dir, { maxMb, ffmpeg });
}

module.exports = { fetchLink, isPublicUrl, VIDEO_EXT };
