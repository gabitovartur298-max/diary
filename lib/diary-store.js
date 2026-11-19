import { getPool } from './db/index.js';
import { decryptDiaryPayload, encryptDiaryPayload } from './encryption.js';
import { mergeDiaryPayloads, normalizeDiaryPayload, validateDiaryPayload } from './diary-payload.js';

export async function getDiaryPayload(userId) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const result = await pool.query(
    'SELECT payload, updated_at FROM symptom_diary_data WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  const row = result.rows[0];
  return {
    data: row ? normalizeDiaryPayload(decryptDiaryPayload(row.payload, userId)) : null,
    updatedAt: row?.updated_at || null
  };
}

export async function syncDiaryPayload(userId, incomingPayload) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const local = validateDiaryPayload(incomingPayload);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`diary:${userId}`]);
    const current = await client.query(
      'SELECT payload FROM symptom_diary_data WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    const remote = current.rows[0]
      ? normalizeDiaryPayload(decryptDiaryPayload(current.rows[0].payload, userId))
      : null;
    const merged = mergeDiaryPayloads(local, remote);
    const encrypted = encryptDiaryPayload(merged, userId);
    const saved = await client.query(
      `INSERT INTO symptom_diary_data (user_id, payload, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
       RETURNING updated_at`,
      [userId, encrypted]
    );
    await client.query('COMMIT');
    return { data: merged, updatedAt: saved.rows[0]?.updated_at || null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAccountData(userId) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_UNAVAILABLE');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscription:${userId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`diary:${userId}`]);
    await client.query('UPDATE diary_payments SET user_id = NULL WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM diary_subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM symptom_diary_data WHERE user_id = $1', [`tg_${userId}`]);
    await client.query('DELETE FROM diary_rate_limits WHERE rate_key LIKE $1', [`%:${userId}:%`]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
