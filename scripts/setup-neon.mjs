import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = new Pool({ connectionString, max: 1 });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS symptom_diary_data (
      user_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE symptom_diary_data
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      user_id TEXT PRIMARY KEY,
      trial_claimed BOOLEAN NOT NULL DEFAULT FALSE,
      trial_claimed_at TIMESTAMPTZ,
      plan_id TEXT,
      started_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS star_payments (
      charge_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      stars_amount INTEGER NOT NULL,
      days_added INTEGER NOT NULL,
      invoice_payload TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_star_payments_user_id
    ON star_payments (user_id);
  `);

  console.log('Neon tables (symptom_diary_data, user_subscriptions, star_payments) are ready');
} finally {
  await pool.end();
}
