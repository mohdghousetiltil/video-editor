-- =====================================================================================================================
--  Video Studio: PostgreSQL schema (PostgreSQL 14 or newer; written and checked on 16)
--
--  What it holds, end to end:
--    people and settings   app_users, user_settings, director_budgets, cap_baselines
--    catalog               providers, ai_models, model_routes, looks, radio_stations
--    files                 assets (every picture, clip, sound and sheet; the bytes stay on disk or in object storage)
--    creative              influencers, generations (every clip, story scene, short, swap), stories, story_scenes, shorts_jobs, enhance_jobs, face_swaps
--    money                 spend_ledger (one row per paid call) + functions and views that apply the monthly cap and the daily / weekly video limits
--    safety                face swap consent is part of the table, audit_events records who did what
--
--  Money is stored in US dollars (numeric 14,6). In the app 1 credit = $1, so credits = dollars.
--  Times are timestamptz (UTC); the "day" and "week" of the video limits use the user's own time zone (user_settings.tz), weeks start on Monday.
--
--  Run:   psql -U postgres -c "CREATE DATABASE videostudio;"
--         psql -U postgres -d videostudio -f db/schema.sql
--         psql -U postgres -d videostudio -f db/seed.sql
-- =====================================================================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fast "contains" search in History titles and prompts

-- ---------------------------------------------------------------------------------------------------------------------
--  Types
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TYPE generation_kind   AS ENUM ('clip','story','scene','short','influencer','ugc','motion','swap');
CREATE TYPE job_status        AS ENUM ('pending','in_progress','completed','failed','cancelled','expired');
CREATE TYPE asset_kind        AS ENUM ('video','image','audio','character_sheet','still','frame','thumbnail','driver_clip','swap_source','music','other');
CREATE TYPE model_kind        AS ENUM ('video','image','text','tts','vision');
CREATE TYPE spend_kind        AS ENUM ('video','image','text','tts','other');
CREATE TYPE seedance_status   AS ENUM ('unknown','ok','blocked');
CREATE TYPE source_kind       AS ENUM ('upload','direct_link','page_link','pictures');
CREATE TYPE swap_engine       AS ENUM ('pixverse','wan');
CREATE TYPE ui_units          AS ENUM ('credits','usd');

-- ---------------------------------------------------------------------------------------------------------------------
--  Small helpers
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------------------------------------------------
--  People and settings
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE,
  display_name  text NOT NULL DEFAULT 'Me',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_app_users_updated BEFORE UPDATE ON app_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- one row per user: the Settings page
CREATE TABLE user_settings (
  owner_id            uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  provider_preset     text NOT NULL DEFAULT 'default',
  text_model          text,                       -- writing: plans, prompts, captions
  vision_model        text,                       -- watching videos (Shorts)
  image_model         text,                       -- character sheets, storyboard pictures
  director_model      text,                       -- the Director's brain
  voice               text NOT NULL DEFAULT 'am_michael',
  monthly_cap_usd     numeric(14,6) NOT NULL DEFAULT 10   CHECK (monthly_cap_usd >= 0),   -- 0 = no cap
  daily_video_cap_usd numeric(14,6) NOT NULL DEFAULT 1.5  CHECK (daily_video_cap_usd >= 0),
  weekly_video_cap_usd numeric(14,6) NOT NULL DEFAULT 10  CHECK (weekly_video_cap_usd >= 0),
  tz                  text NOT NULL DEFAULT 'Australia/Sydney',
  confirm_under_usd   numeric(6,2) NOT NULL DEFAULT 0 CHECK (confirm_under_usd BETWEEN 0 AND 5),
  keep_days           integer NOT NULL DEFAULT 14   CHECK (keep_days BETWEEN 1 AND 365),
  keep_shorts_days    integer NOT NULL DEFAULT 90   CHECK (keep_shorts_days BETWEEN 1 AND 3650),
  easter_eggs         boolean NOT NULL DEFAULT true,
  units               ui_units NOT NULL DEFAULT 'credits',
  hindi_mode          boolean NOT NULL DEFAULT false,
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,       -- anything new, until it earns a column
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_settings_updated BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- the Director's budget per page (single clip, story, ugc, poses, motion)
CREATE TABLE director_budgets (
  owner_id   uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  page       text NOT NULL CHECK (page IN ('clip','story','ugc','poses','motion')),
  amount_usd numeric(10,4) NOT NULL CHECK (amount_usd > 0),
  PRIMARY KEY (owner_id, page)
);

-- hidden "system reboot": the monthly cap counts from base_usd onwards for that month (the real total is never changed)
CREATE TABLE cap_baselines (
  owner_id  uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  month     date NOT NULL CHECK (month = date_trunc('month', month)::date),
  base_usd  numeric(14,6) NOT NULL CHECK (base_usd >= 0),
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, month)
);

