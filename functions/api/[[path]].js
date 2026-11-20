// Forwards /api/* to the Railway backend. BACKEND_URL and PROXY_KEY are set in Cloudflare Pages settings.
export async function onRequest({ request, env }) {
  const u = new URL(request.url);
  const target = env.BACKEND_URL.replace(/\/$/, "") + u.pathname + u.search;
  const h = new Headers(request.headers);
  h.set("x-proxy-key", env.PROXY_KEY || "");
  h.delete("authorization"); h.delete("host");
  const init = { method: request.method, headers: h, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) { init.body = request.body; init.duplex = "half"; }
  return fetch(target, init);
}
