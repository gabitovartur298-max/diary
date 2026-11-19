import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { ensureDatabaseSchema, getPool } from '../lib/db/index.js';
import { consumeRateLimit } from '../lib/rate-limit.js';
import { claimFreeTrial, createStarsInvoice, getSubscriptionStatus, STARS_PLANS } from '../lib/subscriptions.js';

export const config = {
  api: { bodyParser: { sizeLimit: '4kb' } }
};

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

  const pool = getPool();
  if (!pool) return res.status(503).json({ ok: false, error: 'Subscription service temporarily unavailable' });

  try {
    await ensureDatabaseSchema();
    const rate = await consumeRateLimit(pool, 'subscription', user.id);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, subscription: await getSubscriptionStatus(user.id) });
    }

    const body = readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'Invalid request' });
    }

    if (body.action === 'claim-trial') {
      const result = await claimFreeTrial(user.id);
      return res.status(200).json({ ok: true, ...result });
    }

    if (body.action === 'create-invoice' && STARS_PLANS[body.planKey]) {
      const invoiceUrl = await createStarsInvoice(user.id, body.planKey);
      if (!invoiceUrl) return res.status(503).json({ ok: false, error: 'Payment service temporarily unavailable' });
      return res.status(200).json({ ok: true, invoiceUrl });
    }

    return res.status(400).json({ ok: false, error: 'Invalid subscription action' });
  } catch (error) {
    console.error('Subscription request failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(503).json({ ok: false, error: 'Subscription service temporarily unavailable' });
  }
}
