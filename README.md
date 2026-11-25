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
| `FAL_KEY` | optional, fal.ai key: Kling goes through fal.ai (about half the price) |
| `BYTEPLUS_KEY` | optional, BytePlus ModelArk key: Seedance goes through BytePlus (about half again). Model ids default to the ModelArk ids of Nov 2026 (`dreamina-seedance-2-0-fast-260128`…); override with `BYTEPLUS_SEEDANCE_FAST_MODEL`, `BYTEPLUS_SEEDANCE_MODEL`, `BYTEPLUS_SEEDANCE_MINI_MODEL`, `BYTEPLUS_SEEDANCE_25_MODEL`. Each model must be activated in the ModelArk console; fal app ids: `FAL_KLING_APP`, `FAL_KLING_I2V_APP` |

**Cloudflare** (connect the same GitHub repo). As a **Worker** (current setup): `wrangler.jsonc` + `worker.js` serve `public/`, ask for the password and proxy `/api` to Railway; deploy command `npx wrangler deploy`, and the `name` in `wrangler.jsonc` must match the Worker name. As a **Pages** project instead: build command empty, output directory `public`, and `functions/` is picked up automatically. Variables (either way):

| Variable | Value |
|---|---|
| `BACKEND_URL` | the Railway public URL |
| `PROXY_KEY` | same as Railway |
| `APP_PASSWORD` | password to open the site (login prompt) |
| `APP_USER` | optional, defaults to `admin` |

## Scaling renders: web service + render workers

Rendering (Shorts, picture explainers, Story stitches, Enhance) is the heavy part: ffmpeg at full CPU for minutes. By default it runs inside the web server, a few at a time. To give it machines of its own, add a Postgres database and a bucket: the web service then only **queues** renders, and any number of **render workers** (the same Docker image) pick them up.

```
browser -> Cloudflare -> web service (API, pages, volume /data)
                           |  queue a job: row in render_jobs (Postgres)
                           |  input files -> bucket (R2 / S3)
                           v
                    render worker x N: claim job (FOR UPDATE SKIP LOCKED), copy inputs down, ffmpeg, copy outputs up
                           |  progress every 5 s, then the result, History and spend records
                           v
                    web service copies the finished files back to its volume and serves them as before
```

- **Queue** (`lib/jobqueue.js`, table `db/render_jobs.sql`, created automatically): workers claim with `SELECT … FOR UPDATE SKIP LOCKED`, so replicas never get the same job. A worker heartbeats while it renders; a job whose worker went quiet for 90 s (crash, redeploy, out of memory) or that ran past `RENDER_TIMEOUT_MIN` goes back in the queue with back-off (15 s, 30 s, … up to 5 min) until it has used `RENDER_MAX_ATTEMPTS` (default 2), then it is marked failed with a clear message. A job's own failures (bad video, model error) fail straight away and are not retried, so nothing is paid for twice. On a redeploy a worker finishes or hands back its jobs (`RENDER_DRAIN_SEC`, default 10 s) without using up an attempt. Rows carry a `user_id` column for when accounts arrive.
- **Files** (`lib/objstore.js`, no SDK): keys in the bucket mirror paths under `DATA_DIR` (`work/shorts/<id>/short.mp4`). A worker only keeps a job's files while it renders. The bucket is a hand-over point, not the archive: the web service's volume still holds every result, so a lifecycle rule that deletes objects after 7 days is fine.
- **Same code, two roles** (`lib/render.js`): each render kind is defined once (Shorts in `shorts.js`, stitches in `routes/story.js`, Enhance in `lib/enhance.js`) and runs either in-process or on a worker. History records and spend logged during a render on a worker travel back with the result and are written by the web service, so there is still one History and one spend ledger (the spend cap is checked on the web service before a job is queued).
- **No `DATABASE_URL`**: nothing changes, renders run in the web server as before (`RENDER_QUEUE=off` does the same with a database set).

### Railway setup

1. **Postgres**: in the project, *New → Database → PostgreSQL*.
2. **Bucket** (Cloudflare R2): *R2 → Create bucket* (e.g. `video-studio`), then *Manage R2 API tokens → Create API token* with *Object Read & Write* on that bucket. Note the Account ID, Access Key ID and Secret. Optional: *Settings → Object lifecycle rules →* delete after 7 days.
3. **Web service** (the existing one): keep its variables, volume and healthcheck, and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference variable) |
   | `S3_BUCKET` | `video-studio` |
   | `R2_ACCOUNT_ID` | your Cloudflare account id (or `S3_ENDPOINT` for another S3-compatible service; plain AWS S3 needs only `S3_REGION`) |
   | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | the R2 token |

