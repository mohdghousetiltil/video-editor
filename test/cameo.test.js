// Influencer cameo in the Shorts maker's picture explainer. The AI calls are faked (nothing is charged); the render
// runs through the real ffmpeg (skipped when it isn't installed).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawn, spawnSync } = require("child_process");
const createShorts = require("../shorts");
const { cameoPrompt } = require("../lib/identity-prompt");

const { cameoSlides, pictureShots } = createShorts;
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
function studio(root, { imageFails = false } = {}) {
  const calls = { images: [], spend: [] }, done = [];
  const media = (name, args) => { spawnSync(FF, ["-y", ...args, name], { cwd: root }); return fs.readFileSync(path.join(root, name)); };
  const picture = media("p.jpg", ["-f", "lavfi", "-i", "testsrc=s=320x240", "-frames:v", "1"]);
  const drawn = media("c.png", ["-f", "lavfi", "-i", "color=c=red:s=180x320", "-frames:v", "1"]);
  const voice = media("v.mp3", ["-f", "lavfi", "-i", "sine=duration=1.5"]);
  const face = path.join(root, "face.jpg");
  fs.writeFileSync(face, picture);
  const reply = (j, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => j });
  const orFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
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
    send: (res, code, obj) => Object.assign(res, { code, obj }), serveMp4: () => {}, tts: async () => voice,
    logSpend: (...a) => calls.spend.push(a), readInf: () => [{ id: "abc123", name: "Sam", desc: "curly hair" }],
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

test("pictures with an influencer: drawn from their picture, logged as spend, counted in the Short's cost", { skip }, () => temp(async (root) => {
  const plain = await studio(root).post({});
  const s = studio(root), r = await s.post({ influencer_id: "abc123", cameos: 1 });
  assert.equal(r.meta.status, "done", r.meta.error);
  assert.equal(s.calls.images.length, 1);
  assert.equal(s.calls.images[0].input_references.length, 2, "the influencer, then the picture being explained");
  assert.match(s.calls.images[0].prompt, /curly hair[\s\S]*First point here/);
  assert.deepEqual(r.meta.cameo, { name: "Sam", pictures: [1] });
  assert.equal(r.meta.warning, null);
  assert.equal(r.meta.length, plain.meta.length);
  assert.ok(Math.abs(r.meta.cost - plain.meta.cost - 0.01) < 1e-9);
  assert.deepEqual(s.calls.spend.map((a) => [a[0], a[1], a[2]]).filter((a) => a[2] === "meta/muse-image"), [["Shorts", 0.01, "meta/muse-image"]]);
  assert.equal(s.calls.spend.reduce((a, x) => a + x[1], 0).toFixed(4), "0.0120");
  await new Promise((res) => setTimeout(res, 500)); // working files are removed without waiting
  assert.deepEqual(fs.readdirSync(r.dir).filter((f) => /^cameo/.test(f)), [], "working pictures are cleaned up");
}));

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
