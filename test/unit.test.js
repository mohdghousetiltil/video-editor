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
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro").provider, "fal");
    assert.equal(providers.pickRoute("bytedance/seedance-2.0-fast").provider, "byteplus");
    assert.equal(providers.pickRoute("google/veo-3.1-lite").provider, "openrouter");
    process.env.FAL_KLING_FACTOR = "1.4"; // pricier than OpenRouter: only used when OpenRouter lacks the model
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro").provider, "openrouter");
    assert.equal(providers.pickRoute("kwaivgi/kling-v3.0-pro", { orAvailable: false }).provider, "fal");
    delete process.env.FAL_KLING_FACTOR;

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
    const f = await providers.submit(providers.pickRoute("kwaivgi/kling-v3.0-pro"), { prompt: "p", duration: 5, aspect_ratio: "9:16", frame_images: [{ frame_type: "first_frame", image_url: { url: "data:x" } }] }, fake);
    assert.equal(f.id, "fal_r1");
    assert.match(calls[0][0], /image-to-video/);
    assert.equal(calls[0][1].image_url, "data:x");
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
  const ctx = { window: {}, localStorage: { getItem: () => null, setItem() {} }, fetch: async () => ({ json: async () => ({}) }), document: {} };
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
  assert.ok(S.validJobId("gen-vid-abc123def") && !S.validJobId("x") && !S.validJobId("a b c d e f g h"));
});
