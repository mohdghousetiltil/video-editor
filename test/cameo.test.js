// Influencer cameo in the Shorts maker's picture explainer. The AI calls are faked (nothing is charged); the render
// runs through the real ffmpeg (skipped when it isn't installed).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawn, spawnSync } = require("child_process");
process.env.CAMEO_POLL_MS = "5"; // the faked video service answers at once
const createShorts = require("../shorts");
const { cameoPrompt, cameoTalkPrompt } = require("../lib/identity-prompt");

const { cameoSlides, pictureShots, cameoLen } = createShorts;
const FF = process.env.FFMPEG_PATH || "ffmpeg";
const hasFF = spawnSync(FF, ["-version"]).status === 0;

test("cameo: the hook first, then the payoff, then the middle; never more than 3", () => {
  assert.deepEqual(cameoSlides(5, 1), [0]);
  assert.deepEqual(cameoSlides(5, 2), [0, 4]);
  assert.deepEqual(cameoSlides(5, 3), [0, 2, 4]);
  assert.deepEqual(cameoSlides(5, 9), [0, 2, 4]);
  assert.deepEqual(cameoSlides(1, 3), [0]);
  assert.deepEqual(cameoSlides(2, 3), [0, 1]);
  assert.deepEqual(cameoSlides(4, 0), []);
});

test("cameo: the original picture is still shown, and the Short is no longer or shorter", () => {
  const X = 0.35;
  const plain = [{ file: "pic0.jpg", start: 0, D: 3 }, { file: "pic1.jpg", start: 2.65, D: 2.5 }];
  assert.deepEqual(pictureShots(plain, X), plain, "no cameo: one shot per line, as before");
  const shots = pictureShots([{ ...plain[0], cameo: "cameo0.png" }, plain[1]], X);
  assert.deepEqual(shots.map((s) => s.file), ["cameo0.png", "pic0.jpg", "pic1.jpg"]);
  for (let k = 1; k < shots.length; k++) assert.ok(Math.abs(shots[k - 1].start + shots[k - 1].D - X - shots[k].start) < 1e-9, "each shot crossfades into the next");
  assert.ok(Math.abs(shots[2].start + shots[2].D - (plain[1].start + plain[1].D)) < 1e-9, "same total length");
  assert.ok(shots.every((s) => s.D > 2 * X));
});

test("cameo prompt: identity first, the picture is the subject and stays faithful, gender-neutral", () => {
  const p = cameoPrompt({ refs: 3, desc: "short grey hair", narration: "This is the piston." });
  assert.match(p, /IDENTITY PRESERVATION/);
  assert.match(p, /Images 1 to 3 all show this one person/);
  assert.match(p, /Image 4 is NOT a picture of the person/);
  assert.match(p, /pointing at it/);
  assert.match(p, /FAITHFUL SUBJECT: keep what image 4 shows exactly/);
  assert.match(p, /short grey hair/);
  assert.match(p, /This is the piston\.[\s\S]*Add no text/);
  assert.doesNotMatch(cameoPrompt(), /Images 1 to|Known details|being said/);
  assert.doesNotMatch(p, /\b(she|her|he|his)\b/i);
});

const run = (args, cwd) => new Promise((resolve, reject) => {
  const p = spawn(FF, ["-hide_banner", ...args], { cwd });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("close", (c) => (c === 0 ? resolve(err) : reject(new Error(err.slice(-800)))));
});

