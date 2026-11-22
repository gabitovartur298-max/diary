import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { starPayments, userSubscriptions } from './db/schema.js';

export const TRIAL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    const plan = STARS_PLANS[planId];
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

export async function getUserSubscription(userId) {
  const rows = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, userId))
    .limit(1);

  return formatSubscriptionForClient(rows[0] || null);
}

export async function hasActivePro(userId) {
  const sub = await getUserSubscription(userId);
  return sub.active;
}

export async function claimFreeTrialForUser(userId) {
  return db.transaction(async (tx) => {
    await tx
      .insert(userSubscriptions)
      .values({ userId })
      .onConflictDoNothing({ target: userSubscriptions.userId });

    const rows = await tx
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .for('update')
      .limit(1);

    const existing = rows[0];
    const nowMs = Date.now();

    if (existing?.trialClaimed) {
      return {
        alreadyClaimed: true,
        subscription: formatSubscriptionForClient(existing, nowMs)
      };
    }

    const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const isCurrentlyActive = existingExpMs > nowMs;
    const newStartedAt = isCurrentlyActive && existing?.startedAt
      ? new Date(existing.startedAt)
      : new Date(nowMs);
    const baseMs = isCurrentlyActive ? existingExpMs : nowMs;
    const newExpiresAt = new Date(baseMs + TRIAL_DAYS * DAY_MS);
    const nowDate = new Date(nowMs);

    const updated = await tx
      .update(userSubscriptions)
      .set({
        trialClaimed: true,
        trialClaimedAt: nowDate,
        planId: isCurrentlyActive && existing?.planId ? existing.planId : 'trial_3d',
        startedAt: newStartedAt,
        expiresAt: newExpiresAt,
        updatedAt: nowDate
      })
      .where(eq(userSubscriptions.userId, userId))
      .returning();

    return {
      alreadyClaimed: false,
      subscription: formatSubscriptionForClient(updated[0], nowMs)
    };
  });
}

export async function applyStarPayment({
  chargeId,
  userId,
  planId,
  starsAmount,
  daysAdded,
  invoicePayload
}) {
  return db.transaction(async (tx) => {
    // Идемпотентность: если Telegram повторно прислал тот же чек, не начисляем дважды
    const insertedPayment = await tx
      .insert(starPayments)
      .values({
        chargeId,
        userId,
        planId,
        starsAmount,
        daysAdded,
        invoicePayload: String(invoicePayload || '').slice(0, 256)
      })
      .onConflictDoNothing({ target: starPayments.chargeId })
      .returning({ chargeId: starPayments.chargeId });

    if (insertedPayment.length === 0) {
      const currentRows = await tx
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .limit(1);
      return {
        duplicate: true,
        subscription: formatSubscriptionForClient(currentRows[0] || null)
      };
    }

    await tx
      .insert(userSubscriptions)
      .values({ userId })
      .onConflictDoNothing({ target: userSubscriptions.userId });

    const rows = await tx
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .for('update')
      .limit(1);

    const existing = rows[0];
    const nowMs = Date.now();
    const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const isCurrentlyActive = existingExpMs > nowMs;

    const newStartedAt = isCurrentlyActive && existing?.startedAt
      ? new Date(existing.startedAt)
      : new Date(nowMs);
    const baseMs = isCurrentlyActive ? existingExpMs : nowMs;
    const newExpiresAt = new Date(baseMs + daysAdded * DAY_MS);

    const updated = await tx
      .update(userSubscriptions)
      .set({
        planId,
        startedAt: newStartedAt,
        expiresAt: newExpiresAt,
        updatedAt: new Date(nowMs)
      })
      .where(eq(userSubscriptions.userId, userId))
      .returning();

    return {
      duplicate: false,
      subscription: formatSubscriptionForClient(updated[0], nowMs)
    };
  });
}
