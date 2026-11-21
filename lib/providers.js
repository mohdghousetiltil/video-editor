// Video providers besides OpenRouter. Each route is only used when its key is set in the environment:
//   FAL_KEY       fal.ai, for Kling (usually about half OpenRouter's price)
//   BYTEPLUS_KEY  BytePlus ModelArk, for Seedance (usually about half fal.ai's price)
// pickRoute() chooses the cheapest provider that has a key for the chosen model. Provider job ids carry a prefix
// ("fal_", "bp_") so polling and downloading know where to go; OpenRouter ids stay as they are.
// Prices for these routes are estimates (env overridable) because neither provider reports cost per call the same
// way OpenRouter does; the app log marks them as estimates.

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);

// model -> extra routes. factor = price relative to OpenRouter's (or `price` $/s when OpenRouter doesn't list it)
const ROUTES = {
  "kwaivgi/kling-v3.0-pro": [{ provider: "fal", app: () => env("FAL_KLING_APP", "fal-ai/kling-video/v3/pro/text-to-video"), appI2V: () => env("FAL_KLING_I2V_APP", "fal-ai/kling-video/v3/pro/image-to-video"), factor: () => Number(env("FAL_KLING_FACTOR", 0.5)) }],
  "bytedance/seedance-2.0-fast": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_FAST_MODEL", "seedance-2-0-fast"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
  "bytedance/seedance-2.0": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_MODEL", "seedance-2-0"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
  "bytedance/seedance-2.0-mini": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_MINI_MODEL", "seedance-2-0-mini"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
};
const keyFor = (p) => (p === "fal" ? env("FAL_KEY", "") : p === "byteplus" ? env("BYTEPLUS_KEY", "") : "");
const BP_BASE = () => env("BYTEPLUS_BASE", "https://ark.ap-southeast.bytepluses.com/api/v3");

// cheapest route with a key: { provider: "openrouter" } unless a cheaper one is configured.
// orAvailable=false (model not on OpenRouter's live list) forces another route when one exists.
function pickRoute(model, { orAvailable = true } = {}) {
  const extra = (ROUTES[model] || []).filter((r) => keyFor(r.provider));
  if (!extra.length) return { provider: "openrouter", factor: 1 };
  const best = extra.reduce((a, b) => (b.factor() < a.factor() ? b : a));
  return best.factor() < 1 || !orAvailable ? { ...best, factor: best.factor() } : { provider: "openrouter", factor: 1 };
}
// which providers are configured (for the Settings page)
const configured = () => ({ fal: !!keyFor("fal"), byteplus: !!keyFor("byteplus") });

// body: the OpenRouter-shaped request (prompt, duration, resolution, aspect_ratio, generate_audio, frame_images)
async function submit(route, body, fetchFn = fetch) {
  const first = (body.frame_images || []).find((f) => f.frame_type === "first_frame");
  const last = (body.frame_images || []).find((f) => f.frame_type === "last_frame");
  if (route.provider === "fal") {
    const app = first ? route.appI2V() : route.app();
    const input = { prompt: body.prompt, duration: String(body.duration || 5), aspect_ratio: body.aspect_ratio || "9:16" };
    if (typeof body.generate_audio === "boolean") input.generate_audio = body.generate_audio;
    if (first) input.image_url = first.image_url.url;
    if (last) input.tail_image_url = last.image_url.url;
    const r = await fetchFn(`https://queue.fal.run/${app}`, { method: "POST", headers: { Authorization: `Key ${keyFor("fal")}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.detail?.[0]?.msg || j.detail || j.error || `fal.ai error ${r.status}`), { status: r.status });
    return { id: "fal_" + j.request_id, job: { provider: "fal", status_url: j.status_url, response_url: j.response_url } };
  }
  if (route.provider === "byteplus") {
    const flags = [body.resolution && `--rs ${body.resolution}`, body.aspect_ratio && `--rt ${body.aspect_ratio}`, body.duration && `--dur ${body.duration}`, Number.isInteger(body.seed) && `--seed ${body.seed}`].filter(Boolean).join(" ");
    const content = [{ type: "text", text: `${body.prompt} ${flags}`.trim() }];
    if (first) content.push({ type: "image_url", image_url: { url: first.image_url.url }, role: "first_frame" });
    if (last) content.push({ type: "image_url", image_url: { url: last.image_url.url }, role: "last_frame" });
    const req = { model: route.model(), content };
    if (typeof body.generate_audio === "boolean") req.generate_audio = body.generate_audio;
    const r = await fetchFn(`${BP_BASE()}/contents/generations/tasks`, { method: "POST", headers: { Authorization: `Bearer ${keyFor("byteplus")}`, "Content-Type": "application/json" }, body: JSON.stringify(req) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error?.message || `BytePlus error ${r.status}`), { status: r.status });
    return { id: "bp_" + j.id, job: { provider: "byteplus" } };
  }
  throw new Error("Unknown provider " + route.provider);
}

// -> { status: pending|in_progress|completed|failed, error?, videoUrl? } in OpenRouter's vocabulary
async function poll(id, job, fetchFn = fetch) {
  if (job.provider === "fal") {
    const r = await fetchFn(job.status_url, { headers: { Authorization: `Key ${keyFor("fal")}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.detail || `fal.ai poll failed (${r.status})`), { status: r.status });
    if (j.status === "COMPLETED") {
      const o = await fetchFn(job.response_url, { headers: { Authorization: `Key ${keyFor("fal")}` } }).then((x) => x.json()).catch(() => ({}));
      if (o.video?.url) return { status: "completed", videoUrl: o.video.url };
      return { status: "failed", error: o.detail || "fal.ai returned no video" };
    }
    return { status: j.status === "IN_PROGRESS" ? "in_progress" : "pending" };
  }
  if (job.provider === "byteplus") {
    const r = await fetchFn(`${BP_BASE()}/contents/generations/tasks/${id.replace(/^bp_/, "")}`, { headers: { Authorization: `Bearer ${keyFor("byteplus")}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error?.message || `BytePlus poll failed (${r.status})`), { status: r.status });
    if (j.status === "succeeded") return { status: "completed", videoUrl: j.content?.video_url };
    if (j.status === "failed" || j.status === "cancelled") return { status: "failed", error: j.error?.message || "BytePlus generation failed" };
    return { status: j.status === "running" ? "in_progress" : "pending" };
  }
  throw new Error("Unknown provider");
}

const isExternal = (id) => /^(fal|bp)_/.test(id);

module.exports = { ROUTES, pickRoute, submit, poll, configured, isExternal };
