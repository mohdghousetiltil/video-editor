// Where renders (Shorts, Story stitches, Enhance) run.
//
//   No queue (no DATABASE_URL): in this process, at most `slots` at once, exactly as before (lib/queue.js).
//   Queue, role "web":    submit() copies the job's input files to shared storage and adds a row to render_jobs.
//                         A watcher polls the rows: live progress is copied into the page's in-memory state, and a
//                         finished job's files, final state and side effects (History records, spend) are copied back.
//   Queue, role "worker": claims rows, copies the inputs down, runs the same job code, heartbeats its progress,
//                         then copies changed files up and stores the result.
//
// A job kind is defined once with the code that runs it, used by both roles:
//   render.define("stitch", {
//     run(payload),              the job itself; should catch its own errors and record them in its state
//     onError(payload, err),     the job failed outside run's own handling (timeout, worker lost, storage error)
//     state(payload),            the live state object the page polls (Map entry); setState(payload, obj) installs one
//     inputs(payload),           paths under DATA_DIR the job reads ("dir/" = a folder)
//     outputs(payload),          folders it writes; changed / new / deleted files there are copied back
//     prepare(payload),          web only, before enqueueing (e.g. fetch clips the worker can't fetch itself)
//   })
//   render.submit("stitch", payload) -> promise that settles when the job is done (and copied back)
const os = require("os");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { createLimiter } = require("./queue");
const { diff, localFiles } = require("./objstore");

