// App-wide routes: settings, spend tracker, live prices, render queue status.
const fs = require("fs");

module.exports = function systemRoutes(ctx) {
  const { DATA, send, readBody, settings, spend, prices, renderSlot, getKey } = ctx;
  // fal.ai credit left (any API key can read it) and, with an admin-scoped FAL_ADMIN_KEY, its official usage this month
  let falCache = null;
  async function falCredit(force) {
    if (!force && falCache && Date.now() - falCache.t < 60000) return falCache.v;
    const get = (u, k) => fetch(u, { headers: { Authorization: `Key ${k}` }, signal: AbortSignal.timeout(10000) }).then(async (r) => (r.ok ? r.text() : null)).catch(() => null);
    const bal = await get("https://rest.alpha.fal.ai/billing/user_balance", process.env.FAL_KEY);
    const v = { balance: bal != null && isFinite(+bal) ? +(+bal).toFixed(4) : null, month: null };
    if (process.env.FAL_ADMIN_KEY) {
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const u = await get(`https://api.fal.ai/v1/models/usage?expand=summary&start=${start.toISOString()}`, process.env.FAL_ADMIN_KEY);
      try { const j = JSON.parse(u); v.month = +(j.summary || []).reduce((a, x) => a + (+x.cost || 0), 0).toFixed(4); } catch {}
    }
    falCache = { t: Date.now(), v };
    return v;
  }
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
      const fal = current && process.env.FAL_KEY ? await falCredit(url.searchParams.has("fresh")) : null;
      return send(res, 200, { month: m, current, openrouter: or, fal, local: spend.summarise(spend.read(m)), months, cap, capUsed: current ? await spend.capUsed() : null, limits: current ? spend.limits() : null }), true;
    }
    // hidden "system reboot" (five quick taps in Settings): the monthly cap starts counting again from now
    if (req.method === "POST" && url.pathname === "/api/system/reboot") return send(res, 200, { ok: true, from: +(await spend.reboot()).toFixed(2) }), true;
    if (req.method === "GET" && url.pathname === "/api/prices") return send(res, 200, { prices: await prices() }), true;
    // what's running and waiting: render slots (Story stitches, Shorts) plus video generations still in progress
    if (req.method === "GET" && url.pathname === "/api/queue") {
      const running = ctx.history ? ctx.history.list({ status: "running", limit: 30 }).filter((r) => Date.now() - r.t < 3 * 3600000) : [];
      const items = running.map((r) => ({ id: r.id, kind: r.kind, title: r.title, model: r.model, status: r.status, t: r.t }));
      return send(res, 200, { ...renderSlot.stats(), items }), true;
    }
    return false;
  };
};
