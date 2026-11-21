// App-wide routes: settings, spend tracker, live prices, render queue status.
const fs = require("fs");

module.exports = function systemRoutes(ctx) {
  const { DATA, send, readBody, settings, spend, prices, renderSlot, getKey } = ctx;
  return async function handle(req, res, url) {
    if (url.pathname === "/api/settings") {
      if (req.method === "GET") return send(res, 200, { settings: settings.get(), choices: settings.CHOICES, presets: settings.PRESETS }), true;
      if (req.method === "PUT") {
        const b = await readBody(req);
        return send(res, 200, { settings: settings.set(b || {}) }), true;
      }
    }
    // "Test connection": one tiny call to the chosen text model (a fraction of a cent) to prove it answers
    if (req.method === "POST" && url.pathname === "/api/settings/test") {
      const b = await readBody(req);
      const model = settings.CHOICES.textModel.concat(settings.CHOICES.visionModel).some(([id]) => id === b.model) ? b.model : settings.get().textModel;
      const t = Date.now();
      try {
        const r = await ctx.orFetch(`${ctx.API}/chat/completions`, { method: "POST", headers: ctx.orHeaders(),
          body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content: "Reply with exactly: ONLINE" }] }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return send(res, 200, { ok: false, model, error: j.error?.message || `HTTP ${r.status}` }), true;
        spend.log("Settings test", j.usage?.cost, model);
        return send(res, 200, { ok: true, model, ms: Date.now() - t, reply: String(j.choices?.[0]?.message?.content || "").trim().slice(0, 40), cost: j.usage?.cost || 0 }), true;
      } catch (e) { return send(res, 200, { ok: false, model, error: e.message }), true; }
    }
    if (req.method === "GET" && url.pathname === "/api/spend") {
      const m = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : spend.monthKey();
      const current = m === spend.monthKey();
      const months = fs.existsSync(DATA) ? fs.readdirSync(DATA).map((f) => (f.match(/^spend-(\d{4}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort().reverse() : [];
      const or = current && getKey() ? await spend.openrouter(url.searchParams.has("fresh")) : null;
      const cap = Number(settings.get().monthlyCap) || 0;
      return send(res, 200, { month: m, current, openrouter: or, local: spend.summarise(spend.read(m)), months, cap }), true;
    }
    if (req.method === "GET" && url.pathname === "/api/prices") return send(res, 200, { prices: await prices() }), true;
    if (req.method === "GET" && url.pathname === "/api/queue") return send(res, 200, renderSlot.stats()), true;
    return false;
  };
};
