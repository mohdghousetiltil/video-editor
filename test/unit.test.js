// Unit tests for the pure parts: run with `node --test` (Node 18+, nothing to install).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { cleanSegments, toSec, parseTime } = require("../lib/cut");
const { glitchFilter } = require("../glitch");
const { perSecond, toTable } = require("../lib/prices");
const { summarise } = require("../lib/spend");
const { createLimiter } = require("../lib/queue");
const { orFetch } = require("../lib/openrouter");
const { sweep } = require("../lib/cleanup");
const createSettings = require("../lib/settings");

const total = (segs) => segs.reduce((a, s) => a + s.end - s.start, 0);

test("times: seconds, m:ss and h:mm:ss", () => {
  assert.equal(toSec(12.5), 12.5);
  assert.equal(toSec("1:02:03"), 3723);
  assert.equal(toSec("00:12:30.500"), 750.5);
  assert.ok(Number.isNaN(toSec("abc")));
  assert.equal(parseTime("12:30"), 750);
  assert.equal(parseTime("95"), 95);
  assert.equal(parseTime(""), null);
  assert.equal(parseTime("12m"), null);
});

test("edit: pieces are ordered, merged, clamped and fit the length", () => {
  const segs = cleanSegments({ segments: [{ start: 50, end: 60 }, { start: 10, end: 22 }, { start: 59, end: 65 }] }, 0, 1000, 15, 30);
  assert.deepEqual(segs, [{ start: 10, end: 22 }, { start: 50, end: 65 }]);
  assert.ok(total(segs) >= 15 && total(segs) <= 30);
});

test("edit: too long is trimmed from the end, too short is grown", () => {
  const long = cleanSegments({ segments: [{ start: 0, end: 50 }] }, 0, 100, 15, 30);
  assert.equal(total(long), 30);
  const short = cleanSegments({ segments: [{ start: 40, end: 45 }] }, 0, 100, 15, 30);
  assert.equal(total(short), 15);
});

test("edit: stays inside the creator's time range", () => {
  const segs = cleanSegments({ segments: [{ start: 100, end: 140 }] }, 120, 200, 15, 30);
  assert.ok(segs[0].start >= 120, "starts inside the range");
  assert.ok(segs[segs.length - 1].end <= 200);
  // a range shorter than the minimum is used as it is
  assert.deepEqual(cleanSegments({ segments: [{ start: 0, end: 5 }] }, 300, 310, 15, 30), [{ start: 300, end: 310 }]);
});

test("edit: falls back to start/end when there are no pieces, and to clock strings", () => {
  const segs = cleanSegments({ start: "0:01:00", end: "0:01:20" }, 0, 600, 15, 30);
  assert.deepEqual(segs, [{ start: 60, end: 80 }]);
});

test("glitch filter: well-formed chain with bursts inside the video", () => {
  const f = glitchFilter("[0:v]", "[v]", 1080, 1920, 20, 3);
  assert.ok(f.startsWith("[0:v]") && f.endsWith("[v]"));
  const times = [...f.matchAll(/between\(t,([\d.]+),([\d.]+)\)/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(times.length >= 3, "several bursts");
  for (const [a, b] of times) assert.ok(a >= 0 && b <= 20 && b > a);
  assert.equal(glitchFilter("[0:v]", "[v]", 1080, 1920, 20, 3), f, "same seed, same glitches");
});

test("prices: per second, per cent and per token shapes", () => {
  assert.equal(perSecond({ duration_seconds_480p: "0.05" }, "480p"), 0.05);
  assert.equal(perSecond({ cents_per_video_output_second_480p: "2" }, "480p"), 0.02);
  assert.equal(perSecond({ duration_seconds_without_audio_720p: "0.08", duration_seconds_with_audio_720p: "0.1" }, "720p", true), 0.1);
  const tok = perSecond({ video_tokens: "0.0000035" }, "480p");
  assert.ok(tok > 0.03 && tok < 0.04, "Seedance Mini at 480p is ~$0.034/s, got " + tok);
  const t = toTable([{ id: "a/b", supported_resolutions: ["720p"], pricing_skus: { duration_seconds: "0.1" } }]);
  assert.deepEqual(Object.keys(t["a/b"]).filter((k) => k !== "audio"), ["720p"], "only offered resolutions");
});

test("spend: totals by feature and by day", () => {
  const day = Date.UTC(2026, 10, 3, 12);
  const s = summarise([{ t: day, feature: "Shorts", cost: 0.02 }, { t: day, feature: "Story", cost: 0.1 }, { t: day + 86400000, feature: "Shorts", cost: 0.01 }]);
  assert.equal(s.total, 0.13);
  assert.equal(s.byFeature[0].feature, "Story");
  assert.deepEqual(s.byFeature.find((f) => f.feature === "Shorts"), { feature: "Shorts", cost: 0.03, count: 2 });
  assert.equal(s.byDay.length, 2);
});

test("queue: never runs more than n at once, keeps order", async () => {
  const limit = createLimiter(2);
  let running = 0, peak = 0;
  const done = [];
  await Promise.all([1, 2, 3, 4, 5].map((i) => limit(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--; done.push(i);
  })));
  assert.equal(peak, 2);
  assert.equal(done.length, 5);
});

test("openrouter fetch: retries 429/5xx, but not a 5xx on paid calls", async () => {
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return new Response("x", { status: calls < 3 ? 503 : 200 }); };
  try {
    const r = await orFetch("http://x", {}, { wait: [1, 1] });
    assert.equal(r.status, 200); assert.equal(calls, 3);
    calls = 0;
    const r2 = await orFetch("http://x", {}, { safe: false, wait: [1, 1] });
    assert.equal(r2.status, 503); assert.equal(calls, 1, "paid call not repeated on 5xx");
    calls = 0;
    global.fetch = async () => { calls++; return new Response("x", { status: calls < 2 ? 429 : 200 }); };
    const r3 = await orFetch("http://x", {}, { safe: false, wait: [1, 1] });
    assert.equal(r3.status, 200, "429 is always safe to retry");
  } finally { global.fetch = real; }
});

