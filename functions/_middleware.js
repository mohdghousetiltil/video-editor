// Optional password gate for the whole site (pages + /api). Set APP_PASSWORD (and optionally APP_USER) in
// Cloudflare to require a login; leave it unset and the site is open to anyone who has the address.
export async function onRequest({ request, env, next }) {
  if (!env.APP_PASSWORD) return next();
  const want = "Basic " + btoa(`${env.APP_USER || "admin"}:${env.APP_PASSWORD}`);
  if (request.headers.get("Authorization") !== want)
    return new Response("Login required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="VD-0"' } });
  return next();
}
