import { attachDatabasePool } from '@vercel/functions';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = globalThis.__symptomDiaryPgPool || new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000
});

if (!globalThis.__symptomDiaryPgPool) {
  pool.on('error', (error) => {
    console.error('[db] Unexpected idle PG client error:', error);
  });
  attachDatabasePool(pool);
  globalThis.__symptomDiaryPgPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
