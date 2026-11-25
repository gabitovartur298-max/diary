export const SCHEMA_PROBE_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'symptom_diary_data' AND column_name = 'version'
    ) AS has_diary_ver,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'star_payments' AND column_name = 'refunded_at'
    ) AS has_pay_ref,
    to_regclass('public.user_subscriptions') IS NOT NULL AS has_subs,
    to_regclass('public.bot_users') IS NOT NULL AS has_users,
    to_regclass('public.promo_codes') IS NOT NULL AS has_promos,
    to_regclass('public.promo_redemptions') IS NOT NULL AS has_redemptions,
    to_regclass('public.analytics_events') IS NOT NULL AS has_events
`;

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS symptom_diary_data (
    user_id TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `ALTER TABLE symptom_diary_data
   ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`,
  `CREATE TABLE IF NOT EXISTS user_subscriptions (
    user_id TEXT PRIMARY KEY,
    trial_claimed BOOLEAN NOT NULL DEFAULT FALSE,
    trial_claimed_at TIMESTAMPTZ,
    plan_id TEXT,
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE TABLE IF NOT EXISTS star_payments (
    charge_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    stars_amount INTEGER NOT NULL,
    days_added INTEGER NOT NULL,
    invoice_payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    refunded_at TIMESTAMPTZ
  );`,
  `ALTER TABLE star_payments
   ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;`,
  `CREATE INDEX IF NOT EXISTS idx_star_payments_user_id
   ON star_payments (user_id);`,
  `CREATE TABLE IF NOT EXISTS bot_users (
    telegram_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,
    has_started_bot BOOLEAN NOT NULL DEFAULT FALSE,
    bot_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS idx_bot_users_last_seen
   ON bot_users (last_seen_at DESC);`,
  `CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    discount_percent INTEGER NOT NULL,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    duration_hours INTEGER,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE TABLE IF NOT EXISTS promo_redemptions (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    discount_percent INTEGER NOT NULL,
    charge_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_code_user
   ON promo_redemptions (code, user_id);`,
  `CREATE TABLE IF NOT EXISTS analytics_events (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time
   ON analytics_events (event_name, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_events_user_name
   ON analytics_events (user_id, event_name);`
];

export async function runSchemaSetup(targetPool, { force = false } = {}) {
  if (!force) {
    const probe = await targetPool.query(SCHEMA_PROBE_SQL);
    const row = probe.rows[0] || {};
    if (
      row.has_diary_ver &&
      row.has_pay_ref &&
      row.has_subs &&
      row.has_users &&
      row.has_promos &&
      row.has_redemptions &&
      row.has_events
    ) {
      return;
    }
  }

  for (const sql of SCHEMA_STATEMENTS) {
    await targetPool.query(sql);
  }
}
