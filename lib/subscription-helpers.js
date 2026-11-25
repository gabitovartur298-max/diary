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

export function resolvePlanFromPayment(invoicePayload, totalAmount) {
  const amount = Number(totalAmount);
  if (!Number.isInteger(amount) || amount <= 0) return null;

  if (typeof invoicePayload === 'string' && invoicePayload.startsWith('plan:')) {
    const parts = invoicePayload.split(':');
    const planId = parts[1];
    const plan = Object.hasOwn(STARS_PLANS, planId) ? STARS_PLANS[planId] : null;
    if (plan && plan.stars === amount) {
      return plan;
    }
    return null;
  }

  // Совместимость со старыми статическими ссылками (если кто-то откроет старый инвойс)
  return Object.values(STARS_PLANS).find((p) => p.stars === amount) || null;
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
