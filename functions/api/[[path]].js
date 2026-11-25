// Forwards /api/* to the Railway backend. BACKEND_URL and PROXY_KEY are set in Cloudflare Pages settings.
export async function onRequest({ request, env }) {
  const json = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
  // Where the visitor is, from Cloudflare's own data on this request (no outside lookup, nothing stored, the IP is not returned).
  if (new URL(request.url).pathname === "/api/geo") {
    const cf = request.cf || {};
    return new Response(JSON.stringify({ country: cf.country || null, region: cf.region || null, city: cf.city || null }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  }
  if (!env.BACKEND_URL) return json(500, "BACKEND_URL is not set in the Cloudflare settings (Variables and secrets).");
  // accept "xxx.up.railway.app", "http://…" or "https://…/" and always talk HTTPS (Railway redirects http with an empty body)
  const base = "https://" + env.BACKEND_URL.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const u = new URL(request.url);
  const h = new Headers(request.headers);
  // trim: a pasted secret often carries a trailing space/newline or quotes
  const key = String(env.PROXY_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!key) return json(500, "This Cloudflare Worker has no PROXY_KEY at runtime. Add it under Worker > Settings > Variables and secrets (the card without 'API token', not the Build one), type Secret, then Deploy.");
  h.set("x-proxy-key", key);
  h.delete("authorization"); h.delete("host");
  const init = { method: request.method, headers: h, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) { init.body = request.body; init.duplex = "half"; }
  let r;
  try { r = await fetch(base + u.pathname + u.search, init); }
  catch (e) { return json(502, "Can't reach the backend at " + base + " (" + e.message + ")."); }
  if (r.status === 401) return json(502, `Backend refused the request: Cloudflare's PROXY_KEY (${key.length} characters, starts "${key.slice(0, 4)}") doesn't match Railway's. Set both to exactly the same value.`);
  // the app's own JSON errors pass through; only a bare gateway page means the backend itself is down
  if ((r.status === 502 || r.status === 503) && !(r.headers.get("content-type") || "").includes("application/json")) {
    const t = await r.text();
    return json(502, "Backend is not responding (" + r.status + "). On Railway check the service is running and the domain's port matches the PORT in the logs. " + t.slice(0, 200));
  }
  return r;
}
