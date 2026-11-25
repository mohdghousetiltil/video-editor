// lib/render.js: the same job definition run in-process (no database) and split over a web + a worker process that
// share only the job queue (PGlite) and a bucket (in memory here), each with its own DATA_DIR.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRenderer } = require("../lib/render");
const { createJobQueue } = require("../lib/jobqueue");
const { withSync } = require("../lib/objstore");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 20)); } };

// an in-memory bucket with the raw store interface (put / get / del / list)
function memBucket() {
  const m = new Map();
  return {
    kind: "mem", shared: false, m,
    async put(k, f) { m.set(k, fs.readFileSync(f)); },
    async get(k, f) { if (!m.has(k)) throw Object.assign(new Error("404"), { status: 404 }); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, m.get(k)); },
    async del(k) { m.delete(k); },
    async list(p) { return [...m.keys()].filter((k) => k.startsWith(p)).map((key) => ({ key, size: m.get(key).length })); },
  };
}

// the kind of job the app defines: reads work/jobs/<id>/in.txt, writes out.txt, keeps live state in a Map, logs spend
function defineDemo(render, root, { states = new Map(), history = [], behave = {} } = {}) {
  const spend = render.capture("spend.log", (feature, cost) => history.push([feature, cost]));
  render.define("demo", {
    async run({ id, fail }) {
      const st = states.get(id), dir = path.join(root, "work", "jobs", id);
      st.step = "Working"; st.where = root;
      spend("Demo", 0.25);
      if (behave.run) await behave.run(st);
      if (fail) throw new Error(fail);
      fs.writeFileSync(path.join(dir, "out.txt"), fs.readFileSync(path.join(dir, "in.txt"), "utf8").toUpperCase());
      fs.rmSync(path.join(dir, "scratch.txt"), { force: true });
      Object.assign(st, { status: "done", step: "Done" });
    },
    onError({ id }, e) { Object.assign(states.get(id) || {}, { status: "failed", error: e.message }); },
    state: ({ id }) => states.get(id),
    setState: ({ id }, s) => states.set(id, s),
    inputs: ({ id }) => [`work/jobs/${id}/`],
    outputs: ({ id }) => [`work/jobs/${id}/`],
  });
  return { states, history };
}

test("no queue: runs in this process, with the old render(fn) call still working", async () => {
  const root = tmp(), render = createRenderer({ slots: 1, log: quiet });
  assert.equal(render.durable, false);
  const { states, history } = defineDemo(render, root);
  fs.mkdirSync(path.join(root, "work/jobs/a"), { recursive: true });
  fs.writeFileSync(path.join(root, "work/jobs/a/in.txt"), "hello");
  states.set("a", { status: "running" });
  await render.submit("demo", { id: "a" });
  assert.equal(fs.readFileSync(path.join(root, "work/jobs/a/out.txt"), "utf8"), "HELLO");
  assert.equal(states.get("a").status, "done");
  assert.deepEqual(history, [["Demo", 0.25]]);
  states.set("b", { status: "running" });
  await render.submit("demo", { id: "b", fail: "boom" });
  assert.deepEqual(states.get("b"), { status: "failed", step: "Working", where: root, error: "boom" });
  assert.equal(await render(() => 42), 42);
  assert.deepEqual(render.stats(), { active: 0, waiting: 0, slots: 1 });
});