test("settings: presets, validation and custom mix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-settings-"));
  const S = createSettings(dir);
  assert.equal(S.get().provider, "default");
  assert.equal(S.set({ provider: "muse" }).textModel, "meta/muse-ember");
  assert.equal(S.set({ textModel: "not/a-model" }).textModel, "meta/muse-ember", "unknown model ignored");
  assert.equal(S.set({ textModel: "google/gemini-3.5-flash-lite" }).provider, "custom");
  assert.equal(S.set({ monthlyCap: -5 }).monthlyCap, 0);
  assert.equal(createSettings(dir).get().textModel, "google/gemini-3.5-flash-lite", "saved to disk");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cleanup: removes only old matching entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-clean-"));
  const old = path.join(dir, "old.mp4"), fresh = path.join(dir, "new.mp4"), other = path.join(dir, "keep.txt");
  for (const f of [old, fresh, other]) fs.writeFileSync(f, "x");
  const past = (Date.now() - 20 * 86400000) / 1000;
  fs.utimesSync(old, past, past); fs.utimesSync(other, past, past);
  assert.equal(sweep(dir, 14, (n) => n.endsWith(".mp4")), 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(other));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- fix-list additions ----------
const modelsLib = require("../lib/models");
const { createHistory } = require("../lib/history");
const providers = require("../lib/providers");

test("models: live list wins, only allowed lengths pass, Auto picks a short length", () => {
  const live = [{ id: "google/veo-3.1-fast", supported_durations: [8, 4, 6], supported_resolutions: ["720p", "1080p", "4K"], supported_aspect_ratios: ["16:9", "9:16"], supported_frame_images: ["first_frame"] }];
  const m = modelsLib.merge(live, { "google/veo-3.1-fast": { "720p": 0.08, audio: { "720p": 0.1 } } });
  const veo = m["google/veo-3.1-fast"];
  assert.deepEqual(veo.durs, [4, 6, 8]);
  assert.deepEqual(veo.res, ["720p", "1080p"]);
  assert.deepEqual(veo.price["720p"], [0.1, 0.08]);
  assert.equal(veo.live, true);
  assert.equal(m["kwaivgi/kling-v3.0-pro"].live, false); // not on the live list
  assert.equal(modelsLib.allowedDuration(veo, 6), 6);
  assert.equal(modelsLib.allowedDuration(veo, 99), null);
  assert.equal(modelsLib.allowedDuration(veo, 5), null);
  assert.equal(modelsLib.defaultDur(veo), 4);
  assert.equal(modelsLib.defaultDur({ durs: [1, 2, 3, 4, 5] }), 4);
  const gem = modelsLib.merge(null, null)["google/gemini-omni-1.2-flash"];
  assert.equal(gem.live, null); // unknown when the list can't be fetched
  assert.ok(modelsLib.notes(gem).some((n) => /always on/.test(n)));
  const kl = modelsLib.merge(null, null)["kwaivgi/kling-v3.0-pro"];
  assert.ok(modelsLib.notes(kl).some((n) => /720p only/.test(n)) && modelsLib.notes(kl).includes("1:1 available"));
});

test("history: put merges, list filters and searches, delete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
  const h = createHistory(dir);
  h.put("a", { kind: "clip", title: "Surfer dog", model: "google/veo-3.1-lite", status: "pending", t: 1000 });
  h.put("b", { kind: "short", title: "Cat fail", status: "completed", cost: 0.0123456, t: 2000 });
  h.put("a", { status: "completed", cost: 0.2 });
  assert.equal(h.get("a").title, "Surfer dog");
  assert.equal(h.get("a").status, "completed");
  assert.equal(h.get("b").cost, 0.0123);
  assert.deepEqual(h.list().map((r) => r.id), ["b", "a"]);
  assert.deepEqual(h.list({ kind: "clip" }).map((r) => r.id), ["a"]);
  assert.deepEqual(h.list({ q: "veo" }).map((r) => r.id), ["a"]);
  assert.deepEqual(h.list({ from: 1500 }).map((r) => r.id), ["b"]);
  h.put("c", { kind: "story", status: "running" });
  assert.deepEqual(h.list({ status: "running" }).map((r) => r.id), ["c"]);
  h.del("a");
  assert.equal(h.get("a"), null);
});

