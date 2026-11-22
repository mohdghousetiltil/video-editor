// Look routes: list the looks, and set the chosen look and the character description (both apply to every clip).
module.exports = function themeRoutes(ctx) {
  const { send, readBody, settings, themes } = ctx;
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/themes")) return false;
    const out = (s) => ({ themes: themes.all(), active: themes.get(s.themeId) ? themes.get(s.themeId).id : null, character: s.character || "" });
    if (req.method === "GET" && url.pathname === "/api/themes") return send(res, 200, out(settings.get())), true;
    if (req.method === "PUT" && url.pathname === "/api/themes/active") {
      const b = (await readBody(req)) || {};
      const patch = {};
      if (b.id === null || (typeof b.id === "string" && themes.get(b.id))) { patch.themeId = b.id === null ? null : themes.get(b.id).id; patch.themeLock = !!patch.themeId; }
      if (typeof b.character === "string") patch.character = b.character;
      return send(res, 200, out(settings.set(patch))), true;
    }
    return false;
  };
};
