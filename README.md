# video-editor

AI video studio: single clips, story mode, UGC, poses and motion.

Run: copy `.env.example` to `.env`, add your OpenRouter key, then `node server.js` (http://localhost:3000).

## Deploy: backend on Railway, frontend on Cloudflare Pages

**Railway** (this repo, root directory): Railway builds the `Dockerfile` (Node 20 + ffmpeg). Add a Volume mounted at `/data`, set the healthcheck path to `/healthz`, then set variables:

| Variable | Value |
|---|---|
| `OPENROUTER_API_KEY` | your key |
| `DATA_DIR` | `/data` |
| `PROXY_KEY` | long random string (same as in Cloudflare) |
| `PUBLIC_URL` | the Railway public URL, e.g. `https://xxx.up.railway.app` |

**Cloudflare Pages** (connect the same GitHub repo): build command empty, output directory `public`. The `functions/` folder is picked up automatically. Variables:

| Variable | Value |
|---|---|
| `BACKEND_URL` | the Railway public URL |
| `PROXY_KEY` | same as Railway |
| `APP_PASSWORD` | password to open the site (login prompt) |
| `APP_USER` | optional, defaults to `admin` |