// a Shorts maker in a temp folder, with every paid call faked and recorded
function studio(root, { imageFails = false, videoFails = false, voice: infVoice } = {}) {
  const calls = { images: [], videos: [], tts: [], spend: [] }, done = [];
  const media = (name, args) => { spawnSync(FF, ["-y", ...args, name], { cwd: root }); return fs.readFileSync(path.join(root, name)); };
  const picture = media("p.jpg", ["-f", "lavfi", "-i", "testsrc=s=320x240", "-frames:v", "1"]);
  const drawn = media("c.png", ["-f", "lavfi", "-i", "color=c=red:s=180x320", "-frames:v", "1"]);
  const voice = media("v.mp3", ["-f", "lavfi", "-i", "sine=duration=1.5"]);
  const clip = media("clip.mp4", ["-f", "lavfi", "-i", "color=c=blue:s=360x640:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const face = path.join(root, "face.jpg");
  fs.writeFileSync(face, picture);
  const reply = (j, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => j });
  const orFetch = async (url, opts = {}) => {
    if (/\/videos\/v1\/content/.test(url)) return { ok: true, status: 200, arrayBuffer: async () => clip };
    if (/\/videos\/v1$/.test(url)) return reply(videoFails ? { status: "failed", error: "moderated" } : { status: "completed", usage: { cost: 0.09 } });
    const body = JSON.parse(opts.body);
    if (url.endsWith("/videos")) { calls.videos.push(body); return reply({ id: "v1", status: "pending" }); }
    if (url.endsWith("/images")) {
      calls.images.push(body);
      return imageFails ? reply({ error: { message: "refused" } }, false) : reply({ data: [{ b64_json: drawn.toString("base64"), media_type: "image/png" }], usage: { cost: 0.01 } });
    }
    const plan = { title: "T", hook: "Look", mood: "chill", slides: [{ image: 1, narration: "First point here." }, { image: 2, narration: "Second point here." }] };
    return reply({ choices: [{ message: { content: JSON.stringify(plan) } }], usage: { cost: 0.002 } });
  };
  const renderSlot = require("../lib/render").createRenderer({ slots: 1, log: { log() {}, error() {} } });
  const submit = renderSlot.submit;
  renderSlot.submit = (...a) => { const p = submit(...a); done.push(p); return p; };
  const shorts = createShorts({
    STORE: root, FFMPEG: FF, API: "http://fake", getKey: () => "test-key", run, orFetch, renderSlot,
    send: (res, code, obj) => Object.assign(res, { code, obj }), serveMp4: () => {}, tts: async (a) => { calls.tts.push(a); return voice; },
    logSpend: (...a) => calls.spend.push(a), readInf: () => [{ id: "abc123", name: "Sam", desc: "curly hair", ...(infVoice ? { voice: infVoice } : {}) }],
    imgFile: (id) => (id === "abc123" ? face : undefined), viewFile: () => undefined, getImageModel: () => "meta/muse-image",
  });
  const post = async (extra) => {
    const data = "data:image/jpeg;base64," + picture.toString("base64");
    const req = Object.assign(Readable.from([JSON.stringify({ images: [data, data], music: "none", sfx: "0", ...extra })]), { method: "POST", headers: {} });
    const res = {};
    await shorts.handle(req, res, new URL("http://x/api/shorts/pictures"));
    await Promise.all(done);
    const dir = res.obj.id && path.join(root, "work", "shorts", res.obj.id);
    return { ...res, dir, meta: dir && JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) };
  };
  return { calls, post };
}
const temp = async (fn) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "cameo-")); try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } };
const skip = !hasFF && "ffmpeg not installed";

test("pictures without an influencer: no picture is drawn and nothing new is recorded", { skip }, () => temp(async (root) => {
  const s = studio(root), r = await s.post({});
  assert.equal(r.meta.status, "done", r.meta.error);
  assert.equal(s.calls.images.length, 0);
  assert.ok(!("cameo" in r.meta) && !("warning" in r.meta));
  assert.deepEqual(s.calls.spend.map((a) => a[1]), [0.002]);
  assert.ok(fs.existsSync(path.join(r.dir, "short.mp4")));
}));

