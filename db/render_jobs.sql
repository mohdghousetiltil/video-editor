-- Render job queue (Shorts, Story stitches, Enhance). Applied automatically at start-up by lib/jobqueue.js when
-- DATABASE_URL is set; safe to run again (everything is IF NOT EXISTS). Standalone: needs no other table.
--
-- Life of a job:  queued --claim--> running --complete--> completed
--                                     |  \--fail / timeout (attempts left)--> queued again (run_after = now + backoff)
--                                     \----fail / timeout (no attempts left)--> failed
-- Workers claim with SELECT ... FOR UPDATE SKIP LOCKED, so any number of worker replicas can pull from one table.
-- lock_token changes on every claim: a worker that lost its job (timed out, re-queued, claimed by another worker)
-- can no longer heartbeat, complete or fail it.
CREATE TABLE IF NOT EXISTS render_jobs (
  id            text PRIMARY KEY,
  kind          text NOT NULL,                       -- 'short', 'pictures', 'stitch', 'enhance'
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- what the worker needs to run it
  user_id       uuid,                                -- owner once accounts exist (app_users.id); NULL = the single user today
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  priority      smallint NOT NULL DEFAULT 0,         -- higher first
  attempts      integer NOT NULL DEFAULT 0,          -- claims so far
  max_attempts  integer NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  timeout_s     integer NOT NULL DEFAULT 1200 CHECK (timeout_s > 0), -- one attempt may run this long
  run_after     timestamptz NOT NULL DEFAULT now(),  -- not claimed before this (retry back-off)
  locked_by     text,                                -- worker id
  lock_token    uuid,
  locked_at     timestamptz,
  heartbeat_at  timestamptz,
  progress      jsonb,                               -- live state the web shows while it runs
  result        jsonb,                               -- final state, changed files, side effects (history, spend)
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  finalized_at  timestamptz                          -- the web service has copied the result back
);
CREATE INDEX IF NOT EXISTS render_jobs_ready_idx ON render_jobs (priority DESC, created_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS render_jobs_running_idx ON render_jobs (heartbeat_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS render_jobs_open_idx ON render_jobs (created_at) WHERE finalized_at IS NULL;
CREATE INDEX IF NOT EXISTS render_jobs_user_idx ON render_jobs (user_id, created_at DESC);
