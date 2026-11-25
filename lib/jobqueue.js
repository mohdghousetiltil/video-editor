// Durable render job queue in PostgreSQL (table render_jobs: db/render_jobs.sql, also in db/schema.sql).
//
//   enqueue  one pending job per ref (a double submit returns the job already there), and at most
//            `maxQueuedPerOwner` pending + running jobs per owner, so one user can't fill the queue
//   claim    SELECT ... FOR UPDATE SKIP LOCKED: any number of workers, never the same job twice. Fair between owners:
//            the owner with the fewest running jobs goes first, and no owner runs more than `maxRunningPerOwner`
//   lease    the worker heartbeats; a job whose worker went quiet for staleSec (crash, redeploy, out of memory) or that
//            ran past its timeout_s goes back to pending with back-off, until it runs out of attempts: then failed,
//            with the reason in `error`
//   finalize the web service copies a finished job back in two steps: files (repeatable) and side effects such as
//            spend (exactly once: claimEffects), so a crash half-way can't charge anything twice
//
// `db` is anything with query(text, params) -> { rows }: a pg Pool in production, PGlite in the tests.
// Each SQL statement runs on its own (autocommit), so the per-owner limits are exact for one worker and may be
// overshot by one job when two workers claim for the same owner in the same instant.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = path.join(__dirname, "..", "db", "render_jobs.sql");
const ACTIVE = `('pending','in_progress')`, DONE = `('completed','failed','cancelled')`;
const newId = () => "rj" + Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
const json = (v) => (v === undefined ? null : JSON.stringify(v));
const msg = (e) => String((e && e.message) || e || "Unknown error").slice(0, 2000);

class QueueFullError extends Error {
  constructor(limit) { super(`You already have ${limit} videos waiting or rendering. Wait for one to finish, then try again.`); this.code = "QUEUE_FULL"; this.status = 429; }
}

