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

## Spend tracker

The sidebar (or the chip at the top of each page on phones) shows this month's AI spend. Click it for today / this week / this month and the credit left (straight from OpenRouter, calendar month in UTC, everything the API key spent), the key's spending limit, and a breakdown by feature and by day from the app's own log in `DATA_DIR/data/spend-YYYY-MM.json` (voice costs there are estimates; the voice service doesn't report them).

## Neon glitch look

Shorts (Options → Look) and Story mode (checkbox above the scenes) can add the app's theme to the finished video: faint scanlines, a slight RGB fringe and vignette, plus short bursts of horizontal tearing with a strong RGB split and static (`glitch.js`, ffmpeg only, no AI cost). On Shorts it goes under the captions so the text stays sharp.

## Settings and Muse by Meta

`/settings` (saved on the server in `DATA_DIR/data/settings.json`): pick the AI provider (**Default** or **Muse by Meta**: Muse Ember for writing, Muse Spark 1.3 for watching videos in the Shorts maker, Muse Image for pictures and the character lock; all through your OpenRouter key), or mix models by hand; set a **monthly spending cap** (paid calls are refused with a clear message once this month's spend reaches it); choose how long working files and finished Shorts are kept; turn the easter-egg glitches on or off. "Test connection" pings the chosen writing model.

## Story: one button and consistent characters

Paste a story, pick Quality (Budget / Balanced / Best), Length and Look, then **Make my video**: it plans, generates every scene and stitches. With **Keep characters consistent** on, Muse Image draws one character sheet (optionally built on a saved influencer), then every scene starts from a first frame drawn from that sheet (about $0.02 per scene). **Plan scenes first** lets you review and edit before paying; Advanced settings holds the per-model controls. Story history is saved on the server, so it follows you across devices.

## Shorts: choose the part

Options → "Search only this part": give a From / To time (12:30, 1:02:03) and the AI only looks there. A part shorter than the Short length is used as it is.

## Reliability

- **PROXY_KEY is required** when `PUBLIC_URL` is set: without it the API answers 503 so nobody who finds the backend address can spend your credit (set `ALLOW_OPEN=1` only for testing).
- Rendering is queued: `RENDER_JOBS` whole jobs at once (default 1 on a public server, 2 locally) and `FFMPEG_SLOTS` ffmpeg processes (default 2).
- Video jobs (`data/jobs.json`), Story stitches (`work/<id>/status.json`) and Shorts survive restarts; anything cut off mid-way is marked as failed with a clear message instead of spinning forever.
- OpenRouter calls retry twice on rate limits and passing server errors; calls that start paid work are only retried when it's safe (429 or never sent), so nothing is charged twice.
- Old working files are cleaned up every 6 hours (Settings → Storage).
- Prices on the Single clip and Story pages come live from OpenRouter (`/api/prices`, cached 6 h).
- Code: `server.js` (core + generation routes), `routes/story.js`, `routes/system.js`, `shorts.js`, `lib/` (settings, spend, retries, queue, cleanup, prices, persistence, edit helpers). Tests: `npm test` (`node --test`; the render test needs ffmpeg).