-- ---------------------------------------------------------------------------------------------------------------------
--  Catalog
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE providers (
  id            text PRIMARY KEY,                -- 'openrouter', 'fal', 'byteplus'
  name          text NOT NULL,
  external      boolean NOT NULL DEFAULT false,  -- true = job ids carry a prefix (fal_, bp_)
  job_prefix    text,
  enabled       boolean NOT NULL DEFAULT true
);

CREATE TABLE ai_models (
  id             text PRIMARY KEY,               -- e.g. 'google/veo-3.1-lite'
  kind           model_kind NOT NULL,
  name           text NOT NULL,
  tier           text,                           -- draft | regular | premium ...
  quality        smallint CHECK (quality BETWEEN 1 AND 10),
  has_audio      boolean NOT NULL DEFAULT false, -- can the clip carry sound / speech
  speaks_hindi   boolean NOT NULL DEFAULT false, -- only Google's Veo / Gemini Omni at the moment
  durations_s    integer[],                      -- seconds the model accepts
  resolutions    text[],
  aspects        text[],
  frames         text[],                         -- 'first_frame','last_frame'
  tags           text[] NOT NULL DEFAULT '{}',
  price_sound_usd_s  numeric(10,6),              -- per second, per resolution is in price_table
  price_silent_usd_s numeric(10,6),
  price_table    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"720p":[with sound, silent], ...}
  typical_seconds int4range,                     -- how long a job usually takes
  hidden         boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  notes          text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_models_kind_idx ON ai_models (kind) WHERE active;
CREATE TRIGGER trg_ai_models_updated BEFORE UPDATE ON ai_models FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- where a model can be run besides OpenRouter, and what it costs there (the app picks the cheapest route per request)
CREATE TABLE model_routes (
  id            bigserial PRIMARY KEY,
  model_id      text NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  provider_id   text NOT NULL REFERENCES providers(id),
  remote_app    text,                            -- fal app path, or BytePlus model name
  remote_app_i2v text,                           -- image-to-video variant when it differs
  factor        numeric(6,3) NOT NULL DEFAULT 1 CHECK (factor > 0),   -- price relative to OpenRouter's
  flat_usd_s    numeric(10,6),                   -- or a flat price per second
  enabled       boolean NOT NULL DEFAULT true,
  UNIQUE (model_id, provider_id)
);

-- the Look picker (Real, Disney, Pixar ... and the ones learned from prompt study)
CREATE TABLE looks (
  id          text PRIMARY KEY,                  -- 'real','disney','horror' ...
  name        text NOT NULL,
  icon        text NOT NULL,
  swatch      text[] NOT NULL DEFAULT '{}',
  style       text NOT NULL,
  lighting    text NOT NULL,
  camera      text NOT NULL,
  avoid       text,                              -- what this look must never show (added to the prompt)
  cheap_model text REFERENCES ai_models(id),
  good_model  text REFERENCES ai_models(id),
  resolution  text NOT NULL DEFAULT '720p',
  voice       text,
  caption_style text CHECK (caption_style IN ('bold','box','minimal')),
  music_mood  text CHECK (music_mood IN ('upbeat','suspense','cinematic','chill','epic','funny','pad','none')),
  effect      text NOT NULL DEFAULT 'clean' CHECK (effect IN ('clean','glitch')),
  builtin     boolean NOT NULL DEFAULT true,
  owner_id    uuid REFERENCES app_users(id) ON DELETE CASCADE,   -- NULL = built in for everyone; set = a user's own look
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true
);
CREATE INDEX looks_sort_idx ON looks (sort_order, id) WHERE active;