test("providers: OpenRouter unless a cheaper keyed route exists; fal and BytePlus round trips", async () => {
  const save = { ...process.env };
  try {
    delete process.env.FAL_KEY; delete process.env.BYTEPLUS_KEY;
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro").provider, "openrouter");
    process.env.FAL_KEY = "k"; process.env.BYTEPLUS_KEY = "b";
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro").provider, "openrouter"); // same price: stay on OpenRouter
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orAvailable: false }).provider, "fal"); // OpenRouter dropped Kling
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orAvailable: false }).price, 0.14);
    assert.equal(providers.pickRoute("bytedance/seedance-2.0-fast").provider, "byteplus");
    assert.equal(providers.pickRoute("google/veo-3.1-lite").provider, "openrouter");
    process.env.FAL_KLING_FACTOR = "1.4"; // not cheaper than OpenRouter: only used when OpenRouter lacks the model
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro").provider, "openrouter");
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orAvailable: false }).provider, "fal");
    delete process.env.FAL_KLING_FACTOR;
    // compared in dollars per second: a flat fal.ai price is used only where it really is lower than OpenRouter's
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orPerSec: 0.168 }).provider, "fal");
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orPerSec: 0.112 }).provider, "openrouter", "silent Kling is cheaper on OpenRouter");
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orPerSec: 0.112, orLow: true }).provider, "fal", "OpenRouter credit nearly gone: use the other provider");
    assert.equal(providers.pickRoute("google/veo-3.1-lite", { orPerSec: 0.05, orLow: true }).provider, "openrouter", "no other route for this model");

    const calls = [];
    const fake = async (url, init = {}) => {
      calls.push([url, init.body ? JSON.parse(init.body) : null]);
      const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
      if (url.startsWith("https://queue.fal.run/") && init.method === "POST") return json({ request_id: "r1", status_url: "https://s/status", response_url: "https://s/res" });
      if (url === "https://s/status") return json({ status: "COMPLETED" });
      if (url === "https://s/res") return json({ video: { url: "https://cdn/v.mp4" } });
      if (url.endsWith("/contents/generations/tasks") && init.method === "POST") return json({ id: "t9" });
      if (url.endsWith("/contents/generations/tasks/t9")) return json({ status: "running" });
      return json({}, 404);
    };
    const f = await providers.submit(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orAvailable: false }), { prompt: "p", duration: 5, aspect_ratio: "9:16", frame_images: [{ frame_type: "first_frame", image_url: { url: "data:x" } }, { frame_type: "last_frame", image_url: { url: "data:y" } }] }, fake, { negative: "extra fingers" });
    assert.equal(calls[0][1].end_image_url, "data:y");
    assert.equal(calls[0][1].negative_prompt, "extra fingers");
    assert.equal(f.id, "fal_r1");
    assert.match(calls[0][0], /image-to-video/);
    assert.equal(calls[0][1].start_image_url, "data:x");
    assert.deepEqual(await providers.poll(f.id, f.job, fake), { status: "completed", videoUrl: "https://cdn/v.mp4" });
    const b = await providers.submit(providers.pickRoute("bytedance/seedance-2.0-fast"), { prompt: "p", duration: 4, resolution: "720p", aspect_ratio: "9:16" }, fake);
    assert.equal(b.id, "bp_t9");
    assert.match(calls.at(-1)[1].content[0].text, /--dur 4/);
    assert.deepEqual(await providers.poll(b.id, b.job, fake), { status: "in_progress" });
    assert.ok(providers.isExternal("fal_x") && !providers.isExternal("gen-vid-1"));
  } finally { process.env = save; }
});

test("settings: $10 default cap, old 'no cap' files get it, a chosen 0 stays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-"));
  assert.equal(createSettings(dir).get().monthlyCap, 10);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ monthlyCap: 0 }));
  assert.equal(createSettings(dir).get().monthlyCap, 10);
  const s = createSettings(dir);
  s.set({ monthlyCap: 0 });
  assert.equal(createSettings(dir).get().monthlyCap, 0);
  assert.equal(s.set({ confirmUnder: 99 }).confirmUnder, 5);
});

