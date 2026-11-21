// Spend tracker + monthly cap. Every AI call's cost goes into data/spend-YYYY-MM.json (one file per calendar month,
// UTC). OpenRouter's own monthly figure (GET /key) stays the authoritative total and is what the cap checks.
const fs = require("fs");
const path = require("path");

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
// text-to-speech responses carry no cost, so it's estimated from the text (~15 characters per second of speech)
const TTS_PER_SEC = { "hexgrad/kokoro-82m": 0.00003, "elevenlabs/eleven-turbo-v2.5": 0.0005, "elevenlabs/eleven-v3": 0.001 };

// totals by feature and by day for a list of ledger rows
function summarise(rows) {
  const by = {}, days = {};
  for (const r of rows) {
    (by[r.feature] ||= { feature: r.feature, cost: 0, count: 0 }).cost += r.cost;
    by[r.feature].count++;
    const d = new Date(r.t).toISOString().slice(0, 10);
    days[d] = (days[d] || 0) + r.cost;
  }
  return {
    total: +rows.reduce((a, r) => a + r.cost, 0).toFixed(6),
    byFeature: Object.values(by).map((x) => ({ ...x, cost: +x.cost.toFixed(6) })).sort((a, b) => b.cost - a.cost),
    byDay: Object.entries(days).sort().map(([day, cost]) => ({ day, cost: +cost.toFixed(6) })),
    since: rows[0]?.t || null,
  };
}

function createSpend({ DATA, API, getKey, getCap }) {
  const file = (m) => path.join(DATA, `spend-${m}.json`);
  const read = (m) => { try { return JSON.parse(fs.readFileSync(file(m), "utf8")); } catch { return []; } };
  function log(feature, cost, model, id) {
    cost = Number(cost);
    if (!(cost > 0)) return;
    try {
      const m = monthKey(), all = read(m);
      if (id && all.some((r) => r.id === id)) return; // e.g. a finished video polled again after a restart
      all.push({ t: Date.now(), feature, model: model || null, cost: +cost.toFixed(6), ...(id ? { id } : {}) });
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(file(m), JSON.stringify(all));
    } catch (e) { console.error("spend log failed:", e.message); }
  }
  let cache = null;
  async function openrouter(force) {
    if (!force && cache && Date.now() - cache.t < 60000) return cache.v;
    const h = { Authorization: `Bearer ${getKey()}` };
    const get = (p) => fetch(`${API}${p}`, { headers: h, signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [k, c] = await Promise.all([get("/key"), get("/credits")]);
    const d = k?.data || {};
    const v = {
      month: d.usage_monthly ?? null, week: d.usage_weekly ?? null, day: d.usage_daily ?? null,
      keyLimit: d.limit ?? null, keyRemaining: d.limit_remaining ?? null, keyReset: d.limit_reset ?? null,
      balance: c?.data ? +(c.data.total_credits - c.data.total_usage).toFixed(4) : null,
    };
    if (k) cache = { t: Date.now(), v };
    return v;
  }
  // This month so far: OpenRouter's figure when reachable (it includes spend from anywhere), else the local log.
  async function monthTotal() {
    const or = getKey() ? await openrouter() : null;
    const local = summarise(read(monthKey())).total;
    return Math.max(or?.month ?? 0, local);
  }
  // null when allowed, else a message saying why not
  async function capBlock() {
    const cap = Number(getCap()) || 0;
    if (!cap) return null;
    const used = await monthTotal();
    if (used < cap) return null;
    return `Monthly spending cap reached: $${used.toFixed(2)} of $${cap.toFixed(2)} used this month. Raise the cap in Settings to keep going.`;
  }
  return { log, read, openrouter, monthTotal, capBlock, summarise, monthKey };
}

module.exports = { createSpend, summarise, monthKey, TTS_PER_SEC };
