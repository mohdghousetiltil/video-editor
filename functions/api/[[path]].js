// Forwards /api/* to the Railway backend. BACKEND_URL and PROXY_KEY are set in Cloudflare Pages settings.
export async function onRequest({ request, env }) {
  const json = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
  if (!env.BACKEND_URL) return json(500, "BACKEND_URL is not set in the Cloudflare settings (Variables and secrets).");
  // accept "xxx.up.railway.app", "http://…" or "https://…/" and always talk HTTPS (Railway redirects http with an empty body)
  const base = "https://" + env.BACKEND_URL.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const u = new URL(request.url);
  const h = new Headers(request.headers);
  h.set("x-proxy-key", env.PROXY_KEY || "");
  h.delete("authorization"); h.delete("host");
  const init = { method: request.method, headers: h, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) { init.body = request.body; init.duplex = "half"; }
  let r;
  try { r = await fetch(base + u.pathname + u.search, init); }
  catch (e) { return json(502, "Can't reach the backend at " + base + " (" + e.message + ")."); }
  if (r.status === 401) return json(502, "Backend refused the request: PROXY_KEY in Cloudflare and Railway don't match.");
  if (r.status === 502 || r.status === 503) {
    const t = await r.text();
    return json(502, "Backend is not responding (" + r.status + "). On Railway check the service is running and the domain's port matches the PORT in the logs. " + t.slice(0, 200));
  }
  return r;
}