test("studio (page helper): total cost line with Auto, and money formatting", () => {
  const vm = require("vm");
  let units = "usd"; // dollars for the old assertions; credits (the default) are tested below
  const ctx = { window: {}, localStorage: { getItem: (k) => (k === "units" ? units : null), setItem() {} }, fetch: async () => ({ json: async () => ({}) }), document: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/studio.js"), "utf8"), ctx);
  const S = ctx.window.studio;
  const veo = { name: "Veo", audio: true, durs: [4, 6, 8], defaultDur: 4, res: ["720p"], price: { "720p": [0.1, 0.08] } };
  const auto = S.costLine(veo, { res: "720p", dur: "" });
  assert.equal(auto.total.toFixed(2), "0.40");
  assert.match(auto.text, /\$0\.40 for 4 s · Auto: 4 s default, may pick 4 \/ 6 \/ 8 s/);
  assert.equal(S.costLine(veo, { res: "720p", dur: 8, audio: false, n: 3 }).total.toFixed(2), "1.92");
  assert.equal(S.money(0.15000000596046448), "$0.15");
  assert.equal(S.money(0.003, 3), "$0.003");
  assert.equal(S.money(0.0001, 3), "<$0.001");
  units = "cr"; // credits when switched: 1 credit = $1
  assert.equal(S.money(0.4), "0.4 cr"); assert.equal(S.money(0.05), "0.05 cr"); assert.equal(S.money(0.0004), "<0.001 cr"); assert.equal(S.money(10), "10 cr"); assert.equal(S.money(1.5), "1.5 cr"); assert.equal(S.money(0.123), "0.123 cr"); assert.equal(S.money(0.035), "0.035 cr"); assert.equal(S.money(1234), "1,234 cr"); assert.equal(S.money(null), "—");
  assert.ok(S.validJobId("gen-vid-abc123def") && !S.validJobId("x") && !S.validJobId("a b c d e f g h"));
});

// ---------- themes + enhance ----------
const { createThemes, themeText, qualityText, PRESETS } = require("../lib/themes");
const { enhanceFilter } = require("../lib/enhance");

test("looks: five looks, old theme ids map over, look + character text, quality text", () => {
  const t = createThemes();
  assert.deepEqual(PRESETS.map((x) => x.id), ["real", "disney", "pixar", "anime", "brainrot"]);
  assert.equal(t.get("p-3dstory").id, "pixar"); // saved settings from the old themes keep working
  assert.equal(t.get("nope"), null);
  for (const x of PRESETS) assert.doesNotMatch(x.style, /disney|pixar/i); // brand names stay out of prompts
  const txt = themeText(t.get("pixar"), "A traveller with curly black hair");
  assert.match(txt, /Style: high-end 3D animated/);
  assert.match(txt, /exactly as described.*curly black hair/);
  assert.match(themeText(null, "Only a character"), /Only a character/); // character works without a look
  assert.equal(themeText(null), "");
  assert.match(qualityText({ negative: "logos" }), /^ Quality: sharp focus.*Avoid: warping.*logos\.$/);
  assert.equal(qualityText({ booster: false }), "");
});

test("enhance: filter chain only upscales, in the right orientation", () => {
  assert.equal(enhanceFilter({ upscale: "720p", smooth: true }, 480, 854),
    "hqdn3d=1.5:1.5:6:6,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,scale=-2:1280:flags=lanczos,unsharp=5:5:0.7:5:5:0.0,format=yuv420p");
  assert.match(enhanceFilter({ upscale: "1080p" }, 1280, 720), /scale=-2:1080/);
  assert.doesNotMatch(enhanceFilter({ upscale: "720p" }, 1080, 1920), /scale=/); // never shrinks
  assert.equal(enhanceFilter({ upscale: "none", sharpen: false, denoise: false }, 480, 854), "format=yuv420p");
});

// ---------- the Director ----------
const D = require("../lib/director");
// a small live list: one known model, two new ones (one an edit model that must be left out)
const LIVE = [
  { id: "google/veo-3.1-fast", supported_durations: [4, 6, 8], supported_resolutions: ["720p", "1080p"], supported_aspect_ratios: ["9:16", "16:9"], supported_frame_images: ["first_frame", "last_frame"] },
  { id: "x-ai/grok-imagine-video-1.5-lite", supported_durations: [1, 2, 3, 4, 5, 6], supported_resolutions: ["480p", "720p"], supported_aspect_ratios: ["9:16"], supported_frame_images: ["first_frame"] },
  { id: "acme/newvid-2", name: "Acme: NewVid 2", description: "Cinematic realistic people and faces", generate_audio: true, supported_durations: [5, 10], supported_resolutions: ["720p"], supported_aspect_ratios: ["9:16", "16:9"], supported_frame_images: ["first_frame"] },
  { id: "acme/video-edit-1", supported_durations: [5], supported_resolutions: ["720p"], supported_aspect_ratios: ["9:16"] },
];
const PRICES = { "google/veo-3.1-fast": { "720p": 0.08, audio: { "720p": 0.1 } }, "x-ai/grok-imagine-video-1.5-lite": { "480p": 0.02, "720p": 0.03 }, "acme/newvid-2": { "720p": 0.05, audio: { "720p": 0.05 } }, "acme/video-edit-1": { "720p": 0.03 } };
const CAT = () => modelsLib.merge(LIVE, PRICES);
const avail = (m) => m.live !== false;

test("catalog: new live models join automatically with a tier and tags; edit models stay out", () => {
  const c = CAT();
  assert.ok(c["acme/newvid-2"]);
  assert.equal(c["acme/newvid-2"].name, "NewVid 2");
  assert.equal(c["acme/newvid-2"].tier, "draft"); // $0.05/s at 720p
  assert.ok(c["acme/newvid-2"].tags.includes("faces") && c["acme/newvid-2"].tags.includes("realism"));
  assert.equal(c["acme/video-edit-1"], undefined);
  assert.equal(c["google/veo-3.1-fast"].q, 9);
});

test("director: brain plan is checked, snapped and costed by the server; rubbish falls back to the rules", async () => {
  const c = CAT();
  const req = { page: "clip", prompt: "Close-up of a woman smiling", aspect: "9:16", budget: 1 };
  const brain = async () => ({ text: JSON.stringify({ model: "google/veo-3.1-fast", duration: 5, resolution: "4K", audio: true, pictureFirst: true, reason: "faces", alternatives: [{ model: "nope/x" }, { model: "acme/newvid-2", why: "cheaper" }], total: 0.01 }), cost: 0.004 });
  const out = await D.decide(req, { catalog: c, available: avail, callBrain: brain });
  assert.equal(out.source, "brain");
  assert.equal(out.plan.duration, 4); // 5 s snapped to an allowed length (4 or 6, nearest first)
  assert.equal(out.plan.resolution, "720p"); // 4K isn't offered
  assert.equal(out.cost.total, 0.42); // server's own maths: 4 s x $0.10 + $0.02 picture (the brain's 0.01 is ignored)
  assert.deepEqual(out.plan.alternatives.map((a) => a.model), ["acme/newvid-2"]); // unknown model dropped
  const bad = await D.decide(req, { catalog: c, available: avail, callBrain: async () => ({ text: "sorry, no JSON" }) });
  assert.equal(bad.source, "rules");
  assert.ok(c[bad.plan.model]);
  const down = await D.decide(req, { catalog: c, available: avail, callBrain: async () => { throw new Error("down"); } });
  assert.equal(down.source, "rules");
  assert.equal(down.brainError, "down");
});

test("director: budget fit swaps or skips the least visible things first and stays under budget", async () => {
  const c = CAT();
  const scenes = [{ prompt: "Wide skyline at dusk", seconds: 4 }, { prompt: "Close-up of her face as the flash goes off", seconds: 4, key: true }, { prompt: "Wide shot of a taxi in the rain", seconds: 4 }];
  const brain = async () => ({ text: JSON.stringify({ resolution: "720p", pictureFirst: true, scenes: scenes.map((s, i) => ({ i, model: "google/veo-3.1-fast", duration: 4 })) }) });
  const out = await D.decide({ page: "story", aspect: "9:16", budget: 0.6, scenes }, { catalog: c, available: avail, callBrain: brain });
  assert.ok(out.cost.total <= 0.6 + 1e-9, "fits the budget: " + out.cost.total);
  assert.equal(out.plan.scenes[1].model, "google/veo-3.1-fast"); // the face close-up keeps the best model
  assert.ok(out.warnings.length > 0);
  // rules only: leftover budget upgrades the key close-up first
  const rules = await D.decide({ page: "story", aspect: "9:16", budget: 0.6, scenes }, { catalog: c, available: avail, callBrain: async () => { throw new Error("x"); } });
  assert.ok(rules.cost.total <= 0.6 + 1e-9);
  assert.equal(rules.plan.scenes[1].model, "google/veo-3.1-fast");
});

test("director: second try fixes a bad reply, names map to ids, skipped scenes are repaired, plans are cached", async () => {
  const c = CAT();
  const req = { page: "clip", prompt: "Close-up of a woman smiling", aspect: "9:16", budget: 1 };
  let calls = 0;
  const flaky = async (msgs) => { calls++; return { text: calls === 1 ? "oops" : JSON.stringify({ model: "Veo 3.1 Fast", duration: 4 }), cost: 0.001 }; };
  const out = await D.decide(req, { catalog: c, available: avail, callBrain: flaky });
  assert.equal(out.source, "brain");
  assert.equal(out.tries, 2);
  assert.equal(out.plan.model, "google/veo-3.1-fast"); // written as a name, mapped to the id
  assert.equal(D.resolveId("VEO-3.1-FAST", D.candidates(c, req, avail)), "google/veo-3.1-fast");
  // a much worse pick than the budget allows is upgraded
  const cheap = await D.decide(req, { catalog: c, available: avail, callBrain: async () => ({ text: JSON.stringify({ model: "x-ai/grok-imagine-video-1.5-lite", duration: 4, audio: false }) }) });
  assert.equal(cheap.plan.model, "google/veo-3.1-fast");
  assert.match(cheap.plan.reason, /instead of .*clearly better/);
  assert.equal(cheap.plan.alternatives[0].model, "x-ai/grok-imagine-video-1.5-lite"); // the first pick stays one tap away
  // story: one scene missing from the reply is filled in by the rules
  const scenes = [{ prompt: "Wide skyline", seconds: 4 }, { prompt: "Her face, close-up", seconds: 4, key: true }, { prompt: "A taxi", seconds: 4 }];
  const part = await D.decide({ page: "story", aspect: "9:16", budget: 2, scenes }, { catalog: c, available: avail,
    callBrain: async () => ({ text: JSON.stringify({ scenes: [{ i: 0, model: "acme/newvid-2", duration: 4 }, { i: 1, model: "google/veo-3.1-fast", duration: 4 }] }) }) });
  assert.equal(part.source, "brain+rules");
  assert.equal(part.plan.scenes.length, 3);
  assert.ok(c[part.plan.scenes[2].model]);
  // cache: the same request gives the same plan without calling the brain again
  const cache = new Map(); let n = 0;
  const once = async () => { n++; return { text: JSON.stringify({ model: "google/veo-3.1-fast", duration: 4 }), cost: 0.002 }; };
  await D.decide(req, { catalog: c, available: avail, callBrain: once, cache });
  const again = await D.decide(req, { catalog: c, available: avail, callBrain: once, cache });
  assert.equal(n, 1);
  assert.ok(again.cached && again.brainCost === 0);
});

test("director: page limits decide which models can be used", () => {
  const c = CAT();
  const ids = (req) => D.candidates(c, req, avail).map((m) => m.id).sort();
  assert.deepEqual(ids({ page: "clip", aspect: "16:9" }), ["acme/newvid-2", "google/veo-3.1-fast"]); // Grok Lite has no 16:9 here
  assert.ok(!ids({ page: "clip", aspect: "9:16", audio: true }).includes("x-ai/grok-imagine-video-1.5-lite")); // silent
  assert.deepEqual(ids({ page: "motion", aspect: "9:16" }), []); // nothing here can copy a reference video
  assert.ok(D.needs("Close-up of her face").closeup && D.needs("a girl dances").faces && !D.needs("a skyline").faces);
});

test("render queue: a stuck job gives its slot back after the time limit", async () => {
  const { createLimiter } = require("../lib/queue");
  const limit = createLimiter(1, { timeoutMs: 60, label: "Rendering" });
  const stuck = limit(() => new Promise(() => {})); // never finishes
  const order = [];
  const nextJob = limit(async () => { order.push("next ran"); return 42; });
  await assert.rejects(stuck, /took longer than/);
  assert.equal(await nextJob, 42);
  assert.deepEqual(order, ["next ran"]);
  assert.deepEqual(limit.stats(), { active: 0, waiting: 0, slots: 1 });
  // normal jobs still finish and pass their result through
  assert.equal(await createLimiter(2)(async () => "ok"), "ok");
});

test("story narration always fits its scene: speed-up, then slow-down, then hold", () => {
  const { fitScene } = require("../routes/story");
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);
  // fits already: the scene is just the clip
  assert.deepStrictEqual(fitScene(5, 3, false), { D: 5, tempo: 1, slow: 1, hold: 0 });
  // a bit long: light speed-up and slow-down, no hold, whole line heard
  let p = fitScene(4.04, 4.5, false);
  assert.ok(p.tempo <= 1.12 && p.hold === 0); near(p.D, 4.5 / p.tempo + 0.35);
  // twice as long: capped speed-up / slow-down, the rest held, scene as long as the line
  p = fitScene(4.04, 8, false);
  near(p.tempo, 1.12); near(p.slow, 1.3); assert.ok(p.hold > 0); near(p.D, 8 / 1.12 + 0.35); near(p.D, 4.04 * p.slow + p.hold);
  // budget mode slows more and speeds the voice less
  p = fitScene(4.04, 8, true);
  near(p.tempo, 1.08); near(p.slow, 1.5);
  // no narration / unknown clip length
  assert.strictEqual(fitScene(5, 0, false).D, 5);
  near(fitScene(0, 6, false).D, 6.35);
});

