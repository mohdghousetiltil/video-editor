# video-editor

AI video studio: single clips, story mode, UGC, poses and motion, and a Shorts maker (long video or link -> captioned 9:16 Short + thumbnail + title).

Run: copy `.env.example` to `.env`, add your OpenRouter key, then `node server.js` (http://localhost:3000).

## Deploy: backend on Railway, frontend on Cloudflare Pages

**Railway** (this repo, root directory): `railway.json` makes Railway build the `Dockerfile` and start `node server.js` (leave Custom Start Command empty; `wrangler deploy` is for Cloudflare only) (Node 22 + ffmpeg + yt-dlp). Add a Volume mounted at `/data`, set the healthcheck path to `/healthz`, then set variables:

| Variable | Value |
|---|---|
| `OPENROUTER_API_KEY` | your key |
| `DATA_DIR` | `/data` |
| `PROXY_KEY` | long random string (same as in Cloudflare) |
| `PUBLIC_URL` | the Railway public URL, e.g. `https://xxx.up.railway.app` |
| `SHORTS_MODEL` | optional, video model for the Shorts maker (default `google/gemini-3.5-flash-lite`) |
| `YT_COOKIES` | optional, contents of a `cookies.txt` exported from a logged-in YouTube browser session; only needed if YouTube links fail with "blocked" |

**Cloudflare** (connect the same GitHub repo). As a **Worker** (current setup): `wrangler.jsonc` + `worker.js` serve `public/`, ask for the password and proxy `/api` to Railway; deploy command `npx wrangler deploy`, and the `name` in `wrangler.jsonc` must match the Worker name. As a **Pages** project instead: build command empty, output directory `public`, and `functions/` is picked up automatically. Variables (either way):

| Variable | Value |
|---|---|
| `BACKEND_URL` | the Railway public URL |
| `PROXY_KEY` | same as Railway |
| `APP_PASSWORD` | password to open the site (login prompt) |
| `APP_USER` | optional, defaults to `admin` |

## Shorts maker

`/shorts.html`: upload a video (or paste a YouTube / X / Instagram / TikTok / Reddit link). A video model watches the whole video: up to 12 min in one go, longer videos in ~10 min parts with the original time burned into every frame, after which the best candidates from all parts are compared side by side. It picks the strongest moment and edits it into a 15–30 s (or 30–60 s) Short with up to 4 jump-cut pieces, and writes the hook, title, description, hashtags and thumbnail text. ffmpeg cuts it to 1080x1920 @30fps (smart crop or full frame on a blurred background) with punch-in zooms every few seconds, burns word captions in the Anton font (`fonts/`, SIL OFL), can add an AI narrator (Auto / hook line / full; Kokoro or ElevenLabs voices through OpenRouter, original sound ducked under it), normalises loudness and grabs a thumbnail. Results live in `DATA_DIR/work/shorts/<id>/` until deleted from the page. Locally, install yt-dlp (`pip install yt-dlp`) for link support.

## Story budget mode

Tick **Budget mode** on `/story` and set a budget (default $0.15): every scene is generated on the cheapest 9:16 video model (Grok Imagine 1.5 Lite, 480p, $0.02/s), scene lengths are trimmed in proportion to fit the budget, and where narration runs longer than a clip the clip is slowed (up to 1.5x) and holds its last frame.
