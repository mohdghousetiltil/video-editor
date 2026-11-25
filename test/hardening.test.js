const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createRenderer } = require("../lib/render");
const { createJobQueue } = require("../lib/jobqueue");
const { withSync, s3Store } = require("../lib/objstore");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hard-"));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 20)); } };

// a tiny fake bucket: `plan` is the list of statuses to answer first, then 200
async function fakeS3(plan) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = [];
    req.on("data", (d) => body.push(d));
    req.on("end", () => {
      seen.push(`${req.method} ${Buffer.concat(body).toString()}`.trim());
      const status = plan.length ? plan.shift() : 200;
      res.writeHead(status);
      res.end(status === 200 ? "hello" : "<Error><Message>nope</Message></Error>");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const store = s3Store({ bucket: "b", endpoint: `http://127.0.0.1:${server.address().port}`, accessKeyId: "a", secretAccessKey: "s", waitMs: 5, tries: 3 });
  return { store, seen, close: () => server.close() };
}

test("storage: a passing failure is tried again, with the whole file sent again", async (t) => {
  const s = await fakeS3([503, 500]);
  t.after(s.close);
  const f = path.join(tmp(), "in.txt");
  fs.writeFileSync(f, "payload");
  await s.store.put("k", f);
  assert.deepEqual(s.seen, ["PUT payload", "PUT payload", "PUT payload"]);
});

test("storage: a refusal is not retried, and a failed download leaves no half file", async (t) => {
  const s = await fakeS3([403]);
  t.after(s.close);
  const dir = tmp();
  await assert.rejects(s.store.get("k", path.join(dir, "out.txt")), /403/);
  assert.equal(s.seen.length, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("storage: a name that leaves the data folder is refused", async () => {
  const root = tmp();
  const store = withSync({ kind: "mem", shared: false, get: async () => assert.fail("must not be fetched"), list: async () => [{ key: "../evil.txt", size: 1 }] }, root);
  await assert.rejects(store.pull(["../evil.txt"], []), /outside the data folder/);
  await assert.rejects(store.pull([], ["../../x"]), /outside the data folder/);
  await assert.rejects(store.pullMissing(["work/"]), /outside the data folder/);
});

test("spend recorded by a worker that dies is still written, exactly once", async (t) => {
  let PGlite;
  try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { return t.skip("PGlite not installed: npm install"); }
  const db = new PGlite();
  const queue = createJobQueue(db, { backoffBaseSec: 0, backoffMaxSec: 0, staleSec: 1 });
  await queue.migrate();
  const root = tmp(), history = [];
  const shared = withSync({ kind: "local", shared: true }, root);
  const make = (role, workerId, run) => {
    const r = createRenderer({ queue, storage: shared, role, workerId, pollMs: 20, heartbeatMs: 60000, reapMs: 100, maxAttempts: 1, log: quiet });
    const spend = r.capture("spend.log", (f, c) => history.push([f, c]));
    r.define("pay", { run: () => run(spend), state: () => ({}) });
    return r;
  };
  const web = make("web", "web", async () => {});
  // pays, then never finishes (the process "dies": its lease is never renewed again; the next beat is a minute away)
  const worker = make("worker", "w-dies", async (spend) => { spend("AI", 0.4); await new Promise(() => {}); });
  const done = web.submit("pay", {}, { ref: "r1" });
  worker.startWorker({ concurrency: 1 });
  await until(async () => (await db.query("SELECT result FROM render_jobs")).rows[0]?.result?.effects?.length === 1);
  worker.stopWorker(0).catch(() => {});
  await db.query("UPDATE render_jobs SET status = 'in_progress', heartbeat_at = now() - interval '1 hour', attempts = max_attempts, lock_token = gen_random_uuid()");
  await web.startWatcher();
  t.after(() => web.stopWatcher());
  await done;
  assert.deepEqual(history, [["AI", 0.4]]);
  assert.equal((await db.query("SELECT status::text AS s FROM render_jobs")).rows[0].s, "failed");
});
