import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = globalThis.__symptomDiaryPgPool || new Pool({
  connectionString,
  max: 1
});

globalThis.__symptomDiaryPgPool = pool;

export const db = drizzle(pool, { schema });
export { pool };
