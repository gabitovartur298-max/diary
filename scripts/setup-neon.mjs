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
    )
  `);
  console.log('Neon table symptom_diary_data is ready');
} finally {
  await pool.end();
}
