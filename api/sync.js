import { ensureDatabaseSchema, getPool } from '../lib/db/index.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { consumeRateLimit } from '../lib/rate-limit.js';
import { getDiaryPayload, syncDiaryPayload } from '../lib/diary-store.js';
import { getSubscriptionStatus } from '../lib/subscriptions.js';
import { validateDiaryPayload } from '../lib/diary-payload.js';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }
};

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function getHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value || '';
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const user = getTelegramUserFromInitData(getHeader(req, 'x-telegram-init-data'));
  if (!user) return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  const accountId = `tg_${user.id}`;
  const pool = getPool();
  if (!pool) return res.status(503).json({ ok: false, error: 'Diary sync temporarily unavailable' });

  try {
    await ensureDatabaseSchema();
    const rate = await consumeRateLimit(pool, 'sync', user.id);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    if (req.method === 'GET') {
      const [diary, subscription] = await Promise.all([
        getDiaryPayload(accountId),
        getSubscriptionStatus(user.id)
      ]);
      return res.status(200).json({ ok: true, ...diary, subscription });
    }

    const body = readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'Invalid request' });
    }

    let payload;
    try {
      const serialized = JSON.stringify(body.data);
      if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
        return res.status(413).json({ ok: false, error: 'Diary payload is too large' });
      }
      payload = validateDiaryPayload(body.data);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid diary payload' });
    }

    const [diary, subscription] = await Promise.all([
      syncDiaryPayload(accountId, payload),
      getSubscriptionStatus(user.id)
    ]);
    return res.status(200).json({ ok: true, ...diary, subscription });
  } catch (error) {
    console.error('Diary sync failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(503).json({ ok: false, error: 'Diary sync temporarily unavailable' });
  }
}