test("pictures with an influencer: drawn from their picture, filmed explaining, logged as spend, counted in the Short's cost", { skip }, () => temp(async (root) => {
  const plain = await studio(root).post({});
  const s = studio(root), r = await s.post({ influencer_id: "abc123", cameos: 1 });
  assert.equal(r.meta.status, "done", r.meta.error);
  assert.equal(s.calls.images.length, 1);
  assert.equal(s.calls.images[0].input_references.length, 2, "the influencer, then the picture being explained");
  assert.match(s.calls.images[0].prompt, /curly hair[\s\S]*First point here/);
  assert.deepEqual(r.meta.cameo, { name: "Sam", pictures: [1], talking: [1], voice: null });
  assert.equal(r.meta.warning, null);
  assert.equal(r.meta.length, plain.meta.length);
  // the talking clip starts from the drawn picture, is silent, and acts out the line
  assert.equal(s.calls.videos.length, 1);
  const v = s.calls.videos[0];
  assert.equal(v.model, "x-ai/grok-imagine-video-1.5-lite");
  assert.equal(v.generate_audio, false);
  assert.equal(v.frame_images[0].frame_type, "first_frame");
  assert.match(v.frame_images[0].image_url.url, /^data:image\/png;base64,/);
  assert.match(v.prompt, /talks straight to the camera[\s\S]*hand gestures[\s\S]*First point here/);
  assert.ok(Number.isInteger(v.duration) && v.duration >= 1 && v.duration <= 10);
  assert.ok(Math.abs(r.meta.cost - plain.meta.cost - 0.01 - 0.09) < 1e-9);
  assert.deepEqual(s.calls.spend.map((a) => [a[0], a[1], a[2]]).filter((a) => a[2] === "meta/muse-image" || /grok/.test(a[2])),
    [["Shorts", 0.01, "meta/muse-image"], ["Shorts", 0.09, "x-ai/grok-imagine-video-1.5-lite"]]);
  assert.equal(s.calls.spend.reduce((a, x) => a + x[1], 0).toFixed(4), "0.1020");
  await new Promise((res) => setTimeout(res, 500)); // working files are removed without waiting
  assert.deepEqual(fs.readdirSync(r.dir).filter((f) => /^cameo/.test(f)), [], "working pictures and clips are cleaned up");
}));

test("an influencer with their own voice speaks the whole Short", { skip }, () => temp(async (root) => {
  const s = studio(root, { voice: "af_bella" }), r = await s.post({ influencer_id: "abc123", cameos: 1, voice: "am_michael" });
  assert.equal(r.meta.status, "done", r.meta.error);
  assert.ok(s.calls.tts.length >= 2 && s.calls.tts.every((a) => a.voice === "af_bella"));
  assert.equal(r.meta.cameo.voice, "af_bella");
  const plain = studio(root, { voice: "af_bella" }), p = await plain.post({ voice: "am_michael" });
  assert.ok(plain.calls.tts.every((a) => a.voice === "am_michael"), "without the cameo the chosen narrator speaks");
  assert.equal(p.meta.status, "done");
}));

test("a talking clip that fails: the still cameo picture stays, with a warning", { skip }, () => temp(async (root) => {
  const s = studio(root, { videoFails: true }), r = await s.post({ influencer_id: "abc123", cameos: 1 });
  assert.equal(r.meta.status, "done", r.meta.error);
  assert.deepEqual(r.meta.cameo.pictures, [1]);
  assert.deepEqual(r.meta.cameo.talking, []);
  assert.match(r.meta.warning, /Sam stays a still picture in picture 1: moderated/);
  assert.ok(!s.calls.spend.some((a) => /grok/.test(a[2])), "a failed clip is not logged as spend");
}));

test("cameo length: most of the line, the original keeps ~1.5 s, at most 10 s", () => {
  assert.ok(Math.abs(cameoLen(3) - 1.65) < 1e-9);
  assert.equal(cameoLen(6), 4.5);
  assert.equal(cameoLen(30), 10);
});

test("talking prompt: to camera, gestures, the line, no text, gender-neutral", () => {
  const p = cameoTalkPrompt({ desc: "curly hair", narration: "Heat makes it expand." });
  assert.match(p, /talks straight to the camera/);
  assert.match(p, /hand gestures/);
  assert.match(p, /Heat makes it expand\./);
  assert.match(p, /no on-screen text/);
  assert.doesNotMatch(p, /\b(she|her|he|his)\b/i);
});

test("a cameo that can't be drawn: the Short is still made, with a warning", { skip }, () => temp(async (root) => {
  const r = await studio(root, { imageFails: true }).post({ influencer_id: "abc123", cameos: 2 });
  assert.equal(r.meta.status, "done", r.meta.error);
  assert.deepEqual(r.meta.cameo.pictures, []);
  assert.match(r.meta.warning, /Sam is missing from picture \d: refused/);
}));

test("an unknown influencer is refused before anything is made", { skip }, () => temp(async (root) => {
  const s = studio(root), r = await s.post({ influencer_id: "../nope" });
  assert.equal(r.code, 400);
  assert.equal(s.calls.images.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, "work", "shorts")).filter((d) => d !== "music"), []);
}));
