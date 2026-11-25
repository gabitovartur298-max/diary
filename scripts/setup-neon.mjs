import { Pool } from 'pg';
import { runSchemaSetup } from '../lib/db/schema-sql.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = new Pool({ connectionString, max: 1 });

try {
  await runSchemaSetup(pool, { force: true });
  console.log('Neon tables (diary, subscriptions, payments, bot_users, promos, analytics) are ready');
} finally {
  await pool.end();
}
