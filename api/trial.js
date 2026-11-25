import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { claimFreeTrialForUser } from '../lib/subscriptions.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const headerInitData = req.headers['x-telegram-init-data'];
  const initData = Array.isArray(headerInitData) ? headerInitData[0] : headerInitData || '';
  const user = getTelegramUserFromInitData(initData);

  if (!user) {
    return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  }

  try {
    const result = await claimFreeTrialForUser(`tg_${user.id}`);
    return res.status(200).json({
      ok: true,
      alreadyClaimed: result.alreadyClaimed,
      subscription: result.subscription
    });
  } catch (error) {
    console.error('[trial] Error:', error);
    return res.status(500).json({ ok: false, error: 'Trial activation unavailable' });
  }
}