CREATE TABLE user_look (
  owner_id   uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  look_id    text REFERENCES looks(id) ON DELETE SET NULL,   -- NULL = None
  locked     boolean NOT NULL DEFAULT false,
  character_description text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_look_updated BEFORE UPDATE ON user_look FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE radio_stations (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  tag        text,
  url        text NOT NULL UNIQUE,
  genre      text,                                -- 'synth','retro','electro' ...
  sort_order integer NOT NULL DEFAULT 100,
  active     boolean NOT NULL DEFAULT true
);
CREATE TABLE user_radio (
  owner_id   uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  station_id integer REFERENCES radio_stations(id) ON DELETE SET NULL,
  volume     numeric(3,2) NOT NULL DEFAULT 0.10 CHECK (volume BETWEEN 0 AND 1),
  playing    boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------------------------------------------------
--  Files (rows point at the bytes; the bytes live on disk or in S3 / R2, not in Postgres)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind         asset_kind NOT NULL,
  storage_key  text NOT NULL,                     -- path on disk or object key
  mime         text,
  bytes        bigint CHECK (bytes >= 0),
  sha256       text,
  width        integer,
  height       integer,
  duration_s   numeric(9,3),
  has_audio    boolean,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,                       -- cleanup deletes working files after keep_days
  UNIQUE (owner_id, storage_key)
);
CREATE INDEX assets_owner_kind_idx ON assets (owner_id, kind, created_at DESC);
CREATE INDEX assets_expiry_idx ON assets (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX assets_sha_idx ON assets (sha256) WHERE sha256 IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------------
--  Influencers (saved characters with a picture)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE influencers (
  id             text PRIMARY KEY DEFAULT encode(gen_random_bytes(5), 'hex'),
  owner_id       uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  seed           bigint,
  image_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  seedance       seedance_status NOT NULL DEFAULT 'unknown',   -- does Seedance accept this picture
  ai_generated   boolean NOT NULL DEFAULT true,                -- false = a real person's photo (needs the person's permission)
  permission_note text,                                        -- who said yes, when
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE TRIGGER trg_influencers_updated BEFORE UPDATE ON influencers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------
--  Stories (script -> scenes -> clips -> final video)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE stories (
  id             text PRIMARY KEY DEFAULT encode(gen_random_bytes(6), 'hex'),
  owner_id       uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title          text NOT NULL DEFAULT '',
  script         text NOT NULL DEFAULT '',
  total_seconds  integer,
  aspect         text NOT NULL DEFAULT '9:16' CHECK (aspect IN ('9:16','16:9','1:1')),
  resolution     text NOT NULL DEFAULT '720p',
  look_id        text REFERENCES looks(id) ON DELETE SET NULL,
  cheap_model    text REFERENCES ai_models(id),
  good_model     text REFERENCES ai_models(id),
  bible          text NOT NULL DEFAULT '',        -- characters + setting + "Look:" line, added to every scene
  budget_usd     numeric(10,4),
  cinematic_camera boolean NOT NULL DEFAULT true,
  narration_on   boolean NOT NULL DEFAULT true,
  narration_model text,
  narration_voice text,
  narration_tone  text,
  music_mood     text,
  ambience       text,
  cast_asset_id  uuid REFERENCES assets(id) ON DELETE SET NULL,   -- character sheet
  language       text NOT NULL DEFAULT 'en' CHECK (language IN ('en','hinglish')),
  form_state     jsonb NOT NULL DEFAULT '{}'::jsonb,              -- every field of the page, so "continue where you left off" works
  final_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','planned','generating','stitched','failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stories_owner_idx ON stories (owner_id, updated_at DESC);
CREATE TRIGGER trg_stories_updated BEFORE UPDATE ON stories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- generations is declared first below; story_scenes points at it after both exist (see ALTER at the end of this section)
CREATE TABLE generations (
  id             text PRIMARY KEY,                -- provider job id: gen-vid-..., fal_..., bp_..., or short-..., story-...
  owner_id       uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind           generation_kind NOT NULL,
  feature        text,                            -- page name as shown in the spend log: 'Single clips','Story','UGC','Poses & motion','Face swap'
  title          text NOT NULL DEFAULT '',
  prompt         text,
  negative_prompt text,
  model_id       text,                            -- not a FK: old jobs keep working after a model is retired
  provider_id    text REFERENCES providers(id),
  duration_s     numeric(7,2),
  resolution     text,
  aspect         text,
  seed           bigint,
  generate_audio boolean,
  look_id        text REFERENCES looks(id) ON DELETE SET NULL,
  influencer_id  text REFERENCES influencers(id) ON DELETE SET NULL,
  story_id       text REFERENCES stories(id) ON DELETE CASCADE,
  scene_index    integer,
  status         job_status NOT NULL DEFAULT 'pending',
  error          text,
  cost_usd       numeric(14,6) CHECK (cost_usd >= 0),
  cost_estimated boolean NOT NULL DEFAULT false,
  estimate_usd   numeric(14,6),                   -- what was reserved while the job ran (counts against the daily / weekly limit)
  polling_url    text,
  external       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- fal: {status_url, response_url}
  video_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  thumb_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  video_url      text,                            -- the provider's temporary link
  rating         smallint CHECK (rating BETWEEN 1 AND 5),
  kept           boolean NOT NULL DEFAULT false,
  retry_endpoint text,
  retry_body     jsonb,
  options        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- everything else the page sent
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX generations_owner_time_idx ON generations (owner_id, created_at DESC);
CREATE INDEX generations_owner_kind_idx ON generations (owner_id, kind, created_at DESC);
CREATE INDEX generations_open_idx       ON generations (owner_id) WHERE status IN ('pending','in_progress');
CREATE INDEX generations_story_idx      ON generations (story_id, scene_index) WHERE story_id IS NOT NULL;
CREATE INDEX generations_title_trgm     ON generations USING gin (title gin_trgm_ops);
CREATE INDEX generations_prompt_trgm    ON generations USING gin (prompt gin_trgm_ops);
CREATE TRIGGER trg_generations_updated BEFORE UPDATE ON generations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE story_scenes (
  story_id      text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  idx           integer NOT NULL CHECK (idx >= 0),
  title         text NOT NULL DEFAULT '',
  prompt        text NOT NULL,
  seconds       integer NOT NULL DEFAULT 4 CHECK (seconds BETWEEN 1 AND 15),
  is_key        boolean NOT NULL DEFAULT false,
  continues     boolean NOT NULL DEFAULT false,   -- starts from the previous scene's last frame
  narration     text NOT NULL DEFAULT '',
  sfx           text NOT NULL DEFAULT 'none',
  model_id      text,
  resolution    text,
  director_note text,
  still_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  generation_id text REFERENCES generations(id) ON DELETE SET NULL,
  PRIMARY KEY (story_id, idx)
);

-- ---------------------------------------------------------------------------------------------------------------------
--  Shorts maker, Enhance, Face swap
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE shorts_jobs (
  id              text PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  source          source_kind NOT NULL,
  source_url      text,
  source_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,       -- length, focus, voiceover, captions, music, safe margins ...
  status          job_status NOT NULL DEFAULT 'pending',
  step            text,
  progress        numeric(5,2) CHECK (progress BETWEEN 0 AND 100),
  title           text,
  description     text,
  hook            text,
  thumbnail_text  text,
  hashtags        text[],
  captions        jsonb,
  voiceover       text,
  language        text NOT NULL DEFAULT 'en',
  output_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  thumb_asset_id  uuid REFERENCES assets(id) ON DELETE SET NULL,
  cost_usd        numeric(14,6) NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shorts_owner_idx ON shorts_jobs (owner_id, created_at DESC);
CREATE TRIGGER trg_shorts_updated BEFORE UPDATE ON shorts_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE enhance_jobs (
  id              text PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  source_generation_id text REFERENCES generations(id) ON DELETE SET NULL,
  source_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  upscale         text NOT NULL DEFAULT 'none' CHECK (upscale IN ('none','720p','1080p')),
  sharpen         boolean NOT NULL DEFAULT true,
  denoise         boolean NOT NULL DEFAULT true,
  smooth          boolean NOT NULL DEFAULT false,
  grade           text NOT NULL DEFAULT 'none' CHECK (grade IN ('none','cinematic','warm','cool','vivid','retro','bw')),
  music_mood      text,
  status          job_status NOT NULL DEFAULT 'pending',
  step            text,
  from_size       text,
  to_size         text,
  result_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX enhance_owner_idx ON enhance_jobs (owner_id, created_at DESC);

-- one row per face swap; the consent is part of the row and cannot be false
CREATE TABLE face_swaps (
  generation_id    text PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  engine           swap_engine NOT NULL,
  source_asset_id  uuid REFERENCES assets(id) ON DELETE SET NULL,   -- the video that was edited
  source_link      text,                                            -- where it came from, when it was a link
  face_influencer_id text REFERENCES influencers(id) ON DELETE SET NULL,
  face_asset_id    uuid REFERENCES assets(id) ON DELETE SET NULL,
  consent          boolean NOT NULL DEFAULT true CHECK (consent IS TRUE),
  consent_text     text NOT NULL DEFAULT 'The face is mine, or I have that person''s permission, and I have the right to edit this video.',
  consented_at     timestamptz NOT NULL DEFAULT now(),
  client_ip        inet,
  user_agent       text,
  CHECK (face_influencer_id IS NOT NULL OR face_asset_id IS NOT NULL)
);
CREATE INDEX face_swaps_owner_idx ON face_swaps (owner_id, consented_at DESC);

-- a driving clip for "Copy motion" (shared with the provider through a temporary link)
CREATE TABLE driver_clips (
  token       text PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  asset_id    uuid REFERENCES assets(id) ON DELETE CASCADE,
  source_link text,
  duration_s  numeric(7,2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '1 day'
);

-- ---------------------------------------------------------------------------------------------------------------------
--  Money
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE spend_ledger (
  id            bigserial PRIMARY KEY,
  owner_id      uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  t             timestamptz NOT NULL DEFAULT now(),
  feature       text NOT NULL,                    -- 'Single clips','Story','Captions','Voice','Images','Face swap' ...
  kind          spend_kind NOT NULL DEFAULT 'other',
  model_id      text,
  provider_id   text REFERENCES providers(id),
  generation_id text REFERENCES generations(id) ON DELETE SET NULL,
  cost_usd      numeric(14,6) NOT NULL CHECK (cost_usd >= 0),
  estimated     boolean NOT NULL DEFAULT false    -- true when the provider didn't report the cost
);
CREATE INDEX spend_owner_time_idx    ON spend_ledger (owner_id, t DESC);
CREATE INDEX spend_owner_video_idx   ON spend_ledger (owner_id, t DESC) WHERE kind = 'video';
CREATE INDEX spend_generation_idx    ON spend_ledger (generation_id) WHERE generation_id IS NOT NULL;

CREATE TABLE audit_events (
  id         bigserial PRIMARY KEY,
  owner_id   uuid REFERENCES app_users(id) ON DELETE SET NULL,
  t          timestamptz NOT NULL DEFAULT now(),
  action     text NOT NULL,                       -- 'cap.reboot','faceswap.start','settings.change','look.change' ...
  entity     text,
  entity_id  text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_ip  inet
);
CREATE INDEX audit_owner_time_idx ON audit_events (owner_id, t DESC);
CREATE INDEX audit_action_idx     ON audit_events (action, t DESC);

-- ---------------------------------------------------------------------------------------------------------------------
--  Money functions: the same rules the app applies
-- ---------------------------------------------------------------------------------------------------------------------
-- everything spent in a calendar month (UTC month, like the spend files), all providers
CREATE OR REPLACE FUNCTION month_spend(p_owner uuid, p_month date DEFAULT date_trunc('month', now())::date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(cost_usd), 0)
  FROM spend_ledger
  WHERE owner_id = p_owner
    AND t >= p_month::timestamptz AND t < (p_month + interval '1 month')::timestamptz
$$;

-- what the cap counts: the month's spend minus the baseline set by a "system reboot" (never below zero)
CREATE OR REPLACE FUNCTION cap_used(p_owner uuid, p_month date DEFAULT date_trunc('month', now())::date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT GREATEST(0, month_spend(p_owner, p_month) - COALESCE((SELECT base_usd FROM cap_baselines WHERE owner_id = p_owner AND month = p_month), 0))
$$;

-- NULL = allowed, otherwise the sentence to show the user
CREATE OR REPLACE FUNCTION cap_block(p_owner uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN s.monthly_cap_usd > 0 AND cap_used(p_owner) >= s.monthly_cap_usd
              THEN format('Monthly spending cap reached: %s of %s used this month. Raise the cap in Settings to keep going.',
                          to_char(cap_used(p_owner), 'FM999990.00'), to_char(s.monthly_cap_usd, 'FM999990.00'))
         END
  FROM user_settings s WHERE s.owner_id = p_owner
$$;

-- the "system reboot" gesture: the cap counts from now on (the real total is kept)
CREATE OR REPLACE FUNCTION system_reboot(p_owner uuid) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v_base numeric; v_month date := date_trunc('month', now())::date;
BEGIN
  v_base := month_spend(p_owner, v_month);
  INSERT INTO cap_baselines (owner_id, month, base_usd) VALUES (p_owner, v_month, v_base)
    ON CONFLICT (owner_id, month) DO UPDATE SET base_usd = EXCLUDED.base_usd, set_at = now();
  INSERT INTO audit_events (owner_id, action, entity, detail) VALUES (p_owner, 'cap.reboot', 'cap_baselines', jsonb_build_object('base_usd', v_base));
  RETURN v_base;
END $$;

-- video money spent today and this week (Monday start) in the user's time zone, plus jobs still running (their reserved estimate)
CREATE OR REPLACE FUNCTION video_limits(p_owner uuid)
RETURNS TABLE (today_usd numeric, week_usd numeric, pending_usd numeric, daily_cap numeric, weekly_cap numeric, daily_left numeric, weekly_left numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE s user_settings; v_day_start timestamptz; v_week_start timestamptz; v_local timestamp;
BEGIN
  SELECT * INTO s FROM user_settings WHERE owner_id = p_owner;
  v_local := now() AT TIME ZONE s.tz;
  v_day_start  := date_trunc('day', v_local) AT TIME ZONE s.tz;
  v_week_start := date_trunc('week', v_local) AT TIME ZONE s.tz;      -- date_trunc('week') starts on Monday
  RETURN QUERY
  WITH sp AS (
    SELECT COALESCE(sum(cost_usd) FILTER (WHERE t >= v_day_start), 0) AS d, COALESCE(sum(cost_usd) FILTER (WHERE t >= v_week_start), 0) AS w
    FROM spend_ledger WHERE owner_id = p_owner AND kind = 'video' AND t >= v_week_start),
  pe AS (
    SELECT COALESCE(sum(estimate_usd), 0) AS p FROM generations
    WHERE owner_id = p_owner AND status IN ('pending','in_progress') AND estimate_usd > 0 AND started_at > now() - interval '3 hours')
  SELECT sp.d, sp.w, pe.p, s.daily_video_cap_usd, s.weekly_video_cap_usd,
         CASE WHEN s.daily_video_cap_usd  > 0 THEN GREATEST(0, s.daily_video_cap_usd  - sp.d - pe.p) END,
         CASE WHEN s.weekly_video_cap_usd > 0 THEN GREATEST(0, s.weekly_video_cap_usd - sp.w - pe.p) END
  FROM sp, pe;
END $$;

-- NULL = this video may start, otherwise why not; p_estimate = the price of the video about to start
CREATE OR REPLACE FUNCTION video_block(p_owner uuid, p_estimate numeric) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE l record;
BEGIN
  SELECT * INTO l FROM video_limits(p_owner);
  IF l.daily_cap  > 0 AND l.today_usd + l.pending_usd + p_estimate > l.daily_cap  THEN
    RETURN format('Daily video limit reached: %s of %s used today (this one costs about %s).', to_char(l.today_usd + l.pending_usd, 'FM990.00'), to_char(l.daily_cap, 'FM990.00'), to_char(p_estimate, 'FM990.00')); END IF;
  IF l.weekly_cap > 0 AND l.week_usd  + l.pending_usd + p_estimate > l.weekly_cap THEN
    RETURN format('Weekly video limit reached: %s of %s used this week (this one costs about %s).', to_char(l.week_usd + l.pending_usd, 'FM990.00'), to_char(l.weekly_cap, 'FM990.00'), to_char(p_estimate, 'FM990.00')); END IF;
  RETURN NULL;
END $$;

-- when a job finishes: write its cost into the ledger once (the same job completing twice adds nothing)
CREATE OR REPLACE FUNCTION log_generation_spend() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') AND COALESCE(NEW.cost_usd, NEW.estimate_usd, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM spend_ledger WHERE generation_id = NEW.id) THEN
    INSERT INTO spend_ledger (owner_id, t, feature, kind, model_id, provider_id, generation_id, cost_usd, estimated)
    VALUES (NEW.owner_id, now(), COALESCE(NEW.feature, 'Video clips'), 'video', NEW.model_id, NEW.provider_id, NEW.id,
            COALESCE(NEW.cost_usd, NEW.estimate_usd), NEW.cost_usd IS NULL OR NEW.cost_estimated);
    NEW.finished_at := COALESCE(NEW.finished_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_generations_spend BEFORE UPDATE ON generations FOR EACH ROW EXECUTE FUNCTION log_generation_spend();

-- ---------------------------------------------------------------------------------------------------------------------
--  Views the pages read
-- ---------------------------------------------------------------------------------------------------------------------
-- the spend card: used, cap, left, plus credits (1 credit = $1)
CREATE OR REPLACE VIEW v_credits AS
SELECT u.id AS owner_id,
       month_spend(u.id)                           AS month_total_usd,
       cap_used(u.id)                              AS cap_used_usd,
       s.monthly_cap_usd                           AS cap_usd,
       CASE WHEN s.monthly_cap_usd > 0 THEN GREATEST(0, s.monthly_cap_usd - cap_used(u.id)) END AS cap_left_usd,
       cap_block(u.id)                             AS blocked_reason
FROM app_users u JOIN user_settings s ON s.owner_id = u.id;

-- by feature and by day for the spend dialog (this month)
CREATE OR REPLACE VIEW v_spend_by_feature AS
SELECT owner_id, date_trunc('month', t)::date AS month, feature, count(*) AS calls, sum(cost_usd) AS cost_usd
FROM spend_ledger GROUP BY owner_id, date_trunc('month', t), feature;

CREATE OR REPLACE VIEW v_spend_by_day AS
SELECT owner_id, (t AT TIME ZONE 'UTC')::date AS day, sum(cost_usd) AS cost_usd, sum(cost_usd) FILTER (WHERE kind = 'video') AS video_usd
FROM spend_ledger GROUP BY owner_id, (t AT TIME ZONE 'UTC')::date;

CREATE OR REPLACE VIEW v_spend_by_provider AS
SELECT owner_id, date_trunc('month', t)::date AS month, COALESCE(provider_id, 'openrouter') AS provider_id, sum(cost_usd) AS cost_usd
FROM spend_ledger GROUP BY owner_id, date_trunc('month', t), COALESCE(provider_id, 'openrouter');

-- History page: everything the user made, newest first, with the joined file links
CREATE OR REPLACE VIEW v_history AS
SELECT g.id, g.owner_id, g.kind, g.title, g.status, g.error, g.model_id, g.provider_id, g.duration_s, g.resolution,
       g.cost_usd, g.cost_estimated, g.rating, g.kept, g.created_at,
       va.storage_key AS video_key, ta.storage_key AS thumb_key, g.retry_endpoint, g.retry_body
FROM generations g
LEFT JOIN assets va ON va.id = g.video_asset_id
LEFT JOIN assets ta ON ta.id = g.thumb_asset_id;

-- the Director's catalog: a model with every route and its cheapest per-second price
CREATE OR REPLACE VIEW v_model_prices AS
SELECT m.id, m.name, m.kind, m.has_audio, m.speaks_hindi, m.quality, m.price_sound_usd_s, m.price_silent_usd_s,
       r.provider_id AS alt_provider, r.flat_usd_s AS alt_flat_usd_s, r.factor AS alt_factor,
       NULLIF(LEAST(COALESCE(m.price_sound_usd_s, 1e9), COALESCE(r.flat_usd_s, m.price_sound_usd_s * r.factor, 1e9)), 1e9) AS cheapest_sound_usd_s
FROM ai_models m LEFT JOIN model_routes r ON r.model_id = m.id AND r.enabled
WHERE m.active AND NOT m.hidden;

-- ---------------------------------------------------------------------------------------------------------------------
--  Housekeeping: delete expired working files rows (the app removes the bytes, then calls this)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_expired_assets() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM assets WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM driver_clips WHERE expires_at < now();
  RETURN n;
END $$;

COMMIT;
