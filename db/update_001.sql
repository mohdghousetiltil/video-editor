-- Brings a database created from an older schema.sql up to date. Safe to run more than once, and harmless on a new one.
--   psql -U postgres -d videostudio -v ON_ERROR_STOP=1 -f db/update_001.sql
BEGIN;

-- 1. influencer poses (front, left, right, back, half, full)
-- body profiles ("poses"): up to six generated pictures of the same character; the main picture stays on influencers
CREATE TABLE IF NOT EXISTS influencer_views (
  influencer_id  text NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  view           text NOT NULL CHECK (view IN ('front','left','right','back','half','full')),
  asset_id       uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  model          text,                            -- the picture model that made it
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (influencer_id, view)
);

-- 2. finished Shorts are kept 60 days, as in the app (saved settings are not changed)
ALTER TABLE user_settings ALTER COLUMN keep_shorts_days SET DEFAULT 60;

-- 3. Director budgets: the app's defaults for UGC and motion, only where the old default is still there
UPDATE director_budgets SET amount_usd = 0.80 WHERE owner_id = '00000000-0000-0000-0000-000000000001' AND page = 'ugc'    AND amount_usd = 0.50;
UPDATE director_budgets SET amount_usd = 1.00 WHERE owner_id = '00000000-0000-0000-0000-000000000001' AND page = 'motion' AND amount_usd = 0.50;

COMMIT;