4. **Worker service**: *New → GitHub repo →* the same repo. It builds the same `Dockerfile`, and `railway.json`'s `/healthz` check works (the worker answers it). No volume and no public domain needed. Variables:

   | Variable | Value |
   |---|---|
   | `RENDER_ROLE` | `worker` |
   | `DATABASE_URL`, `S3_BUCKET`, `R2_ACCOUNT_ID`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | same as the web service |
   | `OPENROUTER_API_KEY` | same key (Shorts ask the AI and voice their narration from the worker) |
   | `RENDER_JOBS` | renders at once per replica (default 2) |
   | `FFMPEG_SLOTS` / `FFMPEG_THREADS` | ffmpeg processes per replica (default 2) and threads each (default no cap) |

5. **Size it**: give the worker CPU and memory (*Settings → Resources*); a Short peaks around 500 MB per ffmpeg process with threads capped, more without. For more throughput raise *Settings → Deploy → Replicas*: every replica is another worker pulling from the same queue. Rough guide: one replica with 8 vCPU / 8 GB and `RENDER_JOBS=3` renders three Shorts side by side; add replicas when pages show "Waiting for N other videos" too often.
6. The web service can stay small: it no longer runs renders, only short ffmpeg steps (thumbnails, picture conversions).

Check: the web log says `renders: queued for render workers`; the worker log says `render worker …: up to N job(s) at once`, then one line per job it picks up.

Limits of this step: the web service is still a single instance (live job state and the result files are on it), so running several web replicas is a later step. Without `S3_BUCKET`, web and worker must share one `DATA_DIR`, which Railway services can't do (volumes are per service), so on Railway the bucket is required.

### Locally

- One process, as always: `npm start`.
- Web + worker on one PC (no bucket needed, they share `DATA_DIR`): set `DATABASE_URL` in `.env`, then run `npm start` in one terminal and `npm run worker` in another with a different `PORT`.

### Render variables

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | Postgres for the render queue; unset = render in the web server |
| `RENDER_ROLE` | `web` | `worker` (or `node server.js --worker`) = only pull and render jobs |
| `RENDER_QUEUE` | on | `off` = render in-process even with `DATABASE_URL` |
| `RENDER_JOBS` | 1 public / 2 local; worker 2 | renders at once (per process) |
| `RENDER_TIMEOUT_MIN` | 20 | one attempt may run this long |
| `RENDER_MAX_ATTEMPTS` | 2 | attempts before a job is failed (worker lost, timeout, storage error) |
| `RENDER_STALE_SEC` | 90 | no heartbeat for this long = worker lost, job re-queued |
| `RENDER_DRAIN_SEC` | 10 | on shutdown, wait this long for running jobs before handing them back |
| `S3_BUCKET` (or `R2_BUCKET`) | none | shared bucket; unset = shared `DATA_DIR` |
| `R2_ACCOUNT_ID` / `S3_ENDPOINT` / `S3_REGION` | | where the bucket is (R2 account, any S3 endpoint, or an AWS region) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | | bucket credentials |
| `S3_PREFIX` | none | key prefix, to share one bucket between environments |
| `PGSSL` | off | `1` = TLS to Postgres (Railway's private network doesn't need it) |

Tests: `npm install`, then `npm test`. The queue tests run on a real Postgres compiled to WebAssembly (PGlite, a dev dependency); with `TEST_DATABASE_URL=postgres://…` they also check that two connections claiming at once never get the same job.

## Shorts maker

