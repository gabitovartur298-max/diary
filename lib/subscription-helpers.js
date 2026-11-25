export const TRIAL_DAYS = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const STARS_PLANS = {
  '1m': {
    id: '1m',
    stars: 50,
    days: 30,
    titleRu: 'PRO на 30 дней',
    descRu: 'Точное время записей и безлимитный экспорт PDF для врача (30 дней)',
    titleEn: 'PRO for 30 Days',
    descEn: 'Exact symptom timestamps and unlimited doctor PDF exports (30 days)'
  },
  '6m': {
    id: '6m',
    stars: 250,
    days: 180,
    titleRu: 'PRO на 180 дней',
    descRu: 'Точное время записей и безлимитный экспорт PDF для врача (180 дней)',
    titleEn: 'PRO for 180 Days',
    descEn: 'Exact symptom timestamps and unlimited doctor PDF exports (180 days)'
  },
  '12m': {
    id: '12m',
    stars: 500,
    days: 360,
    titleRu: 'PRO на 360 дней',
    descRu: 'Точное время записей и безлимитный экспорт PDF для врача (360 дней)',
    titleEn: 'PRO for 360 Days',
    descEn: 'Exact symptom timestamps and unlimited doctor PDF exports (360 days)'
  }
};

export function normalizePromoCode(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().toUpperCase();
  return /^[A-Z0-9_-]{3,32}$/.test(cleaned) ? cleaned : '';
}

export function computeDiscountedStars(baseStars, discountPercent) {
  const base = Number(baseStars);
  const pct = Number(discountPercent);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return Math.round(base);
  if (pct >= 100) return 0;
  return Math.max(1, Math.round((base * (100 - pct)) / 100));
}

export function buildPaymentPayload({ planId, userId, promoCode = '', ts = Date.now() }) {
  const code = normalizePromoCode(promoCode);
  return code
    ? `plan:${planId}:p:${code}:${userId}:${ts}`
    : `plan:${planId}:${userId}:${ts}`;
}

export function parsePaymentPayload(invoicePayload) {
  if (typeof invoicePayload !== 'string' || !invoicePayload.startsWith('plan:')) {
    return { planId: null, promoCode: null };
  }
  const parts = invoicePayload.split(':');
  const planId = parts[1] || null;
  if (parts[2] === 'p') {
    const promoCode = normalizePromoCode(parts[3] || '');
    return { planId, promoCode: promoCode || null };
  }
  return { planId, promoCode: null };
}

export function resolvePlanFromPayment(invoicePayload, totalAmount, { expectedDiscountPercent = null } = {}) {
  const amount = Number(totalAmount);
  if (!Number.isInteger(amount) || amount <= 0) return null;

  if (typeof invoicePayload === 'string' && invoicePayload.startsWith('plan:')) {
    const { planId, promoCode } = parsePaymentPayload(invoicePayload);
    const plan = planId && Object.hasOwn(STARS_PLANS, planId) ? STARS_PLANS[planId] : null;
    if (!plan) return null;

    if (promoCode) {
      const pct = Number(expectedDiscountPercent);
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
        return null;
      }
      return computeDiscountedStars(plan.stars, pct) === amount ? plan : null;
    }

    return plan.stars === amount ? plan : null;
  }

  // Совместимость со старыми статическими ссылками (если кто-то откроет старый инвойс)
  return Object.values(STARS_PLANS).find((p) => p.stars === amount) || null;
}

export function evaluatePromoEligibility(promoRow, { alreadyRedeemed = false, nowMs = Date.now() } = {}) {
  if (!promoRow) {
    return { eligible: false, code: 'PROMO_NOT_FOUND', error: 'Promo code not found' };
  }
  if (!promoRow.isActive) {
    return { eligible: false, code: 'PROMO_INACTIVE', error: 'Promo code is inactive' };
  }
  const expiresAtMs = promoRow.expiresAt ? new Date(promoRow.expiresAt).getTime() : null;
  if (expiresAtMs && expiresAtMs <= nowMs) {
    return { eligible: false, code: 'PROMO_EXPIRED', error: 'Promo code has expired' };
  }
  const maxUses = promoRow.maxUses === null || promoRow.maxUses === undefined ? null : Number(promoRow.maxUses);
  const usedCount = Number(promoRow.usedCount || 0);
  if (maxUses !== null && usedCount >= maxUses) {
    return { eligible: false, code: 'PROMO_EXHAUSTED', error: 'Promo code activation limit reached' };
  }
  if (alreadyRedeemed) {
    return { eligible: false, code: 'PROMO_ALREADY_USED', error: 'You have already used this promo code' };
  }
  return {
    eligible: true,
    promo: {
      code: promoRow.code,
      discountPercent: Number(promoRow.discountPercent),
      maxUses,
      usedCount,
      remainingUses: maxUses === null ? null : Math.max(0, maxUses - usedCount),
      durationHours: promoRow.durationHours === null || promoRow.durationHours === undefined ? null : Number(promoRow.durationHours),
      expiresAtMs
    }
  };
}

export function formatSubscriptionForClient(row, nowMs = Date.now()) {
  const expiresAtMs = row?.expiresAt ? new Date(row.expiresAt).getTime() : null;
  const startedAtMs = row?.startedAt ? new Date(row.startedAt).getTime() : null;
  const trialClaimedAtMs = row?.trialClaimedAt ? new Date(row.trialClaimedAt).getTime() : null;
  const active = Boolean(expiresAtMs && expiresAtMs > nowMs);

  return {
    active,
    planId: active ? (row?.planId || null) : null,
    trialClaimed: Boolean(row?.trialClaimed),
    trialClaimedAtMs,
    startedAtMs: active ? startedAtMs : null,
    expiresAtMs: active ? expiresAtMs : null,
    serverNowMs: nowMs
  };
}
