import { ensureDatabaseSchema, getPool } from '../lib/db/index.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { consumeRateLimit } from '../lib/rate-limit.js';
import { deleteAccountData } from '../lib/diary-store.js';

export const config = {
  api: { bodyParser: false }
};

function getInitData(req) {
  const value = req.headers['x-telegram-init-data'];
  return Array.isArray(value) ? value[0] : value || '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const user = getTelegramUserFromInitData(getInitData(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  const pool = getPool();
  if (!pool) return res.status(503).json({ ok: false, error: 'Account service temporarily unavailable' });

  try {
    await ensureDatabaseSchema();
    const rate = await consumeRateLimit(pool, 'account', user.id);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }
    await deleteAccountData(user.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Account deletion failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(503).json({ ok: false, error: 'Account deletion temporarily unavailable' });
  }
}