test("looks keep a steady camera and every clip gets the motion rule", () => {
  const { LOOKS, MOTION_RULE } = require("../lib/themes");
  for (const l of LOOKS) assert.doesNotMatch(l.camera, /zoom|pan|push-in|sweeping|handheld|dynamic/i, l.id);
  assert.match(MOTION_RULE, /one fixed angle/); assert.match(MOTION_RULE, /background/);
  assert.match(require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8"), /letterboxing\." \+\s*\/\/[^\n]*\n\s*MOTION_RULE;/);
});

test("story sound design: known ambiences and effects, nothing to mix without them", async () => {
  const { AMBIENCES, EFFECTS, mixStory, SFX, AMBIENCE } = require("../lib/sound");
  assert.ok(AMBIENCES.includes("night") && AMBIENCES.includes("rain") && EFFECTS.includes("impact") && EFFECTS.includes("riser"));
  // every source has a fixed length, so ffmpeg 5.1 always finishes (an endless source hung the stitch before)
  for (const k of AMBIENCES) for (const src of AMBIENCE[k](10)) if (/src=/.test(src)) assert.match(src, /d=10/, k);
  for (const k of EFFECTS) assert.match(SFX[k][0], /d=[\d.]+/, k);
  let called = false;
  assert.strictEqual(await mixStory(async () => { called = true; }, ".", { input: "a.mp4", output: "b.mp4", total: 10, music: "none", ambience: "none", cues: [] }), false);
  assert.strictEqual(called, false);
});

