import { readInitData, readJsonBody } from '../lib/http.js';
import { callTelegramApi, getTelegramUserFromInitData } from '../lib/telegram.js';
import {
  STARS_PLANS,
  buildPaymentPayload,
  checkPromoCodeForUser,
  computeDiscountedStars
} from '../lib/subscriptions.js';
import { trackAnalyticsEvent, upsertBotUser } from '../lib/admin.js';

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

  const body = readJsonBody(req);
  const user = getTelegramUserFromInitData(readInitData(req, body));
  if (!user) {
    return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Telegram authentication required' });
  }

  const planId = typeof body.planId === 'string' ? body.planId : '';
  const plan = Object.hasOwn(STARS_PLANS, planId) ? STARS_PLANS[planId] : null;
  if (!plan) {
    return res.status(400).json({ ok: false, code: 'UNKNOWN_PLAN', error: 'Unknown subscription plan' });
  }

  const accountId = `tg_${user.id}`;
  const lang = body.lang === 'en' ? 'en' : 'ru';
  let finalStars = plan.stars;
  let validatedPromo = null;

  try {
    await upsertBotUser({
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      languageCode: user.languageCode,
      hasStartedBot: false
    });

    if (typeof body.promoCode === 'string' && body.promoCode.trim()) {
      const check = await checkPromoCodeForUser({
        promoCode: body.promoCode,
        userId: accountId
      });
      if (!check.eligible) {
        return res.status(400).json({ ok: false, code: check.code, error: check.error });
      }
      if (check.promo.discountPercent >= 100) {
        return res.status(400).json({
          ok: false,
          code: 'PROMO_FREE_USE_REDEEM',
          error: '100% promo codes activate directly without a Stars invoice'
        });
      }
      validatedPromo = check.promo;
      finalStars = computeDiscountedStars(plan.stars, validatedPromo.discountPercent);
    }

    const baseTitle = lang === 'en' ? plan.titleEn : plan.titleRu;
    const title = validatedPromo ? `${baseTitle} (-${validatedPromo.discountPercent}%)` : baseTitle;
    const description = lang === 'en' ? plan.descEn : plan.descRu;
    const payload = buildPaymentPayload({
      planId: plan.id,
      userId: user.id,
      promoCode: validatedPromo ? validatedPromo.code : ''
    });

    const result = await callTelegramApi('createInvoiceLink', {
      title: title.slice(0, 32),
      description,
      payload,
      currency: 'XTR',
      prices: [{ label: title.slice(0, 32), amount: finalStars }]
    });

    if (!result.ok || typeof result.data?.result !== 'string') {
      console.error('[create-invoice] Telegram API error:', result.data);
      return res.status(502).json({ ok: false, error: 'Could not create Telegram Stars invoice' });
    }

    await trackAnalyticsEvent({
      userId: accountId,
      eventName: 'invoice_created',
      meta: {
        planId: plan.id,
        stars: finalStars,
        promoCode: validatedPromo ? validatedPromo.code : null
      }
    });

    return res.status(200).json({
      ok: true,
      invoiceUrl: result.data.result,
      finalStars,
      promoCode: validatedPromo ? validatedPromo.code : null
    });
  } catch (error) {
    console.error('[create-invoice] Error:', error);
    return res.status(500).json({ ok: false, error: 'Invoice service unavailable' });
  }
}