test("web + worker: inputs go up, the worker renders, files / state / spend come back once", async (t) => {
  let PGlite;
  try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { return t.skip("PGlite not installed: npm install"); }
  const db = new PGlite();
  const queue = createJobQueue(db, { backoffBaseSec: 0, backoffMaxSec: 0, staleSec: 1 });
  await queue.migrate();
  const bucket = memBucket();
  const webRoot = tmp(), workerRoot = tmp();
  const opts = { queue, pollMs: 20, heartbeatMs: 30, reapMs: 200, maxAttempts: 2, log: quiet };
  const web = createRenderer({ ...opts, role: "web", storage: withSync(bucket, webRoot) });
  const worker = createRenderer({ ...opts, role: "worker", storage: withSync(bucket, workerRoot), workerId: "w1" });
  let failOnce = true, gate = null;
  const W = defineDemo(web, webRoot);
  const K = defineDemo(worker, workerRoot, { behave: { async run(st) {
    if (gate) await gate;
    if (st.flaky && failOnce) { failOnce = false; throw new Error("worker hiccup"); }
  } } });
  try {
    await web.startWatcher();
    worker.startWorker({ concurrency: 2 });

    // 1. a normal job
    fs.mkdirSync(path.join(webRoot, "work/jobs/a"), { recursive: true });
    fs.writeFileSync(path.join(webRoot, "work/jobs/a/in.txt"), "split me");
    fs.writeFileSync(path.join(webRoot, "work/jobs/a/scratch.txt"), "x");
    W.states.set("a", { status: "running", createdAt: 1 });
    await web.submit("demo", { id: "a" });
    assert.equal(fs.readFileSync(path.join(webRoot, "work/jobs/a/out.txt"), "utf8"), "SPLIT ME", "output copied back");
    assert.ok(!fs.existsSync(path.join(webRoot, "work/jobs/a/scratch.txt")), "a file the job deleted is deleted here too");
    assert.equal(W.states.get("a").status, "done");
    assert.equal(W.states.get("a").createdAt, 1, "state handed to the worker and back");
    assert.equal(W.states.get("a").where, workerRoot, "it really ran on the worker");
    assert.deepEqual(W.history, [["Demo", 0.25]], "spend logged once, on the web side");
    assert.ok(!fs.existsSync(path.join(workerRoot, "work/jobs/a")), "the worker cleans up its copy");
    assert.deepEqual(await queue.open(), [], "nothing left to copy back");

    // 2. live progress reaches the web while the worker is busy
    let open; gate = new Promise((r) => (open = r));
    fs.mkdirSync(path.join(webRoot, "work/jobs/b"), { recursive: true });
    fs.writeFileSync(path.join(webRoot, "work/jobs/b/in.txt"), "b");
    W.states.set("b", { status: "running", step: "Waiting" });
    const done = web.submit("demo", { id: "b" });
    await until(() => W.states.get("b").step === "Working");
    open(); gate = null;
    await done;
    assert.equal(W.states.get("b").status, "done");

    // 3. a thrown error is retried (attempt 2 succeeds) and both attempts' spend is kept
    fs.mkdirSync(path.join(webRoot, "work/jobs/c"), { recursive: true });
    fs.writeFileSync(path.join(webRoot, "work/jobs/c/in.txt"), "c");
    W.states.set("c", { status: "running", flaky: true });
    W.history.length = 0;
    await web.submit("demo", { id: "c" });
    assert.equal(W.states.get("c").status, "done");
    assert.deepEqual(W.history, [["Demo", 0.25], ["Demo", 0.25]]);

    // 4. failing on every attempt: the job's own onError runs (on the worker) and the failure shows on the web
    fs.mkdirSync(path.join(webRoot, "work/jobs/d"), { recursive: true });
    fs.writeFileSync(path.join(webRoot, "work/jobs/d/in.txt"), "d");
    W.states.set("d", { status: "running" });
    await web.submit("demo", { id: "d", fail: "bad video" });
    assert.equal(W.states.get("d").status, "failed");
    assert.equal(W.states.get("d").error, "bad video");
  } finally {
    web.stopWatcher();
    await worker.stopWorker(0);
    await new Promise((r) => setTimeout(r, 100));
    await db.close();
  }
});

test("a job whose worker disappeared is failed on the web after its attempts run out", async (t) => {
  let PGlite;
  try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { return t.skip("PGlite not installed"); }
  const db = new PGlite();
  const queue = createJobQueue(db, { backoffBaseSec: 0, backoffMaxSec: 0, staleSec: 1 });
  await queue.migrate();
  const root = tmp();
  const web = createRenderer({ queue, role: "web", storage: withSync({ kind: "local", shared: true }, root), pollMs: 20, reapMs: 40, maxAttempts: 1, log: quiet });
  const W = defineDemo(web, root);
  try {
    await web.startWatcher();
    W.states.set("z", { status: "running" });
    const done = web.submit("demo", { id: "z" });
    await until(async () => (await queue.counts()).queued === 1);
    await queue.claim("crashed-worker"); // claimed, then never heard from again
    await db.query("UPDATE render_jobs SET heartbeat_at = now() - interval '1 minute'");
    await done;
    assert.equal(W.states.get("z").status, "failed");
    assert.match(W.states.get("z").error, /stopped responding/);
  } finally { web.stopWatcher(); await new Promise((r) => setTimeout(r, 60)); await db.close(); }
});
