import { readInitData, readJsonBody } from '../lib/http.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { checkPromoCodeForUser, redeemFreePromoForUser } from '../lib/subscriptions.js';
import { trackAnalyticsEvent, upsertBotUser } from '../lib/admin.js';

const ALLOWED_TRACK_EVENTS = new Set([
  'app_open',
  'stars_modal_open',
  'pdf_preview_open',
  'pdf_downloaded'
]);

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

  const body = readJsonBody(req);
  const user = getTelegramUserFromInitData(readInitData(req, body));
  if (!user) {
    return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Telegram authentication required' });
  }

  const accountId = `tg_${user.id}`;
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    await upsertBotUser({
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      languageCode: user.languageCode,
      hasStartedBot: false
    });

    if (action === 'track') {
      const eventName = typeof body.eventName === 'string' ? body.eventName : '';
      if (!ALLOWED_TRACK_EVENTS.has(eventName)) {
        return res.status(400).json({ ok: false, code: 'INVALID_EVENT', error: 'Unsupported analytics event' });
      }
      const meta = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
        ? body.meta
        : null;
      await trackAnalyticsEvent({ userId: accountId, eventName, meta });
      return res.status(200).json({ ok: true });
    }

    if (action === 'preview') {
      const check = await checkPromoCodeForUser({
        promoCode: body.promoCode,
        userId: accountId
      });
      if (!check.eligible) {
        return res.status(400).json({ ok: false, code: check.code, error: check.error });
      }
      return res.status(200).json({ ok: true, promo: check.promo });
    }

    if (action === 'redeem') {
      const result = await redeemFreePromoForUser({
        userId: accountId,
        promoCode: body.promoCode,
        planId: typeof body.planId === 'string' ? body.planId : ''
      });
      if (!result.ok) {
        return res.status(400).json({ ok: false, code: result.code, error: result.error });
      }
      await trackAnalyticsEvent({
        userId: accountId,
        eventName: 'promo_redeemed',
        meta: {
          code: result.promo.code,
          planId: result.plan.id,
          discountPercent: result.promo.discountPercent
        }
      });
      return res.status(200).json({
        ok: true,
        promo: result.promo,
        planId: result.plan.id,
        subscription: result.subscription
      });
    }

    return res.status(400).json({ ok: false, code: 'UNKNOWN_ACTION', error: 'Unknown action' });
  } catch (error) {
    console.error('[promo] Handler error:', error);
    return res.status(500).json({ ok: false, code: 'PROMO_UNAVAILABLE', error: 'Promo service unavailable' });
  }
}
