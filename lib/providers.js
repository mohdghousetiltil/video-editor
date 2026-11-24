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
  // fal's Kling 3 Pro: a flat $0.14 per second (fal pricing API, Nov 2026); OpenRouter no longer lists Kling
  "kwaivgi/kling-v3.0-pro": [{ provider: "fal", app: () => env("FAL_KLING_APP", "fal-ai/kling-video/v3/pro/text-to-video"), appI2V: () => env("FAL_KLING_I2V_APP", "fal-ai/kling-video/v3/pro/image-to-video"), factor: () => Number(env("FAL_KLING_FACTOR", 1)), price: () => Number(env("FAL_KLING_PRICE", 0.14)) }],
  "kwaivgi/kling-v3.0-turbo": [{ provider: "fal", app: () => env("FAL_KLING_TURBO_APP", "fal-ai/kling-video/v3/turbo/standard/text-to-video"), appI2V: () => env("FAL_KLING_TURBO_I2V_APP", "fal-ai/kling-video/v3/turbo/standard/image-to-video"), factor: () => 1, price: () => Number(env("FAL_KLING_TURBO_PRICE", 0.112)) }],
  "bytedance/seedance-2.0-fast": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_FAST_MODEL", "dreamina-seedance-2-0-fast-260128"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
  "bytedance/seedance-2.0": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_MODEL", "dreamina-seedance-2-0-260128"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
  "bytedance/seedance-2.0-mini": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_MINI_MODEL", "dreamina-seedance-2-0-mini-260615"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
  "bytedance/seedance-2.5": [{ provider: "byteplus", model: () => env("BYTEPLUS_SEEDANCE_25_MODEL", "dreamina-seedance-2-5-260628"), factor: () => Number(env("BYTEPLUS_FACTOR", 0.5)) }],
};
const keyFor = (p) => (p === "fal" ? env("FAL_KEY", "") : p === "byteplus" ? env("BYTEPLUS_KEY", "") : "");
const BP_BASE = () => env("BYTEPLUS_BASE", "https://ark.ap-southeast.bytepluses.com/api/v3");

// cheapest route with a key: { provider: "openrouter" } unless a cheaper one is configured.
// orAvailable=false (model not on OpenRouter's live list) forces another route when one exists.
// orPerSec: what OpenRouter charges per second for this exact request (resolution, sound on or off). With it, every route is compared
// in dollars per second (a route with a flat price against OpenRouter's real price), so a flat fal.ai price is used only when it is
// really cheaper. orLow: OpenRouter's credit is nearly used up, so another provider is preferred whenever one has the model.
function pickRoute(model, { orAvailable = true, orPerSec = null, orLow = false } = {}) {
  const extra = (ROUTES[model] || []).filter((r) => keyFor(r.provider));
  const or = { provider: "openrouter", factor: 1 };
  if (!extra.length) return or;
  const dollars = orPerSec != null && orPerSec > 0;
  const key = (r) => (dollars ? (r.price ? r.price() : orPerSec * r.factor()) : r.factor());
  const best = extra.reduce((a, b) => (key(b) < key(a) ? b : a));
  const cheaper = dollars ? key(best) < orPerSec * 0.999 : best.factor() < 1;
  return cheaper || !orAvailable || orLow ? { ...best, factor: best.factor(), price: best.price ? best.price() : null } : or;
}
// which providers are configured (for the Settings page)
const configured = () => ({ fal: !!keyFor("fal"), byteplus: !!keyFor("byteplus") });

// body: the OpenRouter-shaped request (prompt, duration, resolution, aspect_ratio, generate_audio, frame_images)
// opts.negative: things to avoid, sent as the model's own negative prompt where the provider has one (fal Kling)
async function submit(route, body, fetchFn = fetch, opts = {}) {
  const first = (body.frame_images || []).find((f) => f.frame_type === "first_frame");
  const last = (body.frame_images || []).find((f) => f.frame_type === "last_frame");
  if (route.provider === "fal") {
    const app = first ? route.appI2V() : route.app();
    const input = { prompt: body.prompt, duration: String(body.duration || 5), aspect_ratio: body.aspect_ratio || "9:16" };
    if (typeof body.generate_audio === "boolean") input.generate_audio = body.generate_audio;
    if (first) input.start_image_url = first.image_url.url; // Kling 3 field names (fal OpenAPI schema)
    if (last) input.end_image_url = last.image_url.url;
    if (opts.negative) input.negative_prompt = String(opts.negative).slice(0, 2000);
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

// put a file on fal.ai's own storage and get a link its models can download (they cannot read inline data URIs for videos)
async function falUpload(buf, contentType, fileName, fetchFn = fetch) {
  const r = await fetchFn("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", { method: "POST", headers: { Authorization: `Key ${keyFor("fal")}`, "Content-Type": "application/json" }, body: JSON.stringify({ content_type: contentType, file_name: fileName }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.upload_url || !j.file_url) throw Object.assign(new Error(j.detail || j.error || `fal.ai storage error ${r.status}`), { status: r.status });
  const p = await fetchFn(j.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: buf });
  if (!p.ok) throw Object.assign(new Error(`fal.ai upload failed (${p.status})`), { status: p.status });
  return j.file_url;
}

// any fal.ai app (video-to-video tools such as face swap): queue it and hand back a job that poll() understands
async function submitFalApp(app, input, fetchFn = fetch) {
  const r = await fetchFn(`https://queue.fal.run/${app}`, { method: "POST", headers: { Authorization: `Key ${keyFor("fal")}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.detail?.[0]?.msg || j.detail || j.error || `fal.ai error ${r.status}`), { status: r.status });
  return { id: "fal_" + j.request_id, job: { provider: "fal", status_url: j.status_url, response_url: j.response_url } };
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
      // fal checks the input after queueing: a rejected job comes back as COMPLETED with { detail: [{ msg, loc }] }
      const d = Array.isArray(o.detail) ? o.detail.map((x) => [x.loc && x.loc.slice(-1)[0], x.msg].filter(Boolean).join(": ")).join("; ") : o.detail;
      const why = /mask/i.test(d || "") ? " (the model could not find one clear, fully visible person to swap: try a clip where the face and body are not covered, for example not holding a phone in front)"
        : /content checker|safety/i.test(d || "") ? " (the provider's safety check blocked this swap; it often blocks realistic faces swapped onto real-looking people)" : "";
      return { status: "failed", error: "fal.ai rejected the job: " + (d || "no video came back") + why };
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

module.exports = { ROUTES, pickRoute, submit, submitFalApp, falUpload, poll, configured, isExternal };