test("video limits: daily and weekly, counted in the user's time zone, videos only", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { createSpend, localDay, weekStart } = require("../lib/spend");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-"));
  let lim = { dailyCap: 1.5, weeklyCap: 10, tz: "Australia/Sydney" }, pending = 0;
  const sp = createSpend({ DATA: dir, API: "x", getKey: () => "", getCap: () => 0, getLimits: () => lim, getPending: () => pending });
  // Monday 23 Nov 2026, 14:00 in Sydney (UTC+11)
  const now = Date.parse("2026-11-23T03:00:00Z");
  assert.strictEqual(localDay(now, "Australia/Sydney"), "2026-11-23");
  assert.strictEqual(weekStart(now, "Australia/Sydney"), "2026-11-23");
  assert.strictEqual(weekStart(Date.parse("2026-11-29T12:00:00Z"), "Australia/Sydney"), "2026-11-23"); // 23:00 Sunday there: still last week
  assert.strictEqual(weekStart(Date.parse("2026-11-29T13:30:00Z"), "Australia/Sydney"), "2026-11-30"); // 00:30 Monday there: a new week
  fs.writeFileSync(path.join(dir, "spend-2026-11.json"), JSON.stringify([
    { t: Date.parse("2026-11-23T01:00:00Z"), feature: "Story", cost: 0.9, id: "gen-vid-a", kind: "video" },       // today
    { t: Date.parse("2026-11-22T13:30:00Z"), feature: "Single clips", cost: 0.3, id: "gen-vid-b" },              // 00:30 Monday in Sydney: today (an older row without kind)
    { t: Date.parse("2026-11-22T10:00:00Z"), feature: "UGC", cost: 2, id: "gen-vid-c", kind: "video" },          // Sunday in Sydney: last week
    { t: Date.parse("2026-11-23T01:00:00Z"), feature: "Story", cost: 5 },                                         // pictures / text: not video
    { t: Date.parse("2026-11-23T01:00:00Z"), feature: "Shorts", cost: 4, id: "short-x" },                        // a Short: not video generation
  ]));
  const u = sp.limits(now);
  assert.strictEqual(u.today, 1.2); assert.strictEqual(u.week, 1.2);
  assert.strictEqual(sp.videoBlock(0.2, 0, now), null);                                   // 1.2 + 0.2 fits under 1.5
  assert.match(sp.videoBlock(0.4, 0, now), /Daily video limit reached: \$1\.20 of \$1\.50 used today/);
  pending = 0.2; assert.match(sp.videoBlock(0.15, 0, now), /plus about \$0\.20 for videos still being made/); pending = 0;
  assert.match(sp.videoBlock(0.15, 0.2, now), /Daily/);                                    // a video being submitted right now counts too
  assert.match(sp.videoBlock(2, 0, now), /more than the whole daily video limit/);
  lim = { dailyCap: 0, weeklyCap: 1.3, tz: "Australia/Sydney" };                          // weekly only
  assert.match(sp.videoBlock(0.2, 0, now), /Weekly video limit reached.*resets on Monday \(Sydney time\)/);
  lim = { dailyCap: 0, weeklyCap: 0, tz: "Australia/Sydney" };                            // 0 = no limit
  assert.strictEqual(sp.videoBlock(50, 0, now), null);
});

