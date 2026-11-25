// Durable render job queue in PostgreSQL (table render_jobs, see db/render_jobs.sql).
// Any number of worker processes claim jobs with SELECT ... FOR UPDATE SKIP LOCKED, so two workers never get the
// same job. A worker heartbeats while it runs; a job whose worker went quiet (crash, redeploy, out of memory) or that
// ran past its timeout is put back in the queue (with back-off) until it runs out of attempts, then marked failed.
//
// `db` is anything with query(text, params) -> { rows }: a pg Pool in production, PGlite in the tests.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = path.join(__dirname, "..", "db", "render_jobs.sql");
const newId = () => "rj" + Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
const json = (v) => (v === undefined ? null : JSON.stringify(v));
const msg = (e) => String((e && e.message) || e || "Unknown error").slice(0, 2000);

function createJobQueue(db, { backoffBaseSec = 15, backoffMaxSec = 300, staleSec = 90 } = {}) {
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0] || null;
  // the retry delay grows with each attempt: base, 2x base, 4x base ... capped at max
  const BACKOFF = `make_interval(secs => least(${Number(backoffBaseSec)}::float8 * power(2, greatest(attempts - 1, 0)), ${Number(backoffMaxSec)}::float8))`;

  return {
    // several statements: pg runs them through query() without params, PGlite through exec()
    async migrate() { const sql = fs.readFileSync(SCHEMA, "utf8"); await (db.exec ? db.exec(sql) : db.query(sql)); },

    async enqueue({ kind, payload = {}, userId = null, priority = 0, maxAttempts = 2, timeoutSec = 1200, runAfterSec = 0 }) {
      if (!kind) throw new Error("enqueue: kind is required");
      return one(
        `INSERT INTO render_jobs (id, kind, payload, user_id, priority, max_attempts, timeout_s, run_after)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, now() + make_interval(secs => $8::float8)) RETURNING *`,
        [newId(), kind, json(payload), userId, priority, Math.max(1, maxAttempts | 0), Math.max(1, timeoutSec | 0), runAfterSec]);
    },

    // the oldest ready job (highest priority first), or null. kinds: only these kinds (null = any)
    async claim(workerId, kinds = null) {
      return one(
        `UPDATE render_jobs j
            SET status = 'running', attempts = j.attempts + 1, locked_by = $1, lock_token = $2::uuid,
                locked_at = now(), heartbeat_at = now(), started_at = coalesce(j.started_at, now()), error = NULL
          WHERE j.id = (SELECT id FROM render_jobs
                         WHERE status = 'queued' AND run_after <= now() AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
                         ORDER BY priority DESC, created_at, id
                         LIMIT 1 FOR UPDATE SKIP LOCKED)
            AND j.status = 'queued'
        RETURNING j.*`,
        [workerId, crypto.randomUUID(), kinds && kinds.length ? kinds : null]);
    },

    // still alive (and optionally the live state); false = the job is no longer ours (timed out, cancelled)
    async heartbeat(id, token, progress) {
      const r = await one(
        `UPDATE render_jobs SET heartbeat_at = now(), progress = coalesce($3::jsonb, progress)
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'running' RETURNING id`, [id, token, json(progress)]);
      return !!r;
    },

    async complete(id, token, result) {
      return one(
        `UPDATE render_jobs SET status = 'completed', result = $3::jsonb, finished_at = now(), locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'running' RETURNING *`, [id, token, json(result)]);
    },

    // failed attempt: back in the queue while attempts are left (and retry is true), else failed for good
    async fail(id, token, error, { retry = true, result } = {}) {
      return one(
        `UPDATE render_jobs SET
            status      = CASE WHEN $4 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
            run_after   = CASE WHEN $4 AND attempts < max_attempts THEN now() + ${BACKOFF} ELSE run_after END,
            finished_at = CASE WHEN $4 AND attempts < max_attempts THEN NULL ELSE now() END,
            error = $3, result = coalesce($5::jsonb, result), locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'running' RETURNING *`,
        [id, token, msg(error), !!retry, json(result)]);
    },

    // a worker shutting down hands its job back without using up an attempt
    async release(id, token) {
      return one(
        `UPDATE render_jobs SET status = 'queued', attempts = greatest(attempts - 1, 0), run_after = now(),
                locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND lock_token = $2::uuid AND status = 'running' RETURNING *`, [id, token]);
    },

    // frees jobs whose worker went quiet for staleSec, or that ran longer than their own timeout_s
    async reap(stale = staleSec) {
      return q(
        `UPDATE render_jobs SET
            status      = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
            run_after   = CASE WHEN attempts < max_attempts THEN now() + ${BACKOFF} ELSE run_after END,
            finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
            error = CASE WHEN locked_at < now() - make_interval(secs => timeout_s)
                         THEN 'Rendering took longer than ' || round(timeout_s / 60.0) || ' minutes and was stopped.'
                         ELSE 'The render worker stopped responding (restarted or ran out of memory).' END,
            locked_by = NULL, lock_token = NULL
          WHERE id IN (SELECT id FROM render_jobs
                        WHERE status = 'running'
                          AND (heartbeat_at < now() - make_interval(secs => $1::float8) OR locked_at < now() - make_interval(secs => timeout_s))
                        FOR UPDATE SKIP LOCKED)
        RETURNING *`, [stale]);
    },

    async cancel(id) {
      return one(
        `UPDATE render_jobs SET status = 'cancelled', finished_at = now(), locked_by = NULL, lock_token = NULL
          WHERE id = $1 AND status IN ('queued','running') RETURNING *`, [id]);
    },

    get: (id) => one(`SELECT * FROM render_jobs WHERE id = $1`, [id]),
    getMany: (ids) => (ids.length ? q(`SELECT * FROM render_jobs WHERE id = ANY($1::text[])`, [ids]) : Promise.resolve([])),
    // jobs the web service hasn't copied back yet (running, waiting, or finished but not picked up)
    open: () => q(`SELECT * FROM render_jobs WHERE finalized_at IS NULL ORDER BY created_at`),
    // claim the right to copy a finished job back (only one caller gets the row)
    finalize: (id) => one(
      `UPDATE render_jobs SET finalized_at = now()
        WHERE id = $1 AND finalized_at IS NULL AND status IN ('completed','failed','cancelled') RETURNING *`, [id]),
    unfinalize: (id) => q(`UPDATE render_jobs SET finalized_at = NULL WHERE id = $1`, [id]),
    async counts() {
      const out = { queued: 0, running: 0 };
      for (const r of await q(`SELECT status, count(*)::int AS n FROM render_jobs WHERE status IN ('queued','running') GROUP BY status`)) out[r.status] = Number(r.n);
      return out;
    },
    // forget finished jobs after a while (their files live on in storage / on disk)
    prune: (days = 30) => q(`DELETE FROM render_jobs WHERE finalized_at IS NOT NULL AND finalized_at < now() - make_interval(days => $1::int) RETURNING id`, [days]),
  };
}

// a pg Pool for DATABASE_URL (pg is only loaded when a database is configured)
function connect(url, { max = 5 } = {}) {
  const { Pool } = require("pg");
  const ssl = /sslmode=(require|verify)/.test(url) || process.env.PGSSL === "1" ? { rejectUnauthorized: process.env.PGSSL_VERIFY === "1" } : undefined;
  const pool = new Pool({ connectionString: url, max, ssl });
  pool.on("error", (e) => console.error("postgres:", e.message)); // an idle connection dropped; the pool reconnects
  return pool;
}

module.exports = { createJobQueue, connect };
