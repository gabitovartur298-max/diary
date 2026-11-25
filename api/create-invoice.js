import { callTelegramApi, getTelegramUserFromInitData } from '../lib/telegram.js';
import { STARS_PLANS } from '../lib/subscriptions.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
  }

  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ ok: false, code: 'SERVER_CONFIG_ERROR', error: 'BOT_TOKEN is not configured' });
  }

  const body = parseBody(req);
  const headerInitData = req.headers['x-telegram-init-data'];
  const initData = (Array.isArray(headerInitData) ? headerInitData[0] : headerInitData) || body.initData || '';

  const user = getTelegramUserFromInitData(initData);
  if (!user) {
    return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Telegram authentication required' });
  }

  const planId = typeof body.planId === 'string' ? body.planId : '';
  const plan = Object.hasOwn(STARS_PLANS, planId) ? STARS_PLANS[planId] : null;
  if (!plan) {
    return res.status(400).json({ ok: false, code: 'UNKNOWN_PLAN', error: 'Unknown subscription plan' });
  }

  const lang = body.lang === 'en' ? 'en' : 'ru';
  const title = lang === 'en' ? plan.titleEn : plan.titleRu;
  const description = lang === 'en' ? plan.descEn : plan.descRu;
  const payload = `plan:${plan.id}:${user.id}:${Date.now()}`;

  try {
    const result = await callTelegramApi('createInvoiceLink', {
      title,
      description,
      payload,
      currency: 'XTR',
      prices: [{ label: title, amount: plan.stars }]
    });

    if (!result.ok || typeof result.data?.result !== 'string') {
      console.error('[create-invoice] Telegram API error:', result.data);
      return res.status(502).json({ ok: false, error: 'Could not create Telegram Stars invoice' });
    }

    return res.status(200).json({
      ok: true,
      invoiceUrl: result.data.result
    });
  } catch (error) {
    console.error('[create-invoice] Error:', error);
    return res.status(500).json({ ok: false, error: 'Invoice service unavailable' });
  }
}
