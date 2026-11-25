// Render job queue against a real PostgreSQL: PGlite (Postgres compiled to WASM, a dev dependency) by default, or a
// server when TEST_DATABASE_URL is set (that also runs the two-connection SKIP LOCKED test).
const test = require("node:test");
const assert = require("node:assert");
const { createJobQueue, connect } = require("../lib/jobqueue");

let db, close, pgUrl = process.env.TEST_DATABASE_URL;
async function fresh(opts) {
  if (!db) {
    if (pgUrl) { db = connect(pgUrl); close = () => db.end(); }
    else {
      let PGlite;
      try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { return null; }
      db = new PGlite(); close = () => db.close();
    }
  }
  await db.query("DROP TABLE IF EXISTS render_jobs");
  const qq = createJobQueue(db, opts);
  await qq.migrate();
  return qq;
}
const age = (id, col, sec) => db.query(`UPDATE render_jobs SET ${col} = now() - make_interval(secs => $2) WHERE id = $1`, [id, sec]);
const ready = (id) => db.query(`UPDATE render_jobs SET run_after = now() WHERE id = $1`, [id]);
test.after(() => close && close());

test("enqueue then claim: oldest first, higher priority before it, nothing twice", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed: npm install");
  const a = await q.enqueue({ kind: "short", payload: { id: "a" } });
  const b = await q.enqueue({ kind: "stitch", payload: { id: "b" } });
  const c = await q.enqueue({ kind: "short", payload: { id: "c" }, priority: 5 });
  assert.equal(a.status, "queued");
  assert.deepEqual(a.payload, { id: "a" });
  assert.equal(a.user_id, null); // ready for accounts later
  const first = await q.claim("w1");
  assert.equal(first.id, c.id, "higher priority first");
  assert.equal(first.status, "running");
  assert.equal(first.attempts, 1);
  assert.equal(first.locked_by, "w1");
  assert.ok(first.lock_token);
  assert.equal((await q.claim("w2")).id, a.id);
  assert.equal((await q.claim("w2")).id, b.id);
  assert.equal(await q.claim("w3"), null, "queue is empty");
  assert.deepEqual(await q.counts(), { queued: 0, running: 3 });
});

test("claim can be limited to some kinds and skips jobs that are waiting out a back-off", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  await q.enqueue({ kind: "short" });
  const later = await q.enqueue({ kind: "stitch", runAfterSec: 60 });
  const st = await q.enqueue({ kind: "stitch" });
  assert.equal((await q.claim("w", ["stitch"])).id, st.id);
  assert.equal(await q.claim("w", ["stitch"]), null, "the other stitch is not due yet");
  await ready(later.id);
  assert.equal((await q.claim("w", ["stitch"])).id, later.id);
});

test("complete stores the result; a stale lock token can't touch the job", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  await q.enqueue({ kind: "short" });
  const j = await q.claim("w1");
  assert.equal(await q.heartbeat(j.id, j.lock_token, { step: "Rendering", pct: 40 }), true);
  assert.deepEqual((await q.get(j.id)).progress, { step: "Rendering", pct: 40 });
  assert.equal(await q.complete(j.id, "00000000-0000-0000-0000-000000000000", { x: 1 }), null, "wrong token");
  const done = await q.complete(j.id, j.lock_token, { files: ["work/shorts/a/short.mp4"] });
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result, { files: ["work/shorts/a/short.mp4"] });
  assert.ok(done.finished_at);
  assert.equal(done.lock_token, null);
  assert.equal(await q.heartbeat(j.id, j.lock_token), false, "finished: no longer ours");
  assert.equal(await q.fail(j.id, j.lock_token, "late"), null, "can't fail a finished job");
});

test("a failed attempt goes back in the queue with back-off until attempts run out", async (t) => {
  const q = await fresh({ backoffBaseSec: 10, backoffMaxSec: 15 }); if (!q) return t.skip("PGlite not installed");
  const { id } = await q.enqueue({ kind: "short", maxAttempts: 3 });
  let j = await q.claim("w");
  let r = await q.fail(j.id, j.lock_token, new Error("storage hiccup"));
  assert.equal(r.status, "queued");
  assert.equal(r.error, "storage hiccup");
  assert.equal(r.finished_at, null);
  let wait = (new Date(r.run_after) - Date.now()) / 1000;
  assert.ok(wait > 7 && wait <= 11, `first back-off ~10 s, got ${wait}`);
  assert.equal(await q.claim("w"), null, "not before the back-off");

  await ready(id);
  j = await q.claim("w");
  assert.equal(j.attempts, 2);
  r = await q.fail(j.id, j.lock_token, "again");
  wait = (new Date(r.run_after) - Date.now()) / 1000;
  assert.ok(wait > 12 && wait <= 16, `second back-off doubles, capped at 15 s, got ${wait}`);

  await ready(id);
  j = await q.claim("w");
  assert.equal(j.attempts, 3);
  r = await q.fail(j.id, j.lock_token, "third time", { result: { state: { status: "failed" } } });
  assert.equal(r.status, "failed", "no attempts left");
  assert.ok(r.finished_at);
  assert.deepEqual(r.result, { state: { status: "failed" } });
});

