// Theme routes: list / save / delete themes, pick the active one and Theme Lock, style picture, example picture.
const fs = require("fs");

module.exports = function themeRoutes(ctx) {
  const { send, readBody, settings, themes, orFetch, orHeaders, API, spend } = ctx;
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/themes")) return false;
    let m;
    if (req.method === "GET" && url.pathname === "/api/themes") {
      const st = settings.get();
      return send(res, 200, { themes: themes.all().map(themes.pub), active: st.themeId || null, lock: !!st.themeLock }), true;
    }
    if (req.method === "PUT" && url.pathname === "/api/themes/active") {
      const b = await readBody(req);
      const id = b.id === null ? null : themes.get(b.id) ? b.id : settings.get().themeId;
      const s = settings.set({ themeId: id, themeLock: typeof b.lock === "boolean" ? b.lock && !!id : undefined });
      return send(res, 200, { active: s.themeId, lock: s.themeLock }), true;
    }
    if (req.method === "POST" && url.pathname === "/api/themes") {
      const b = await readBody(req, 12e6);
      const t = themes.save(b || {});
      if (b.styleImage && String(b.styleImage).startsWith("data:")) themes.setImage(t.id, "style", b.styleImage);
      if (b.removeStyleImage) fs.rm(themes.imgPath(t.id, "style"), { force: true }, () => {});
      return send(res, 200, themes.pub(themes.get(t.id))), true;
    }
    if ((m = url.pathname.match(/^\/api\/themes\/([\w-]+)$/)) && req.method === "DELETE") {
      const t = themes.get(m[1]);
      if (!t || t.builtin) return send(res, 400, { error: "Built-in presets can't be deleted." }), true;
      themes.remove(m[1]);
      if (settings.get().themeId === m[1]) settings.set({ themeId: null, themeLock: false });
      return send(res, 200, { ok: true }), true;
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/themes\/([\w-]+)\/(image|example)$/))) {
      const kind = m[2] === "image" ? "style" : "example";
      if (!themes.hasImg(m[1], kind)) { res.writeHead(404); return res.end("Not found"), true; }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
      return fs.createReadStream(themes.imgPath(m[1], kind)).pipe(res), true;
    }
    // example picture for a theme (one image, about a cent): shows what the theme looks like before paying for video
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/themes\/([\w-]+)\/example$/))) {
      const t = themes.get(m[1]);
      if (!t) return send(res, 404, { error: "Unknown theme." }), true;
      const blocked = await spend.capBlock();
      if (blocked) return send(res, 402, { error: blocked, cap: true }), true;
      const model = settings.get().imageModel;
      const style = themes.styleDataUrl(t.id);
      const prompt = `A single vertical 9:16 film still that shows this visual theme: ${t.style}. Palette: ${t.palette}. Lighting: ${t.lighting}. Camera: ${t.camera}.` +
        (t.character ? ` Main character: ${t.character}.` : " A friendly young traveller as the main character.") + (t.outfit ? ` Outfit: ${t.outfit}.` : "") +
        (style ? " Image 1 is the style reference: match its look, colours and rendering." : "") + " No text, no borders.";
      const r = await orFetch(`${API}/images`, { method: "POST", headers: orHeaders(), body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: "9:16", ...(style ? { input_references: [{ type: "image_url", image_url: { url: style } }] } : {}) }) }, { safe: false });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.data?.[0]?.b64_json) return send(res, r.ok ? 502 : r.status, { error: j.error?.message || "The image model returned no picture." }), true;
      themes.setImage(t.id, "example", `data:image/png;base64,${j.data[0].b64_json}`);
      spend.log("Themes", j.usage?.cost, model);
      return send(res, 200, { example: `/api/themes/${t.id}/example?v=${Date.now()}`, cost: j.usage?.cost || 0 }), true;
    }
    return false;
  };
};