function createJobQueue(db, { backoffBaseSec = 15, backoffMaxSec = 300, staleSec = 90, maxRunningPerOwner = 0, maxQueuedPerOwner = 0, finalizeLeaseSec = 300 } = {}) {
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0] || null;
  // the retry delay grows with each attempt: base, 2x base, 4x base ... capped at max
  const BACKOFF = `make_interval(secs => least(${Number(backoffBaseSec)}::float8 * power(2, greatest(attempts - 1, 0)), ${Number(backoffMaxSec)}::float8))`;

  return {
    // several statements: pg runs them through query() without params, PGlite through exec()
    async migrate() { const sql = fs.readFileSync(SCHEMA, "utf8"); await (db.exec ? db.exec(sql) : db.query(sql)); },

    // -> the new job, or the job already pending / running for this ref (with deduped: true). Throws QueueFullError.
    async enqueue({ kind, ref = null, ownerId = null, payload = {}, priority = 0, maxAttempts = 2, timeoutSec = 1200, runAfterSec = 0 }) {
      if (!kind) throw new Error("enqueue: kind is required");
      const row = await one(
        `INSERT INTO render_jobs (id, kind, ref, owner_id, payload, priority, max_attempts, timeout_s, run_after)
         SELECT $1, $2, $3, $4::uuid, $5::jsonb, $6, $7, $8, now() + make_interval(secs => $9::float8)
          WHERE $10::int <= 0 OR (SELECT count(*) FROM render_jobs WHERE owner_id IS NOT DISTINCT FROM $4::uuid AND status IN ${ACTIVE}) < $10::int
         ON CONFLICT (ref) WHERE ref IS NOT NULL AND status IN ${ACTIVE} DO NOTHING
         RETURNING *`,
        [newId(), kind, ref, ownerId, json(payload), priority, Math.max(1, maxAttempts | 0), Math.max(1, timeoutSec | 0), runAfterSec, maxQueuedPerOwner]);
      if (row) return row;
      const existing = ref && await one(`SELECT * FROM render_jobs WHERE ref = $1 AND status IN ${ACTIVE}`, [ref]);
      if (existing) return { ...existing, deduped: true };
      throw new QueueFullError(maxQueuedPerOwner);
    },

    // the next job, or null. kinds: only these kinds (null = any)
    async claim(workerId, kinds = null) {
      return one(
        `UPDATE render_jobs j
            SET status = 'in_progress', attempts = j.attempts + 1, locked_by = $1, lock_token = $2::uuid,
                locked_at = now(), heartbeat_at = now(), started_at = coalesce(j.started_at, now()), error = NULL
          WHERE j.id = (
                SELECT c.id FROM render_jobs c
                  LEFT JOIN (SELECT owner_id, count(*) AS n FROM render_jobs WHERE status = 'in_progress' GROUP BY owner_id) r
                         ON r.owner_id IS NOT DISTINCT FROM c.owner_id
                 WHERE c.status = 'pending' AND c.run_after <= now()
                   AND ($3::text[] IS NULL OR c.kind = ANY($3::text[]))
                   AND ($4::int <= 0 OR coalesce(r.n, 0) < $4::int)
                 ORDER BY c.priority DESC, coalesce(r.n, 0), c.created_at, c.id
                 LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
            AND j.status = 'pending'
        RETURNING j.*`,
        [workerId, crypto.randomUUID(), kinds && kinds.length ? kinds : null, maxRunningPerOwner]);
    },

    // renews the lease (and stores the live state); false = the job is no longer ours (lease lost, cancelled)
    // result: what must not be lost if this worker dies (side effects such as spend); kept for the retry or the web
    async heartbeat(id, token, progress, result) {
      const r = await one(
        `UPDATE render_jobs SET heartbeat_at = now(), progress = coalesce($3::jsonb, progress), result = coalesce($4::jsonb, result)
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'in_progress' RETURNING id`, [id, token, json(progress), json(result)]);
      return !!r;
    },

    async complete(id, token, result) {
      return one(
        `UPDATE render_jobs SET status = 'completed', result = $3::jsonb, finished_at = now(), locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'in_progress' RETURNING *`, [id, token, json(result)]);
    },

    // failed attempt: back to pending while attempts are left (and retry is true), else failed for good
    async fail(id, token, error, { retry = true, result } = {}) {
      return one(
        `UPDATE render_jobs SET
            status      = CASE WHEN $4 AND attempts < max_attempts THEN 'pending'::job_status ELSE 'failed'::job_status END,
            run_after   = CASE WHEN $4 AND attempts < max_attempts THEN now() + ${BACKOFF} ELSE run_after END,
            finished_at = CASE WHEN $4 AND attempts < max_attempts THEN NULL ELSE now() END,
            error = $3, result = coalesce($5::jsonb, result), locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'in_progress' RETURNING *`,
        [id, token, msg(error), !!retry, json(result)]);
    },

    // a worker shutting down hands its job back without using up an attempt
    async release(id, token) {
      return one(
        `UPDATE render_jobs SET status = 'pending', attempts = greatest(attempts - 1, 0), run_after = now(),
                locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'in_progress' RETURNING *`, [id, token]);
    },

    // frees jobs whose lease ran out (no heartbeat for staleSec) or that ran longer than their own timeout_s
    async reap(stale = staleSec) {
      return q(
        `UPDATE render_jobs SET
            status      = CASE WHEN attempts < max_attempts THEN 'pending'::job_status ELSE 'failed'::job_status END,
            run_after   = CASE WHEN attempts < max_attempts THEN now() + ${BACKOFF} ELSE run_after END,
            finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
            error = CASE WHEN locked_at < now() - make_interval(secs => timeout_s)
                         THEN 'Rendering took longer than ' || round(timeout_s / 60.0) || ' minutes and was stopped.'
                         ELSE 'The render worker stopped responding (restarted or ran out of memory).' END
                    || CASE WHEN attempts < max_attempts THEN ' Trying again.' ELSE ' Tried ' || attempts || ' times.' END,
            locked_by = NULL, lock_token = NULL
          WHERE id IN (SELECT id FROM render_jobs
                        WHERE status = 'in_progress'
                          AND (heartbeat_at < now() - make_interval(secs => $1::float8) OR locked_at < now() - make_interval(secs => timeout_s))
                        FOR UPDATE SKIP LOCKED)
        RETURNING *`, [stale]);
    },

    async cancel(id) {
      return one(
        `UPDATE render_jobs SET status = 'cancelled', finished_at = now(), locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND status IN ${ACTIVE} RETURNING *`, [id]);
    },

    get: (id) => one(`SELECT * FROM render_jobs WHERE id = $1`, [id]),
    getMany: (ids) => (ids.length ? q(`SELECT * FROM render_jobs WHERE id = ANY($1::text[])`, [ids]) : Promise.resolve([])),
    // jobs the web service hasn't copied back yet (pending, running, or finished but not picked up)
    open: () => q(`SELECT * FROM render_jobs WHERE finalized_at IS NULL ORDER BY created_at`),

    // step 1 of copying a finished job back: a lease on it (one caller at a time; a caller that crashed loses it after
    // finalizeLeaseSec). Copying files is repeatable, so a second try is harmless.
    finalize: (id) => one(
      `UPDATE render_jobs SET finalize_lease_at = now()
        WHERE id = $1 AND finalized_at IS NULL AND status IN ${DONE}
          AND (finalize_lease_at IS NULL OR finalize_lease_at < now() - make_interval(secs => $2::float8)) RETURNING *`, [id, finalizeLeaseSec]),
    // step 2: the right to write History / spend, given out once per job ever (never twice, even after a crash)
    claimEffects: async (id) => !!(await one(`UPDATE render_jobs SET effects_applied_at = now() WHERE id = $1 AND effects_applied_at IS NULL RETURNING id`, [id])),
    // step 3: done
    finalized: (id) => q(`UPDATE render_jobs SET finalized_at = now() WHERE id = $1`, [id]),
    unfinalize: (id) => q(`UPDATE render_jobs SET finalize_lease_at = NULL WHERE id = $1 AND finalized_at IS NULL`, [id]),

    async counts() {
      const out = { queued: 0, running: 0 };
      for (const r of await q(`SELECT status::text AS s, count(*)::int AS n FROM render_jobs WHERE status IN ${ACTIVE} GROUP BY status`)) out[r.s === "pending" ? "queued" : "running"] = Number(r.n);
      return out;
    },
    // queue health for monitoring: depth, how long the oldest job has waited, live workers, stuck jobs, busiest owners
    async health(stale = staleSec) {
      const [h] = await q(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'pending' AND run_after <= now())::int AS ready,
                count(*) FILTER (WHERE status = 'in_progress')::int AS running,
                count(*) FILTER (WHERE status = 'in_progress' AND heartbeat_at < now() - make_interval(secs => $1::float8))::int AS stale,
                coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0)::int AS oldest_pending_sec,
                coalesce(extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'pending' AND run_after <= now())), 0)::int AS oldest_ready_sec,
                count(DISTINCT locked_by) FILTER (WHERE status = 'in_progress' AND heartbeat_at >= now() - make_interval(secs => $1::float8))::int AS busy_workers,
                count(*) FILTER (WHERE status = 'completed' AND finished_at > now() - interval '1 hour')::int AS completed_1h,
                count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '1 hour')::int AS failed_1h,
                count(*) FILTER (WHERE status IN ${DONE} AND finalized_at IS NULL)::int AS awaiting_copy_back
           FROM render_jobs WHERE status IN ${ACTIVE} OR finished_at > now() - interval '1 hour' OR finalized_at IS NULL`, [stale]);
      const owners = await q(
        `SELECT owner_id, count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'in_progress')::int AS running
           FROM render_jobs WHERE status IN ${ACTIVE} GROUP BY owner_id ORDER BY count(*) DESC LIMIT 5`);
      const lastFailure = await one(`SELECT id, kind, ref, error, finished_at FROM render_jobs WHERE status = 'failed' ORDER BY finished_at DESC NULLS LAST LIMIT 1`);
      return { ...h, owners, lastFailure, limits: { runningPerOwner: maxRunningPerOwner, queuedPerOwner: maxQueuedPerOwner } };
    },
    // forget finished jobs after a while (their files live on in storage / on disk)
    prune: (days = 30) => q(`DELETE FROM render_jobs WHERE finalized_at IS NOT NULL AND finalized_at < now() - make_interval(days => $1::int) RETURNING id`, [days]),
  };
}

// a pg Pool for DATABASE_URL. Works from anywhere the database is reachable (Railway's private network, or its public
// URL / any other host from an outside server); TLS via sslmode=require in the URL or PGSSL=1.
function connect(url, { max = 5, name = "video-studio" } = {}) {
  const { Pool } = require("pg");
  // sslmode is read here (pg would otherwise turn "require" into full certificate checks that managed hosts fail)
  const u = new URL(url), mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  const wantSsl = ["require", "verify-ca", "verify-full", "prefer"].includes(mode) || process.env.PGSSL === "1";
  const pool = new Pool({
    connectionString: u.toString(),
    ssl: wantSsl ? { rejectUnauthorized: process.env.PGSSL_VERIFY === "1" } : undefined,
    max, application_name: name,
    keepAlive: true, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
    statement_timeout: 30000, // a queue query never takes long; a hung connection must not hang a worker
  });
  pool.on("error", (e) => console.error("postgres:", e.message)); // an idle connection dropped; the pool reconnects
  return pool;
}

module.exports = { createJobQueue, connect, QueueFullError };
