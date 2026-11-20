// Password gate for the whole site (pages + /api). Set APP_PASSWORD (and optionally APP_USER) in Cloudflare.
export async function onRequest({ request, env, next }) {
  if (!env.APP_PASSWORD) return new Response("Set APP_PASSWORD in the Cloudflare settings (Variables and secrets).", { status: 500 });
  const want = "Basic " + btoa(`${env.APP_USER || "admin"}:${env.APP_PASSWORD}`);
  if (request.headers.get("Authorization") !== want)
    return new Response("Login required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Video Studio"' } });
  return next();
}