**Story mode (default voiceover):** the AI watches the clip, opens with a 1–2 s flash of the best moment (cold open, white flash + rewind sound) and a hook line ("Wait till you see what happens"), then tells it like a story ("Here's how it started…"), narrating every quiet stretch. The clip's own sound glides down under the narrator and back up after. Music is generated by the app (no copyright): **Auto** picks upbeat, suspense, chill, epic or funny from the clip's mood; it fills quiet parts and dips automatically under speech. Sound effects (boom on the hook, rewind, whoosh on cuts) are generated too. Narrator lines and effects are pre-mixed into one track before the final render (short audio inputs ending early inside the video graph deadlocked ffmpeg).


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
- Rendering is queued and sized for a small server: `RENDER_JOBS` whole jobs at once (default 1 on a public server, 2 locally), `FFMPEG_SLOTS` ffmpeg processes (default 1 public / 2 local) and `FFMPEG_THREADS` threads per process (default 2 public / no cap locally; 0 = no cap). Each step then peaks around 500 MB. Shorts edits render one jump-cut piece at a time, so memory no longer grows with the Short's length.
- Video jobs (`data/jobs.json`), Story stitches (`work/<id>/status.json`) and Shorts survive restarts; anything cut off mid-way is marked as failed with a clear message instead of spinning forever.
- OpenRouter calls retry twice on rate limits and passing server errors; calls that start paid work are only retried when it's safe (429 or never sent), so nothing is charged twice.
- Old working files are cleaned up every 6 hours (Settings → Storage).
- Prices on the Single clip and Story pages come live from OpenRouter (`/api/prices`, cached 6 h).
- Code: `server.js` (core + generation routes), `routes/story.js`, `routes/system.js`, `shorts.js`, `lib/` (settings, spend, retries, queue, cleanup, prices, persistence, edit helpers; `render.js`, `jobqueue.js` and `objstore.js` for render workers, see *Scaling renders*). Tests: `npm test` (`node --test`; the render test needs ffmpeg).

## Costs, confirmations and history

- **One model table** (`lib/models.js`, served at `/api/models`) merges OpenRouter's live model list: pages only offer lengths and resolutions a model accepts, the server refuses any other length, and every page shows the **total** ("$0.40 for 4 s"), not only a per-second price. Models are tagged Draft / Regular / Hero; 720p is the default (1080p is marked for hero YouTube shots).
- **Nothing is charged without a confirmation** showing model, length, resolution and total. The first one also says it charges real money. Settings can skip it for calls under $0.10–$0.50.
- **Monthly cap is $10 by default** (0 = no cap, only when you set it on purpose). The sidebar and the spend dialog use the same labels: *OpenRouter month total*, *Credit left*, *Cap left*; the app's own log is shown as an estimate next to the gap.
- **Progress** shows the stage (Queued, Generating, Done) and the time elapsed, never a guessed countdown.
- **History** (`/history`, `data/history.json`): every clip, Story, Short and influencer animation, searchable by name, kind, status and date, with play, download, retry and delete. The sidebar shows what is running.
- **Routing**: with `FAL_KEY` / `BYTEPLUS_KEY` set, the cheapest configured provider is used per model (Settings shows which). Their costs are estimates in the log.
- **Shorts**: a source shorter than the Short gets a warning first (make a shorter Short, loop, or hold the last frame). Original sound can be kept, lowered or muted (muted for the first 3 s under a hook voiceover). Zoom is capped and anchored on the subject (crop safety), with caption on/off and styles, an optional music bed, a preflight summary with estimated cost, and "Retry render" that reuses the analysis.
- **Story**: Budget mode says up front how many seconds of real video the budget buys; each scene warns when its narration won't fit. The character sheet only shows with the lock on, with its cost; scenes share one seed; the planner aims for 3–5 s shots.
- Forms remember what you typed when you leave a page. Help, first-run tour and footer (Help / About / Privacy / Spend & refunds) are on every page.

## Themes, storyboard and Enhance

- **Look and character** (section 3 on Single clip and a Look box inside the Script panel on Story; UGC, Poses, Copy motion and Shorts never use it): pick one look, **Real, Disney, Pixar, Anime or Brain rot** (or None), and optionally describe the main character. ✨ **Enhance character** turns a rough idea into one exact description (face, hair, outfit, colours). The server adds the look and the character, word for word, to every clip and storyboard picture (`lib/themes.js`, `PUT /api/themes/active`). The prompt describes each look in plain words, since video models refuse brand names. On Story, ✨ **Enhance characters** does the same for the character & setting bible.
- **Quality booster** (on by default): adds "sharp focus, natural motion, stable anatomy" and an Avoid line (warping, extra fingers, garbled text…) plus your own negative prompt. Single clip shows the seed used, can lock it and can reuse it.
- **Storyboard (Story → Picture first)**: one still per scene (`/api/still`, about $0.02 each, in the theme, from the character sheet or the saved influencer), shown side by side before any video is paid for. Redraw or swap any scene with your own AI-made picture. Each scene is then animated from its picture and, with **Connect scenes**, ends on the next scene's picture on models that support an end frame.
- **Enhance** (after a clip, Story video or Short, and in History): free, on your server with ffmpeg. Upscale to 720p or 1080p, sharpen, denoise, and optionally smooth motion (frame interpolation, which also smooths the slowed and held clips of Story budget mode).

