import { pool } from './index.js';
import { runSchemaSetup } from './schema-sql.js';

let schemaReadyPromise = null;

export async function ensureDatabaseSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = runSchemaSetup(pool).catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  await schemaReadyPromise;
}
