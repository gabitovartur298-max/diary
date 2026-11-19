const WINDOWS = {
  sync: { limit: 30, durationMs: 60_000 },
  pdf: { limit: 5, durationMs: 10 * 60_000 },
  subscription: { limit: 20, durationMs: 10 * 60_000 },
  account: { limit: 5, durationMs: 60 * 60_000 }
};

export async function consumeRateLimit(pool, scope, userId) {
  const rule = WINDOWS[scope];
  if (!rule) throw new Error('UNKNOWN_RATE_LIMIT_SCOPE');

  const windowId = Math.floor(Date.now() / rule.durationMs);
  const key = `${scope}:${userId}:${windowId}`;
  const expiresAt = new Date((windowId + 1) * rule.durationMs + rule.durationMs);
  const result = await pool.query(
    `INSERT INTO diary_rate_limits (rate_key, request_count, expires_at)
     VALUES ($1, 1, $2)
     ON CONFLICT (rate_key) DO UPDATE SET request_count = diary_rate_limits.request_count + 1
     RETURNING request_count, expires_at`,
    [key, expiresAt]
  );

  const count = Number(result.rows[0]?.request_count || 1);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((new Date(result.rows[0]?.expires_at || expiresAt).getTime() - Date.now()) / 1000)
  );

  if (Math.random() < 0.01) {
    pool.query('DELETE FROM diary_rate_limits WHERE expires_at < NOW()').catch(() => {});
  }

  return { allowed: count <= rule.limit, retryAfterSeconds };
}