test("every page runs inside the shell: studio.js on each page, the shell holds the music, safe areas come from variables", () => {
  const fs = require("fs"), path = require("path"), pub = path.join(__dirname, "..", "public");
  const pages = fs.readdirSync(pub).filter((f) => f.endsWith(".html") && f !== "shell.html");
  assert.ok(pages.length >= 10);
  for (const p of pages) assert.match(fs.readFileSync(path.join(pub, p), "utf8"), /<script src="\/studio\.js"/, p + " must load studio.js (it sends the page into the shell)");
  const shell = fs.readFileSync(path.join(pub, "shell.html"), "utf8");
  assert.match(shell, /<html[^>]*data-shell/);
  assert.match(shell, /<iframe id="app"/);
  assert.match(shell, /src="\/music\.js"/);
  assert.doesNotMatch(shell, /studio\.js/, "the shell must not send itself into the shell");
  const css = fs.readFileSync(path.join(pub, "app.css"), "utf8");
  assert.strictEqual((css.match(/env\(safe-area-inset/g) || []).length, 4, "only the four :root defaults may use env(); everything else reads the variables");
});

test("Hinglish mode: Devanagari is banned, voices and models that can't do Hinglish are switched off", () => {
  const h = require("../lib/hinglish"), { VIDEO } = require("../lib/models"), { candidates } = require("../lib/director");
  // the header that switches the mode on
  assert.strictEqual(h.isHinglish({ headers: { "x-lang": "hinglish" } }), true);
  assert.strictEqual(h.isHinglish({ headers: { "x-lang": "Hinglish" } }), true);
  assert.strictEqual(h.isHinglish({ headers: {} }), false);
  // the AI is told, in plain words, to use English letters only
  assert.match(h.RULE, /ONLY in English \(Roman\) letters/); assert.match(h.RULE, /NEVER use Devanagari/);
  assert.match(h.SPEECH_RULE, /Hinglish/); assert.match(h.SPEECH_RULE, /never Devanagari/);
  // and whatever still slips through is turned into Roman letters, anywhere in a JSON answer
  assert.strictEqual(h.hasDevanagari("plan ekdum perfect tha"), false);
  assert.ok(h.hasDevanagari("ये वीडियो"));
  assert.doesNotMatch(h.scrub("नमस्ते दोस्तों, ये वीडियो बहुत मज़ेदार है।"), /[ऀ-ॿ]/);
  assert.strictEqual(h.scrub("kamal aur sundar"), "kamal aur sundar");
  assert.strictEqual(h.devanagariToRoman("कमल और सुंदर बच्चे"), "kamal aur sundar bachche");
  const plan = h.scrubDeep({ title: "प्लान", scenes: [{ narration: "मैं ठीक हूँ", prompt: "A man walks" }], n: 3 });
  assert.doesNotMatch(JSON.stringify(plan), /[ऀ-ॿ]/); assert.strictEqual(plan.scenes[0].prompt, "A man walks"); assert.strictEqual(plan.n, 3);
  // voices: only multilingual ElevenLabs v3 speaks Hinglish; Kokoro is English-only
  assert.strictEqual(h.hingVoice({ model: "hexgrad/kokoro-82m", voice: "af_heart" }).voice, "jessica");
  assert.strictEqual(h.hingVoice({ model: "hexgrad/kokoro-82m", voice: "am_adam" }).voice, "brian");
  const v = h.hingVoice({ model: "elevenlabs/eleven-turbo-v2.5", voice: "george", instructions: "calm" });
  assert.strictEqual(v.model, "elevenlabs/eleven-v3"); assert.strictEqual(v.voice, "george"); assert.match(v.instructions, /calm.*Hinglish/);
  // video models: only Google's can speak Hindi inside a clip
  assert.ok(h.hindiSpeech("google/veo-3.1-lite")); assert.ok(!h.hindiSpeech("bytedance/seedance-2.0")); assert.ok(!h.hindiSpeech("kwaivgi/kling-v3.0-pro"));
  const catalog = Object.fromEntries(Object.entries(VIDEO).map(([id, m]) => [id, { id, tags: [], q: 5, ...m }]));
  const talks = candidates(catalog, { page: "clip", aspect: "9:16", hinglish: true });
  assert.ok(talks.length > 0 && talks.every((m) => !m.audio || m.id.startsWith("google/")), "a sound model must be Hindi-capable (Google)");
  assert.ok(talks.some((m) => !m.audio), "silent models stay (the narration voice speaks for them)");
  const storyTalk = candidates(catalog, { page: "story", aspect: "9:16", hinglish: true, speech: true });
  assert.ok(storyTalk.length > 0 && storyTalk.every((m) => m.audio && m.id.startsWith("google/")), "a Story with narration off talks inside the clips");
  assert.ok(candidates(catalog, { page: "story", aspect: "9:16", hinglish: true }).some((m) => m.id.startsWith("bytedance/seedance")), "Story clips are silent (narration is a separate voice), so nothing is switched off there");
  assert.ok(candidates(catalog, { page: "clip", aspect: "9:16" }).some((m) => m.id.startsWith("bytedance/seedance")), "outside Hinglish mode nothing changes");
});

test("Hinglish mode: no Devanagari in the app's own files, the secret gesture is a hold on the More button, and the tab names are never translated", () => {
  const fs = require("fs"), path = require("path"), root = path.join(__dirname, "..");
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (/^(node_modules|\.git|work|data|videos)$/.test(f)) continue; const s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (/\.(js|html|css)$/.test(f)) files.push(p); } };
  walk(path.join(root, "public")); walk(path.join(root, "lib")); walk(path.join(root, "routes")); files.push(path.join(root, "server.js"), path.join(root, "shorts.js"));
  // (lib/hinglish.js holds the Devanagari letters it converts FROM; nothing else may contain any)
  for (const f of files) if (!/hinglish\.js$/.test(f)) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /[ऀ-ॿ]/, path.relative(root, f) + " must not contain Devanagari");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const gesture = app.slice(app.indexOf("// Hinglish mode: a hidden gesture"));
  assert.match(gesture, /\.tb-more/); assert.match(gesture, /radial-open/, "only while the circle is open"); assert.match(gesture, /2000/, "it is a 2 second hold"); assert.doesNotMatch(gesture.replace(/\/\/[^\n]*/g, ""), /\.pagehead h1/, "the title no longer carries it");
  // the Hinglish word list never touches buttons, labels, headings or the navigation
  const studio = fs.readFileSync(path.join(root, "public", "studio.js"), "utf8");
  const skip = studio.match(/const SKIP = '([^']+)'/)[1];
  for (const sel of ["button", "a", "label", "h1", "h2", ".tabbar", ".sb", ".radial"]) assert.ok(skip.split(",").includes(sel), sel + " must be skipped");
});

