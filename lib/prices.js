// Live video prices from OpenRouter's model list, turned into "dollars per second" at 480p / 720p / 1080p so the
// pages show real prices instead of numbers typed in months ago. Cached for 6 hours.
// Shape: { "model/id": { "480p": silent $/s, "720p": …, audio: { "480p": $/s with sound, … } } }
// OpenRouter prices video in several shapes: dollars per second ("duration_seconds_720p"), cents per second
// ("cents_per_video_output_second_480p", "cents_per_second_output") or per video token ("video_tokens", where one
// second at W x H and 24 fps is W*H*24/1024 tokens).
const DIMS = { "360p": [640, 360], "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] };

function perSecond(skus, res, withAudio = false) {
  if (!skus) return null;
  const n = (k) => (skus[k] != null && isFinite(+skus[k]) ? +skus[k] : null);
  const r = res;
  // dollars per second; prefer the silent price (clips are made without audio when stitched)
  const order = withAudio ? [`duration_seconds_with_audio_${r}`, `duration_seconds_${r}`, `duration_seconds_without_audio_${r}`] : [`duration_seconds_without_audio_${r}`, `duration_seconds_${r}`, `duration_seconds_with_audio_${r}`];
  for (const k of order) if (n(k) != null) return n(k);
  for (const k of [`cents_per_video_output_second_${r}`, `cents_per_second_output_${r}`]) if (n(k) != null) return n(k) / 100;
  const tok = withAudio ? n("video_tokens") ?? n("video_tokens_without_audio") : n("video_tokens_without_audio") ?? n("video_tokens");
  if (tok != null && DIMS[r]) { const [w, h] = DIMS[r]; return +((w * h * 24) / 1024 * tok).toFixed(4); }
  // resolution-less prices apply to every resolution the model has
  for (const k of withAudio ? ["duration_seconds_with_audio", "duration_seconds", "duration_seconds_without_audio"] : ["duration_seconds_without_audio", "duration_seconds", "duration_seconds_with_audio"]) if (n(k) != null) return n(k);
  if (n("cents_per_second_output") != null) return n("cents_per_second_output") / 100;
  return null;
}

function toTable(models) {
  const out = {};
  for (const m of models || []) {
    const row = {}, offered = Array.isArray(m.supported_resolutions) && m.supported_resolutions.length ? m.supported_resolutions : Object.keys(DIMS);
    for (const r of Object.keys(DIMS)) { if (!offered.includes(r)) continue; const p = perSecond(m.pricing_skus, r); if (p != null) { row[r] = p; (row.audio ||= {})[r] = perSecond(m.pricing_skus, r, true); } }
    if (Object.keys(row).length) out[m.id] = row;
  }
  return out;
}

function createPrices({ API, getKey }) {
  let cache = null;
  return async function prices() {
    if (cache && Date.now() - cache.t < 6 * 3600000) return cache.v;
    const r = await fetch(`${API}/videos/models`, { headers: { Authorization: `Bearer ${getKey()}` }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (!j) return cache?.v || {};
    cache = { t: Date.now(), v: toTable(j.data) };
    return cache.v;
  };
}

module.exports = { createPrices, perSecond, toTable };
