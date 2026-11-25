-- Render job queue (Shorts, Story stitches, Enhance). Part of the main model (db/schema.sql has the same table);
-- this file stands alone so the app can create it at start-up when DATABASE_URL is set. Safe to run again.
-- It reuses the schema's job_status type and owner_id -> app_users (the foreign key is added once app_users exists).
--
-- Life of a job:  pending --claim--> in_progress --complete--> completed
--                                       |  \--fail / lease lost (attempts left)--> pending again (run_after = now + back-off)
--                                       \----fail / lease lost (no attempts left)--> failed (error says why)
-- Workers claim with SELECT ... FOR UPDATE SKIP LOCKED, fairly between owners (fewest running first, and at most
-- N running per owner). lock_token changes on every claim, so a worker that lost its lease can't touch the job again.
-- ref is the app record being rendered (short-<id>, story-<id>, enh-<id>: the same ids as generations.id / History);
-- only one pending or running job per ref can exist, so a double submit never renders twice.
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('pending','in_progress','completed','failed','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS render_jobs (
  id                 text PRIMARY KEY,
  kind               text NOT NULL,                       -- 'short', 'pictures', 'stitch', 'enhance'
  ref                text,                                -- the app record: short-<id>, story-<id>, enh-<id>
  owner_id           uuid,                                -- app_users.id; NULL until accounts exist (the single owner)
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- what the worker needs to run it
  status             job_status NOT NULL DEFAULT 'pending' CHECK (status <> 'expired'),
  priority           smallint NOT NULL DEFAULT 0,         -- higher first
  attempts           integer NOT NULL DEFAULT 0,          -- claims so far
  max_attempts       integer NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  timeout_s          integer NOT NULL DEFAULT 1200 CHECK (timeout_s > 0), -- one attempt may run this long
  run_after          timestamptz NOT NULL DEFAULT now(),  -- not claimed before this (retry back-off)
  locked_by          text,                                -- worker id (host-pid)
  lock_token         uuid,
  locked_at          timestamptz,
  heartbeat_at       timestamptz,                         -- the lease: renewed every few seconds while it runs
  progress           jsonb,                               -- live state the web shows while it runs
  result             jsonb,                               -- final state, changed files, side effects (History, spend)
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  finalize_lease_at  timestamptz,                         -- the web service is copying the result back
  effects_applied_at timestamptz,                         -- History / spend written (exactly once, never twice)
  finalized_at       timestamptz                          -- copied back, done
);
CREATE INDEX IF NOT EXISTS render_jobs_ready_idx ON render_jobs (priority DESC, created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS render_jobs_running_idx ON render_jobs (owner_id, heartbeat_at) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS render_jobs_open_idx ON render_jobs (created_at) WHERE finalized_at IS NULL;
CREATE INDEX IF NOT EXISTS render_jobs_owner_idx ON render_jobs (owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS render_jobs_active_ref_idx ON render_jobs (ref) WHERE ref IS NOT NULL AND status IN ('pending','in_progress');

-- owner_id -> app_users when the full schema is loaded (not needed for the queue to work)
DO $$ BEGIN
  IF to_regclass('app_users') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'render_jobs'::regclass AND contype = 'f') THEN
    ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_owner_fk FOREIGN KEY (owner_id) REFERENCES app_users(id) ON DELETE CASCADE;
  END IF;
END $$;
