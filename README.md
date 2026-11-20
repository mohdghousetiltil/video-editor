# video-editor

AI video studio: single clips, story mode, UGC, poses and motion, and a Shorts maker (long video or link -> captioned 9:16 Short + thumbnail + title).

Run: copy `.env.example` to `.env`, add your OpenRouter key, then `node server.js` (http://localhost:3000).

## Deploy: backend on Railway, frontend on Cloudflare Pages

**Railway** (this repo, root directory): Railway builds the `Dockerfile` (Node 22 + ffmpeg + yt-dlp). Add a Volume mounted at `/data`, set the healthcheck path to `/healthz`, then set variables:

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

`/shorts.html`: upload a video (or paste a YouTube / X / Instagram / TikTok / Reddit link). A video model watches a low-res copy, picks the best 15–30 s (or 30–60 s) moment and writes the hook, title, description, hashtags and thumbnail text. ffmpeg then cuts it to 1080x1920 @30fps (smart crop or full frame on a blurred background), burns word captions in the Anton font (`fonts/`, SIL OFL), normalises loudness and grabs a thumbnail. Results live in `DATA_DIR/work/shorts/<id>/` until deleted from the page. Locally, install yt-dlp (`pip install yt-dlp`) for link support.
