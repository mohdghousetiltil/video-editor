// Spend tracker + monthly cap + daily / weekly video limits. Every AI call's cost goes into data/spend-YYYY-MM.json (one file per calendar month,
// UTC). OpenRouter's own monthly figure (GET /key) stays the authoritative total and is what the cap checks.
const fs = require("fs");
const path = require("path");

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
// "today" and "this week" follow the user's time zone, not UTC: a day is YYYY-MM-DD there, a week starts on Monday
const localDay = (t, tz) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(0, 10); } };
function weekStart(t, tz) {
  let wd = "Mon"; try { wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(t)); } catch {}
  const idx = Math.max(0, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd));
  const [y, m, d] = localDay(t, tz).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - idx)).toISOString().slice(0, 10);
}
// a ledger row for a finished video (new rows say kind:"video"; older ones are the rows with a job id that are not Shorts)
const isVideoRow = (r) => r.kind === "video" || (!!r.id && !/^short-/.test(r.id));
// text-to-speech responses carry no cost, so it's estimated from the text (~15 characters per second of speech)
const TTS_PER_SEC = { "hexgrad/kokoro-82m": 0.00003, "elevenlabs/eleven-turbo-v2.5": 0.0005, "elevenlabs/eleven-v3": 0.001 };

// totals by feature and by day for a list of ledger rows
function summarise(rows) {
  const by = {}, days = {}, prov = {};
  for (const r of rows) {
    prov[r.provider || "openrouter"] = (prov[r.provider || "openrouter"] || 0) + r.cost;
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
    byProvider: Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, +v.toFixed(6)])),
  };
}

function createSpend({ DATA, API, getKey, getCap, getLimits = () => ({}), getPending = () => 0 }) {
  const file = (m) => path.join(DATA, `spend-${m}.json`);
  const read = (m) => { try { return JSON.parse(fs.readFileSync(file(m), "utf8")); } catch { return []; } };
  // provider: "openrouter" (default), "fal" or "byteplus" — the cap and the tracker count them separately
  function log(feature, cost, model, id, provider, kind) {
    cost = Number(cost);
    if (!(cost > 0)) return;
    try {
      const m = monthKey(), all = read(m);
      if (id && all.some((r) => r.id === id)) return; // e.g. a finished video polled again after a restart
      all.push({ t: Date.now(), feature, model: model || null, cost: +cost.toFixed(6), ...(id ? { id } : {}), ...(provider && provider !== "openrouter" ? { provider } : {}), ...(kind ? { kind } : {}) });
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
    const rows = read(monthKey()), ext = rows.filter((r) => r.provider), own = rows.filter((r) => !r.provider);
    // OpenRouter's own figure (or the log, whichever is higher) + what other providers (fal.ai) charged
    return Math.max(or?.month ?? 0, summarise(own).total) + summarise(ext).total;
  }
  // null when allowed, else a message saying why not
  async function capBlock() {
    const cap = Number(getCap()) || 0;
    if (!cap) return null;
    const used = await monthTotal();
    if (used < cap) return null;
    return `Monthly spending cap reached: $${used.toFixed(2)} of $${cap.toFixed(2)} used this month. Raise the cap in Settings to keep going.`;
  }
  // Video spend today and this week (user's time zone), plus videos still being made (their estimated price)
  function limits(now = Date.now()) {
    const L = getLimits() || {}, tz = L.tz || "Australia/Sydney";
    const months = [...new Set([monthKey(new Date(now)), monthKey(new Date(now - 8 * 864e5))])];
    const rows = months.flatMap((m) => read(m)).filter(isVideoRow);
    const today = localDay(now, tz), ws = weekStart(now, tz);
    let day = 0, week = 0;
    for (const r of rows) { const d = localDay(r.t, tz); if (d === today) day += r.cost; if (d >= ws) week += r.cost; }
    return { tz, dailyCap: Number(L.dailyCap) || 0, weeklyCap: Number(L.weeklyCap) || 0, today: +day.toFixed(4), week: +week.toFixed(4), pending: +Math.max(0, Number(getPending()) || 0).toFixed(4), weekStart: ws };
  }
  // null when this video may start, else a message saying why not. estimate = what it should cost; extra = videos being
  // submitted right now that are not in the pending count yet.
  function videoBlock(estimate = 0, extra = 0, now = Date.now()) {
    const u = limits(now), e = Math.max(0, Number(estimate) || 0), pend = u.pending + Math.max(0, Number(extra) || 0), eps = 0.005;
    const city = u.tz.split("/").pop().replace(/_/g, " "), $ = (n) => "$" + n.toFixed(2);
    const check = (cap, used, Name, name, when, resets) => {
      if (!(cap > 0)) return null;
      if (e > cap + eps) return `This video costs about ${$(e)}, more than the whole ${name} video limit of ${$(cap)}. Pick a cheaper model or a shorter clip, or raise the limit in Settings.`;
      if (used + pend + e > cap + eps || used + pend >= cap - eps)
        return `${Name} video limit reached: ${$(used)} of ${$(cap)} used ${when}${pend > 0.005 ? ` (plus about ${$(pend)} for videos still being made)` : ""}. This one costs about ${$(e)}. ${resets} You can change the limit in Settings.`;
      return null;
    };
    return check(u.dailyCap, u.today, "Daily", "daily", "today", `It resets at midnight (${city} time).`) ||
      check(u.weeklyCap, u.week, "Weekly", "weekly", "this week", `It resets on Monday (${city} time).`);
  }
  return { log, read, openrouter, monthTotal, capBlock, summarise, monthKey, limits, videoBlock };
}

module.exports = { createSpend, summarise, monthKey, TTS_PER_SEC, localDay, weekStart };
