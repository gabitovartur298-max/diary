import { readInitData } from '../lib/http.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { claimFreeTrialForUser } from '../lib/subscriptions.js';
import { trackAnalyticsEvent, upsertBotUser } from '../lib/admin.js';

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

  const user = getTelegramUserFromInitData(readInitData(req));
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  }

  const accountId = `tg_${user.id}`;

  try {
    await upsertBotUser({
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      languageCode: user.languageCode,
      hasStartedBot: false
    });

    const result = await claimFreeTrialForUser(accountId);
    if (!result.alreadyClaimed) {
      await trackAnalyticsEvent({ userId: accountId, eventName: 'trial_claimed' });
    }

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