test("fail with retry:false fails for good straight away", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  await q.enqueue({ kind: "short", maxAttempts: 5 });
  const j = await q.claim("w");
  assert.equal((await q.fail(j.id, j.lock_token, "bad input", { retry: false })).status, "failed");
});

test("reap: a job whose worker stopped heartbeating is re-queued, then failed when out of attempts", async (t) => {
  const q = await fresh({ staleSec: 60 }); if (!q) return t.skip("PGlite not installed");
  const { id } = await q.enqueue({ kind: "stitch", maxAttempts: 2 });
  const healthy = await q.enqueue({ kind: "stitch" });
  const j = await q.claim("dead-worker");
  const h = await q.claim("live-worker");
  assert.equal(h.id, healthy.id);
  assert.equal((await q.reap()).length, 0, "both heartbeats are fresh");

  await age(id, "heartbeat_at", 120);
  const reaped = await q.reap();
  assert.deepEqual(reaped.map((x) => x.id), [id], "only the quiet one");
  assert.equal(reaped[0].status, "queued");
  assert.match(reaped[0].error, /stopped responding/);
  assert.equal(await q.heartbeat(id, j.lock_token), false, "the old worker lost it");
  assert.equal(await q.complete(id, j.lock_token, {}), null, "and can't complete it");

  await ready(id);
  const again = await q.claim("w2");
  assert.equal(again.id, id);
  assert.equal(again.attempts, 2);
  await age(id, "heartbeat_at", 120);
  const [last] = await q.reap();
  assert.equal(last.status, "failed");
  assert.ok(last.finished_at);
  assert.equal((await q.get(healthy.id)).status, "running", "the healthy job was left alone");
});

test("reap: a job that runs past its own timeout is stopped even while heartbeating", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  const { id } = await q.enqueue({ kind: "short", timeoutSec: 600, maxAttempts: 1 });
  const j = await q.claim("w");
  await age(id, "locked_at", 601);
  await q.heartbeat(id, j.lock_token);
  const [r] = await q.reap();
  assert.equal(r.status, "failed");
  assert.match(r.error, /longer than 10 minutes/);
});

test("release hands a job back without using an attempt (worker shutting down)", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  await q.enqueue({ kind: "short", maxAttempts: 1 });
  const j = await q.claim("w");
  const r = await q.release(j.id, j.lock_token);
  assert.equal(r.status, "queued");
  assert.equal(r.attempts, 0);
  assert.equal((await q.claim("w2")).attempts, 1, "still has its one attempt");
});

test("cancel stops a queued job and takes a running one away from its worker", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  const a = await q.enqueue({ kind: "short" });
  await q.enqueue({ kind: "short" });
  assert.equal((await q.cancel(a.id)).status, "cancelled");
  const j = await q.claim("w");
  assert.notEqual(j.id, a.id);
  await q.cancel(j.id);
  assert.equal(await q.heartbeat(j.id, j.lock_token), false);
});

test("finalize: only one caller gets a finished job; open lists what's not copied back", async (t) => {
  const q = await fresh(); if (!q) return t.skip("PGlite not installed");
  const a = await q.enqueue({ kind: "short" });
  const b = await q.enqueue({ kind: "short" });
  assert.equal(await q.finalize(a.id), null, "still queued");
  const j = await q.claim("w");
  await q.complete(j.id, j.lock_token, {});
  assert.ok(await q.finalize(a.id));
  assert.equal(await q.finalize(a.id), null, "already taken");
  assert.deepEqual((await q.open()).map((x) => x.id), [b.id]);
  await q.unfinalize(a.id);
  assert.equal((await q.open()).length, 2);
  assert.deepEqual((await q.getMany([a.id, b.id])).map((x) => x.id).sort(), [a.id, b.id].sort());
});

test("two connections claiming at once never get the same job (SKIP LOCKED)", { skip: !pgUrl && "needs TEST_DATABASE_URL (PGlite is a single connection)" }, async () => {
  const q = await fresh();
  for (let i = 0; i < 20; i++) await q.enqueue({ kind: "short", payload: { i } });
  const other = connect(pgUrl, { max: 10 });
  try {
    const q2 = createJobQueue(other);
    const got = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? q : q2).claim("w" + i)));
    const ids = got.filter(Boolean).map((j) => j.id);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20, "no job claimed twice");
  } finally { await other.end(); }
});