test("start pictures that are not JPEG or PNG are converted before they reach a video model", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /async function frameToJpeg/); assert.match(src, /frame_images, body\.input_references/);
  assert.match(src, /mustTalk/); assert.match(src, /generate_audio = true/);
});

test("system reboot: the monthly cap counts again from the reboot, the real total is kept", async () => {
  const os = require("os"), fs = require("fs"), path = require("path"), { createSpend } = require("../lib/spend");
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "spend-"));
  const sp = createSpend({ DATA, API: "", getKey: () => "", getCap: () => 1 });
  sp.log("Test", 1.5, "m");
  assert.match(await sp.capBlock(), /cap reached/);
  await sp.reboot();
  assert.equal(await sp.capBlock(), null, "allowed again right after the reboot");
  assert.ok((await sp.monthTotal()) >= 1.5, "the real total is untouched");
  sp.log("Test", 1.2, "m");
  assert.match(await sp.capBlock(), /cap reached/, "the cap applies again to what is spent after the reboot");
});

test("face swap: consent is required, engines are priced, jobs are ordinary fal jobs", async () => {
  const { ENGINES, estimate } = require("../routes/faceswap"), providers = require("../lib/providers");
  assert.equal(estimate("pixverse", 12), 0.05, "PixVerse is a flat price");
  assert.equal(estimate("wan", 10), 0.8, "Wan is priced by the second");
  assert.ok(ENGINES.pixverse.input("v", "f").enable_safety_checker && ENGINES.wan.input("v", "f").enable_safety_checker && ENGINES.wan.input("v", "f").enable_output_safety_checker, "safety checks stay on");
  const sent = [];
  const out = await providers.submitFalApp("fal-ai/pixverse/swap", { a: 1 }, async (u, init) => { sent.push([u, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ request_id: "r9", status_url: "s", response_url: "r" }) }; });
  assert.match(out.id, /^fal_r9$/); assert.ok(providers.isExternal(out.id)); assert.equal(sent[0][0], "https://queue.fal.run/fal-ai/pixverse/swap");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "faceswap.js"), "utf8");
  assert.match(src, /b\.consent !== true/); assert.match(src, /spend\.videoBlock/);
});
