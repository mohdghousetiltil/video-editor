// One table for every video model the app offers: allowed lengths, resolutions, aspect ratios, sound, tier and notes.
// Static values here are the fallback; when OpenRouter's live model list is reachable its capabilities and prices
// win (lengths, resolutions, aspect ratios, first/last frame support), so pages never offer a length the model
// rejects. Served to every page at GET /api/models.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// tier: draft (cheap tests), regular (everyday Shorts / Reels), hero (the one shot that has to look great)
// audio: true = sound optional, "always" = sound always on (Audio switch hidden), false = silent model
// typical: usual seconds from submit to done, shown instead of a fake countdown
const VIDEO = {
  "x-ai/grok-imagine-video-1.5-lite": { name: "Grok Imagine 1.5 Lite", tier: "draft", audio: false, durs: range(1, 15), res: ["480p", "720p", "1080p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.02, 0.02], "720p": [0.03, 0.03] }, typical: [15, 45], frames: ["first_frame"] },
  "google/veo-3.1-lite": { name: "Google Veo 3.1 Lite", tier: "draft", audio: true, durs: [4, 6, 8], res: ["720p", "1080p"], asp: ["9:16", "16:9"], price: { "720p": [0.05, 0.03], "1080p": [0.08, 0.05] }, typical: [30, 90], frames: ["first_frame", "last_frame"] },
  "x-ai/grok-imagine-video": { name: "Grok Imagine", tier: "draft", audio: false, durs: range(1, 15), res: ["480p", "720p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.05, 0.05], "720p": [0.07, 0.07] }, typical: [15, 45], frames: ["first_frame"] },
  "bytedance/seedance-2.0-mini": { name: "Seedance 2.0 Mini", tier: "regular", audio: true, durs: range(4, 15), res: ["480p", "720p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.0336, 0.0336], "720p": [0.0756, 0.0756] }, typical: [30, 90], frames: ["first_frame", "last_frame"] },
  "bytedance/seedance-2.0-fast": { name: "Seedance 2.0 Fast", tier: "regular", audio: true, durs: range(4, 15), res: ["480p", "720p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.0538, 0.0538], "720p": [0.121, 0.121] }, typical: [30, 90], frames: ["first_frame", "last_frame"] },
  "alibaba/wan-3.0": { name: "Wan 3.0", tier: "regular", audio: true, durs: range(2, 30), res: ["480p", "720p", "1080p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.05, 0.05], "720p": [0.1, 0.1], "1080p": [0.2, 0.2] }, typical: [40, 120], frames: ["first_frame", "last_frame"] },
  "heygen/heygen-video-1": { name: "HeyGen Video", tier: "draft", audio: false, durs: range(5, 30), res: ["480p", "1080p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.02, 0.02], "1080p": [0.1, 0.1] }, typical: [30, 120], frames: ["first_frame"], note: "Talking heads" },
  "google/gemini-omni-1.2-flash": { name: "Gemini Omni 1.2 Flash", tier: "regular", audio: "always", durs: range(3, 15), res: ["720p", "1080p"], asp: ["9:16", "16:9"], price: { "720p": [0.0695, 0.0695], "1080p": [0.1043, 0.1043] }, typical: [30, 90], frames: ["first_frame", "last_frame"] },
  "google/veo-3.1-fast": { name: "Google Veo 3.1 Fast", tier: "hero", audio: true, durs: [4, 6, 8], res: ["720p", "1080p"], asp: ["9:16", "16:9"], price: { "720p": [0.1, 0.08], "1080p": [0.12, 0.1] }, typical: [30, 90], frames: ["first_frame", "last_frame"] },
  "kwaivgi/kling-v3.0-pro": { name: "Kling 3.0 Pro", tier: "hero", audio: true, durs: range(3, 15), res: ["720p"], asp: ["9:16", "16:9", "1:1"], price: { "720p": [0.168, 0.112] }, typical: [60, 180], frames: ["first_frame", "last_frame"] },
  "bytedance/seedance-2.0": { name: "Seedance 2.0", tier: "hero", audio: true, durs: range(4, 15), res: ["480p", "720p", "1080p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.0673, 0.0673], "720p": [0.1512, 0.1512], "1080p": [0.3402, 0.3402] }, typical: [40, 120], frames: ["first_frame", "last_frame"] },
  "bytedance/seedance-2.5": { name: "Seedance 2.5", tier: "hero", audio: true, durs: range(4, 30), res: ["480p", "720p", "1080p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.1028, 0.1028], "720p": [0.2311, 0.2311] }, typical: [40, 150], frames: ["first_frame", "last_frame"] },
  "x-ai/grok-imagine-video-1.5": { name: "Grok Imagine 1.5", tier: "regular", audio: false, durs: range(1, 15), res: ["480p", "720p", "1080p"], asp: ["9:16", "16:9", "1:1"], price: { "480p": [0.08, 0.08], "720p": [0.14, 0.14] }, typical: [15, 60], frames: ["first_frame"] },
  "black-forest-labs/flux-video-edit": { name: "FLUX Video Edit", tier: "regular", audio: false, bare: true, durs: [], res: [], asp: [], price: {}, typical: [30, 120], hidden: true },
};
// The model each page starts on (cheap enough for everyday Shorts; 720p is plenty on a phone screen)
const DEFAULT_MODEL = "google/veo-3.1-lite";
const DIMS = ["360p", "480p", "720p", "1080p"];

// merge the static table with OpenRouter's live list (from GET /videos/models) and the live price table
function merge(live, priceTable) {
  const byId = new Map((live || []).map((m) => [m.id, m]));
  const out = {};
  for (const [id, base] of Object.entries(VIDEO)) {
    const m = { ...base, id, price: { ...base.price } };
    const l = byId.get(id);
    if (l) {
      const durs = (l.supported_durations || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
      if (durs.length) m.durs = durs;
      const res = (l.supported_resolutions || []).filter((r) => DIMS.includes(r));
      if (res.length) m.res = res.filter((r) => r !== "360p");
      const asp = (l.supported_aspect_ratios || []).filter((a) => ["9:16", "16:9", "1:1"].includes(a));
      if (asp.length) m.asp = ["9:16", "16:9", "1:1"].filter((a) => asp.includes(a));
      if (Array.isArray(l.supported_frame_images)) m.frames = l.supported_frame_images;
    }
    const p = priceTable && priceTable[id];
    if (p) for (const r of m.res) if (p[r] != null) m.price[r] = [(p.audio && p.audio[r]) ?? p[r], p[r]];
    m.res = m.res.filter((r) => m.price[r] || !Object.keys(m.price).length);
    m.live = live ? byId.has(id) : null; // null = the live list couldn't be fetched, so we don't know
    out[id] = m;
  }
  return out;
}

// the length used when the user leaves Duration on Auto: short clips drift less (faces, hands), so the shortest
// allowed length of at least 4 s, else the shortest allowed
const defaultDur = (m) => (m.durs.find((d) => d >= 4) ?? m.durs[0] ?? 0);

// a requested length the model accepts, or null
function allowedDuration(m, d) {
  d = Math.round(Number(d));
  if (!m || !m.durs || !m.durs.length) return d > 0 ? d : null;
  return m.durs.includes(d) ? d : null;
}

// notes shown under the settings when a model is picked (item: announce per-model differences)
function notes(m) {
  const n = [];
  if (m.res.length === 1) n.push(`${m.name}: ${m.res[0]} only`);
  if (m.asp.includes("1:1")) n.push("1:1 available");
  if (m.audio === "always") n.push("sound is always on");
  else if (m.audio === false) n.push("no sound (silent model)");
  else if (m.res.every((r) => m.price[r] && m.price[r][0] === m.price[r][1])) n.push("Audio Off doesn't change the price for this model");
  if (m.durs.length && m.durs.length < 6) n.push(`lengths: ${m.durs.join(" / ")} s`);
  else if (m.durs.length) n.push(`lengths: ${m.durs[0]}–${m.durs[m.durs.length - 1]} s`);
  if (m.res.includes("1080p")) n.push("1080p is for hero YouTube shots; 720p looks the same on phones");
  return n;
}

module.exports = { VIDEO, DEFAULT_MODEL, merge, defaultDur, allowedDuration, notes };
