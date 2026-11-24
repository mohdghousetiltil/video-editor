// History of everything the app made: clips, Story videos, Shorts, influencer pictures. One record per generation,
// kept in data/history.json so the History page can list, search, retry and delete across features and devices.
// Record: { id, kind, title, model, duration, res, cost, status, url, thumb, retry: { endpoint, body }, t, rating? }
const path = require("path");
const { persistentMap } = require("./store");

const KINDS = ["clip", "story", "short", "influencer", "ugc", "motion", "scene", "swap"];

function createHistory(DATA) {
  const m = persistentMap(path.join(DATA, "history.json"), { max: 1000 });
  // add or update (fields merge into an existing record with the same id)
  function put(id, rec) {
    if (!id) return null;
    const old = m.get(id) || { id, t: Date.now(), status: "pending" };
    const next = { ...old, ...Object.fromEntries(Object.entries(rec || {}).filter(([, v]) => v !== undefined)) };
    if (next.title) next.title = String(next.title).slice(0, 140);
    if (next.cost != null) next.cost = +Number(next.cost).toFixed(4);
    m.set(id, next);
    return next;
  }
  const get = (id) => m.get(id) || null;
  const del = (id) => m.delete(id);
  // newest first; q matches title / model / kind, kind filters, from/to are ms timestamps
  function list({ q, kind, from, to, status, limit = 200 } = {}) {
    const needle = String(q || "").trim().toLowerCase();
    return [...m.values()]
      .filter((r) => !kind || r.kind === kind)
      .filter((r) => !status || (status === "running" ? r.status === "pending" || r.status === "in_progress" || r.status === "running" : r.status === status))
      .filter((r) => !from || r.t >= from)
      .filter((r) => !to || r.t <= to)
      .filter((r) => !needle || [r.title, r.model, r.kind, r.id].some((x) => String(x || "").toLowerCase().includes(needle)))
      .sort((a, b) => b.t - a.t)
      .slice(0, Math.max(1, Math.min(1000, limit)));
  }
  return { put, get, del, list, flush: m.flush, KINDS };
}

module.exports = { createHistory, KINDS };
