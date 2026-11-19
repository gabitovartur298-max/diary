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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS diary_subscriptions (
      user_id TEXT PRIMARY KEY,
      plan_id TEXT,
      started_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      trial_claimed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS diary_payments (
      telegram_payment_charge_id TEXT PRIMARY KEY,
      user_id TEXT,
      plan_id TEXT NOT NULL,
      stars_amount INTEGER NOT NULL,
      provider_payment_charge_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS diary_rate_limits (
      rate_key TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS diary_rate_limits_expires_idx ON diary_rate_limits (expires_at);
  `);
  console.log('Neon tables for diary data, subscriptions, payments, and rate limits are ready');
} finally {
  await pool.end();
}