const plain = (v) => { try { return v == null ? null : JSON.parse(JSON.stringify(v)); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createRenderer({ slots = 1, timeoutMs = 20 * 60000, label = "Rendering", queue = null, storage = null, role = "web",
  workerId = `${os.hostname()}-${process.pid}`, maxAttempts = 2, pollMs = 1500, heartbeatMs = 5000, reapMs = 30000, log = console } = {}) {
  const defs = new Map();
  const appliers = new Map();
  const als = new AsyncLocalStorage();
  const limiter = createLimiter(slots, { timeoutMs, label });
  const durable = !!queue;
  const timeoutSec = Math.max(60, Math.round(timeoutMs / 1000));
  let counts = { queued: 0, running: 0 };

  // backwards compatible: render(fn) still runs fn in this process under the limit
  const render = (fn) => limiter(fn);
  render.durable = durable;
  render.role = role;
  render.define = (kind, def) => { defs.set(kind, def); return render; };
  // how many are rendering / waiting (pages show "Waiting for N other videos")
  render.stats = () => (durable ? { active: counts.running, waiting: counts.queued, slots: counts.running + 1, queued: true } : limiter.stats());
  // Side effects a job has outside its folder (History records, spend) are recorded on the worker and repeated by
  // the web service when the job is copied back, so its History and spend ledger stay the only ones.
  render.capture = (name, fn) => {
    appliers.set(name, fn);
    if (role !== "worker") return fn;
    // inside a job only recorded: the worker never writes its own History / spend files (on a shared DATA_DIR they
    // would overwrite the web service's)
    return (...args) => { const c = als.getStore(); if (!c) return fn(...args); c.effects.push({ name, args: plain(args) }); };
  };

  const stateOf = (def, payload) => { try { return def.state ? def.state(payload) : null; } catch { return null; } };
  const applyState = (def, payload, st) => {
    if (!st || !def.setState) return;
    const cur = stateOf(def, payload);
    if (cur && typeof cur === "object") Object.assign(cur, st); else def.setState(payload, { ...st });
  };
  const onError = async (def, payload, e) => { try { await (def.onError && def.onError(payload, e)); } catch (x) { log.error("render onError:", x.message); } };

  // ---------------------------------------------------------------- web
  const watching = new Map(); // job id -> [resolve]
  render.submit = (kind, payload) => {
    const def = defs.get(kind);
    if (!def) return Promise.reject(new Error(`Unknown render job "${kind}"`));
    if (!durable) return limiter(() => def.run(payload)).catch((e) => onError(def, payload, e));
    return (async () => {
      if (def.prepare) await def.prepare(payload);
      await storage.pushMissing(def.inputs ? def.inputs(payload) : []);
      const row = await queue.enqueue({ kind, payload: { ...payload, _state: plain(stateOf(def, payload)) }, maxAttempts, timeoutSec });
      counts.queued++;
      return new Promise((resolve) => watching.set(row.id, [...(watching.get(row.id) || []), resolve]));
    })().catch((e) => { log.error(`render ${kind}:`, e.message); return onError(def, payload, new Error("Couldn't start rendering: " + e.message)); });
  };

  // copy a finished job back: files, final state, side effects. Only one caller gets each job (finalize).
  async function finish(row) {
    const got = await queue.finalize(row.id);
    if (!got) return true;
    const def = defs.get(got.kind);
    const { _state, ...payload } = got.payload || {};
    const res = got.result || {};
    try {
      await storage.pull(res.changed || [], res.removed || []);
    } catch (e) { await queue.unfinalize(got.id); log.error("render: copying back", got.id, "failed:", e.message); return false; }
    if (res.state) applyState(def, payload, res.state);
    for (const fx of res.effects || []) { try { appliers.get(fx.name)?.(...(fx.args || [])); } catch (e) { log.error("render effect", fx.name, e.message); } }
    if (got.status !== "completed" && !res.handled) await onError(def, payload, new Error(got.error || (got.status === "cancelled" ? "Cancelled." : "Rendering failed.")));
    return true;
  }

  async function tick() {
    try {
      const rows = await queue.getMany([...watching.keys()]);
      for (const row of rows) {
        const def = defs.get(row.kind);
        if (!def) continue;
        if (row.status === "queued" || row.status === "running") {
          if (row.progress && row.progress.state) { const { _state, ...payload } = row.payload || {}; applyState(def, payload, row.progress.state); }
          continue;
        }
        if (await finish(row)) { for (const r of watching.get(row.id) || []) r(); watching.delete(row.id); }
      }
      // rows that are gone (pruned) or finalized elsewhere
      const seen = new Set(rows.filter((r) => !r.finalized_at).map((r) => r.id));
      for (const id of [...watching.keys()]) if (!seen.has(id)) { for (const r of watching.get(id)) r(); watching.delete(id); }
      counts = await queue.counts();
    } catch (e) { log.error("render watcher:", e.message); }
  }

  let watcherOn = false;
  render.stopWatcher = () => { watcherOn = false; };
  render.startWatcher = async () => {
    if (!durable || watcherOn) return;
    watcherOn = true;
    // jobs started before a restart of this service are picked up again
    for (const row of await queue.open()) if (defs.has(row.kind) && !watching.has(row.id)) watching.set(row.id, []);
    let n = 0;
    const loop = async () => {
      if (!watcherOn) return;
      await tick();
      if (++n % Math.max(1, Math.round(reapMs / pollMs)) === 0) await queue.reap().catch(() => {}); // also frees stuck jobs when no worker is up
      if (n % Math.round(86400000 / pollMs) === 0) await queue.prune(30).catch(() => {});
      if (watcherOn) setTimeout(loop, pollMs).unref();
    };
    loop();
  };

  // ---------------------------------------------------------------- worker
  const inUse = new Map(); // local path -> jobs using it (inputs shared by two jobs on this worker stay until both finish)
  const hold = (rels) => rels.forEach((r) => inUse.set(r, (inUse.get(r) || 0) + 1));
  const letGo = (rels) => {
    for (const r of rels) {
      const n = (inUse.get(r) || 1) - 1;
      if (n > 0) { inUse.set(r, n); continue; }
      inUse.delete(r);
      if (storage.shared) continue; // one disk for web and worker: the files are the web's own
      try {
        if (r.endsWith("/")) fs.rmSync(path.join(storage.root, r), { recursive: true, force: true });
        else for (const f of localFiles(storage.root, r)) fs.rmSync(path.join(storage.root, f), { force: true });
      } catch {}
    }
  };

  const active = new Map(); // job id -> row
  async function runJob(row) {
    const def = defs.get(row.kind);
    if (!def) return queue.fail(row.id, row.lock_token, `This worker can't run "${row.kind}" jobs.`, { retry: false });
    const { _state, ...payload } = row.payload || {};
    const ctx = { effects: [...((row.result && row.result.effects) || [])] }; // a retried job keeps the earlier attempt's spend
    const inputs = def.inputs ? def.inputs(payload) : [], outputs = def.outputs ? def.outputs(payload) : [];
    let lost = false;
    const sendBeat = () => queue.heartbeat(row.id, row.lock_token, { state: plain(stateOf(def, payload)) })
      .then((ok) => { if (!ok) lost = true; }).catch((e) => log.error("heartbeat:", e.message));
    const beat = setInterval(sendBeat, heartbeatMs);
    hold([...inputs, ...outputs]);
    try {
      if (def.setState) def.setState(payload, { ...(_state || {}) });
      await storage.pullMissing([...inputs, ...outputs]);
      const before = storage.snapshot(outputs);
      sendBeat(); // the page shows the job as started on a worker straight away
      let err = null, timer;
      try {
        await Promise.race([
          als.run(ctx, () => def.run(payload)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} took longer than ${Math.round(row.timeout_s / 60)} minutes and was stopped. Try again.`)), row.timeout_s * 1000); }),
        ]);
      } catch (e) { err = e; } finally { clearTimeout(timer); }
      if (lost) return log.warn(`render ${row.id}: taken away from this worker (timed out or cancelled)`);
      const retry = !!err && row.attempts < row.max_attempts;
      if (err && !retry) await als.run(ctx, () => onError(def, payload, err));
      if (retry) return void await queue.fail(row.id, row.lock_token, err, { result: { effects: ctx.effects } });
      const { changed, removed } = diff(before, storage.snapshot(outputs));
      await storage.push(changed, removed);
      const result = { state: plain(stateOf(def, payload)), changed, removed, effects: ctx.effects, handled: true };
      if (err) await queue.fail(row.id, row.lock_token, err, { retry: false, result });
      else await queue.complete(row.id, row.lock_token, result);
    } catch (e) { // storage or database trouble: try again later (another worker, maybe)
      log.error(`render ${row.id}:`, e.message);
      await queue.fail(row.id, row.lock_token, e, { result: { effects: ctx.effects } }).catch(() => {});
    } finally {
      clearInterval(beat);
      letGo([...inputs, ...outputs]);
    }
  }

  let stopping = false;
  render.startWorker = async ({ concurrency = slots, kinds = null } = {}) => {
    if (!durable) throw new Error("The render worker needs DATABASE_URL (the job queue).");
    if (!storage.shared) log.log(`render worker: shared storage ${storage.kind}`);
    else log.warn("render worker: no S3_BUCKET set, so files are read and written in DATA_DIR directly (only works when the web service uses the same disk)");
    log.log(`render worker ${workerId}: up to ${concurrency} job(s) at once`);
    stopping = false;
    let lastReap = 0;
    while (!stopping) {
      if (Date.now() - lastReap > reapMs) { lastReap = Date.now(); await queue.reap().catch((e) => log.error("reap:", e.message)); }
      if (active.size >= concurrency) { await sleep(250); continue; }
      let row = null;
      try { row = await queue.claim(workerId, kinds || [...defs.keys()]); } catch (e) { log.error("claim:", e.message); await sleep(pollMs * 2); continue; }
      if (!row) { await sleep(pollMs); continue; }
      log.log(`render ${row.id}: ${row.kind} (attempt ${row.attempts}/${row.max_attempts})`);
      active.set(row.id, row);
      runJob(row).catch((e) => log.error("render job:", e.message)).finally(() => active.delete(row.id));
    }
  };
  // shutting down (redeploy): stop claiming, give running jobs `drainMs` to finish, hand the rest back to the queue
  render.stopWorker = async (drainMs = 10000) => {
    stopping = true;
    const until = Date.now() + drainMs;
    while (active.size && Date.now() < until) await sleep(250);
    await Promise.all([...active.values()].map((row) => queue.release(row.id, row.lock_token).catch(() => {})));
    return active.size;
  };
  render.activeJobs = () => active.size;

  return render;
}

module.exports = { createRenderer };
