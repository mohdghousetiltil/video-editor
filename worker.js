// Cloudflare Worker entry (the site is deployed as a Worker with static assets, which ignores functions/).
// Same behaviour as the Pages Functions: password gate on everything, /api/* proxied to the Railway backend,
// everything else served from ./public. The logic lives in functions/ so both deploy styles share it.
import { onRequest as gate } from "./functions/_middleware.js";
import { onRequest as proxy } from "./functions/api/[[path]].js";

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    return gate({
      request,
      env,
      next: () => (path.startsWith("/api/") ? proxy({ request, env }) : env.ASSETS.fetch(request)),
    });
  },
};