## 🧠 The Director (Auto)

Pick **🧠 Auto** as the model on Single clip, UGC, Poses or Copy motion, or **🧠 Auto (Director)** as the Quality on Story. The app's brain (`lib/director.js`, `POST /api/director`, Gemini 3.5 Flash by default, set in Settings) reads every usable video model and plans the job: which model, how long, which resolution, sound, picture first, Enhance. For a story it plans every scene. Its goal is **the best quality that fits your budget**: the best models go where viewers notice (faces, close-ups, key scenes), cheaper ones go on B-roll.

- **Every model:** `lib/models.js` takes in every model on OpenRouter's live list by itself, new ones included. Each gets a tier from its price, a quality score and strength tags (faces, motion, anime, dialogue…). Edit, upscale and avatar models that need special inputs are left out. Kling 3 Pro and Kling 3 Turbo appear when `FAL_KEY` is set.
- **Never trusted blindly:** the server checks the plan against the real catalog, snaps lengths to allowed values and works out every cost itself. If the plan is over budget, it gives up the least visible quality first (filler scenes, pictures for scenes without people, then shorter clips) and never touches the close-ups first. If the brain doesn't answer, fixed rules plan instead, so Auto always gives an answer.
- **You approve it:** before anything is charged you see the plan: the chosen model and why, length, resolution, picture first, Enhance, the total next to your budget, and alternatives you can switch to with one tap. A plan costs about half a cent to one cent.
- **Default budgets** per job are set in Settings (clip $0.50, story $2, UGC $0.80, pose $0.15, copy motion $1) and can be changed on each page.

Reliability: if the brain's reply is broken or names a model that doesn't exist, it gets one second try that says what was wrong. Model names are mapped back to ids ("Veo 3.1 Fast" → `google/veo-3.1-fast`). Story scenes it skips are filled in by the rules. A pick far below what the budget buys is upgraded (the first pick stays as an alternative). The brain call times out after 45 s, and the same request within 10 minutes returns the same plan for free.

## Credit tracking

The spend tracker shows OpenRouter's month total and credit, plus fal.ai's credit left (read live from fal) and its month spend (from the app's log, or fal's own figure if `FAL_ADMIN_KEY`, an admin-scoped key, is set). The monthly cap counts **all providers**.

## Scripts (More → Scripts)
A chat with a suspense writer (uses the Director's brain model, about 1–2 cents a reply). It writes original stories, not reaction content, using the craft of thriller books, films and real creator hooks: a cold open, an open loop, a ticking clock and a twist that loops back to the first line. Each script comes as a hook, then timed beats with spoken lines and visuals, then the twist and title ideas. Choose length (30/60/90 s) and format (narrated, POV, dialogue). Buttons under each reply: **Use in Story mode** (sends only the spoken lines to Story), Copy, Make it scarier, Different twist. The chat is kept in your browser.

## Influencers from your own photo
Video models refuse photos of real people, so **Make influencer from my photo** turns an uploaded photo into a new AI character that keeps the hair, skin tone, eyes and outfit vibe: Realistic (an original AI person inspired by the photo, for Grok, Veo and most models), or 3D animated, 2D Disney-like, Ghibli-like or Anime (fully redrawn, accepted by Seedance too). Head-and-shoulders, front-facing, plain background, 9:16, ready to animate in UGC.

## App feel, music and guide (latest)
- **Phones:** no pinch or double-tap zoom, the nav and icons act like buttons (no text selection or copy callout on long press), soft page fades and press feedback. **More** opens the pages on a circle in the middle of the screen.
- **Look:** swipe the cards; the one in the middle is used (tap a card or use the arrows on desktop).
- **Music:** a new **Cinematic** mood for Shorts. Under any finished clip, **Add background music** mixes in a generated, copyright-free track that dips under voices (free, the picture isn't re-encoded). The moods live in `lib/music.js`.
- **Story:** Auto (Director) is now the first and default quality.
- **Scripts:** replies are typed out (tap to show all) in the app's font.
- **Less text:** pages show just the cost and short hints; the details are on **How it works** (`/guide`, linked in the footer and Help).
- **Easter eggs on touch screens:** 2-finger tap (RGB split), 3-finger tap (nav hack), hold the page title (hologram), pull down hard at the top 3 times (system reboot), turn the phone sideways and back (barrel roll), and a once-a-day boot screen in the iPhone home-screen app.
