// Cloudflare Worker entry (the site is deployed as a Worker with static assets, which ignores functions/).
// Same behaviour as the Pages Functions: password gate on everything, /api/* proxied to the Railway backend,
// everything else served from ./public. The logic lives in functions/ so both deploy styles share it.
import { onRequest as gate } from "./functions/_middleware.js";
import { onRequest as proxy } from "./functions/api/[[path]].js";

// Pages get /app.css and /app.js stamped with this deploy's id (?v=…), so phones can cache those files for a
// year (see public/_headers) and a freshly deployed page can never run with yesterday's CSS/JS.
async function servePage(request, env) {
  const v = (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id || "").slice(0, 8);
  const url = new URL(request.url);
  if (/^\/(app\.css|app\.js|studio\.js|theme\.js)$/.test(url.pathname) && url.searchParams.get("v")) { // versioned: safe to keep for a year
    const a = await env.ASSETS.fetch(request);
    const r = new Response(a.body, a);
    if (a.ok) r.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return r;
  }
  const isPage = request.method === "GET" && !/\.[a-z0-9]+$/i.test(url.pathname);
  if (!v || !isPage) return env.ASSETS.fetch(request);
  // always send the full page: a 304 would keep the browser's copy with an older ?v=
  const h = new Headers(request.headers);
  h.delete("if-none-match"); h.delete("if-modified-since");
  const res = await env.ASSETS.fetch(new Request(request, { headers: h }));
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const out = new HTMLRewriter()
    .on('link[href="/app.css"]', { element: (e) => e.setAttribute("href", "/app.css?v=" + v) })
    .on('script[src="/app.js"]', { element: (e) => e.setAttribute("src", "/app.js?v=" + v) })
    .on('script[src="/studio.js"]', { element: (e) => e.setAttribute("src", "/studio.js?v=" + v) })
    .on('script[src="/theme.js"]', { element: (e) => e.setAttribute("src", "/theme.js?v=" + v) })
    .transform(res);
  const r = new Response(out.body, out);
  r.headers.delete("etag"); r.headers.delete("last-modified");
  r.headers.set("Cache-Control", "no-cache");
  return r;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    return gate({
      request,
      env,
      next: () => (path.startsWith("/api/") ? proxy({ request, env }) : servePage(request, env)),
    });
  },
};
