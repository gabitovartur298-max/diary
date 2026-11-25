import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from './db/index.js';
import { ensureDatabaseSchema } from './db/ensure-schema.js';
import { promoCodes, promoRedemptions, starPayments, userSubscriptions } from './db/schema.js';
import {
  DAY_MS,
  STARS_PLANS,
  TRIAL_DAYS,
  buildPaymentPayload,
  computeDiscountedStars,
  evaluatePromoEligibility,
  formatSubscriptionForClient,
  normalizePromoCode,
  parsePaymentPayload,
  resolvePlanFromPayment
} from './subscription-helpers.js';

export {
  STARS_PLANS,
  TRIAL_DAYS,
  buildPaymentPayload,
  computeDiscountedStars,
  evaluatePromoEligibility,
  formatSubscriptionForClient,
  normalizePromoCode,
  parsePaymentPayload,
  resolvePlanFromPayment
};

export async function getUserSubscription(userId) {
  await ensureDatabaseSchema();
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

export async function checkPromoCodeForUser({ promoCode, userId }) {
  await ensureDatabaseSchema();
  const code = normalizePromoCode(promoCode);
  if (!code) {
    return { eligible: false, code: 'PROMO_INVALID', error: 'Invalid promo code format' };
  }

  const promoRows = await db
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.code, code))
    .limit(1);

  const redemptionRows = userId
    ? await db
        .select({ id: promoRedemptions.id })
        .from(promoRedemptions)
        .where(and(eq(promoRedemptions.code, code), eq(promoRedemptions.userId, userId)))
        .limit(1)
    : [];

  return evaluatePromoEligibility(promoRows[0] || null, {
    alreadyRedeemed: redemptionRows.length > 0
  });
}

export async function claimFreeTrialForUser(userId) {
  await ensureDatabaseSchema();
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

async function extendUserSubscriptionTx(tx, { userId, planId, daysAdded, nowMs = Date.now() }) {
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

  return formatSubscriptionForClient(updated[0], nowMs);
}

export async function redeemFreePromoForUser({ userId, promoCode, planId }) {
  await ensureDatabaseSchema();
  const code = normalizePromoCode(promoCode);
  const plan = Object.hasOwn(STARS_PLANS, planId) ? STARS_PLANS[planId] : null;
  if (!code) {
    return { ok: false, code: 'PROMO_INVALID', error: 'Invalid promo code' };
  }
  if (!plan) {
    return { ok: false, code: 'UNKNOWN_PLAN', error: 'Unknown subscription plan' };
  }

  return db.transaction(async (tx) => {
    const promoRows = await tx
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.code, code))
      .for('update')
      .limit(1);

    const redemptionRows = await tx
      .select({ id: promoRedemptions.id })
      .from(promoRedemptions)
      .where(and(eq(promoRedemptions.code, code), eq(promoRedemptions.userId, userId)))
      .limit(1);

    const check = evaluatePromoEligibility(promoRows[0] || null, {
      alreadyRedeemed: redemptionRows.length > 0
    });
    if (!check.eligible) {
      return { ok: false, code: check.code, error: check.error };
    }
    if (check.promo.discountPercent < 100) {
      return { ok: false, code: 'PROMO_REQUIRES_PAYMENT', error: 'Promo grants a discount on payment, not 100% free' };
    }

    await tx
      .insert(promoRedemptions)
      .values({
        code,
        userId,
        planId: plan.id,
        discountPercent: check.promo.discountPercent,
        chargeId: null
      })
      .onConflictDoNothing();

    await tx
      .update(promoCodes)
      .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
      .where(eq(promoCodes.code, code));

    const subscription = await extendUserSubscriptionTx(tx, {
      userId,
      planId: plan.id,
      daysAdded: plan.days
    });

    return {
      ok: true,
      promo: check.promo,
      plan,
      subscription
    };
  });
}

export async function applyStarPayment({
  chargeId,
  userId,
  planId,
  starsAmount,
  daysAdded,
  invoicePayload,
  promoCode = null
}) {
  await ensureDatabaseSchema();
  const normalizedCode = normalizePromoCode(promoCode || '');

  return db.transaction(async (tx) => {
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

    if (normalizedCode) {
      const promoRows = await tx
        .select()
        .from(promoCodes)
        .where(eq(promoCodes.code, normalizedCode))
        .for('update')
        .limit(1);

      if (promoRows[0]) {
        const insertedRedemption = await tx
          .insert(promoRedemptions)
          .values({
            code: normalizedCode,
            userId,
            planId,
            discountPercent: promoRows[0].discountPercent,
            chargeId
          })
          .onConflictDoNothing()
          .returning({ id: promoRedemptions.id });

        if (insertedRedemption.length > 0) {
          await tx
            .update(promoCodes)
            .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
            .where(eq(promoCodes.code, normalizedCode));
        }
      }
    }

    const subscription = await extendUserSubscriptionTx(tx, {
      userId,
      planId,
      daysAdded
    });

    return {
      duplicate: false,
      subscription
    };
  });
}

export async function revokeStarPaymentRefund({ chargeId, userId = null }) {
  await ensureDatabaseSchema();
  return db.transaction(async (tx) => {
    const paymentRows = await tx
      .select()
      .from(starPayments)
      .where(eq(starPayments.chargeId, chargeId))
      .for('update')
      .limit(1);

    const payment = paymentRows[0];
    if (!payment) {
      return { found: false, duplicate: false, subscription: null };
    }

    const targetUserId = payment.userId || userId;
    if (payment.refundedAt) {
      const currentRows = targetUserId
        ? await tx
            .select()
            .from(userSubscriptions)
            .where(eq(userSubscriptions.userId, targetUserId))
            .limit(1)
        : [];
      return {
        found: true,
        duplicate: true,
        userId: targetUserId,
        daysDeducted: 0,
        subscription: formatSubscriptionForClient(currentRows[0] || null)
      };
    }

    const nowMs = Date.now();
    const nowDate = new Date(nowMs);

    await tx
      .update(starPayments)
      .set({ refundedAt: nowDate })
      .where(eq(starPayments.chargeId, chargeId));

    if (!targetUserId) {
      return {
        found: true,
        duplicate: false,
        userId: null,
        daysDeducted: payment.daysAdded,
        subscription: formatSubscriptionForClient(null, nowMs)
      };
    }

    const subRows = await tx
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, targetUserId))
      .for('update')
      .limit(1);

    const existing = subRows[0];
    if (!existing) {
      return {
        found: true,
        duplicate: false,
        userId: targetUserId,
        daysDeducted: payment.daysAdded,
        subscription: formatSubscriptionForClient(null, nowMs)
      };
    }

    const existingExpMs = existing.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const deductedMs = Math.max(0, Number(payment.daysAdded || 0)) * DAY_MS;
    const newExpMs = existingExpMs - deductedMs;
    const stillActive = newExpMs > nowMs;

    const updated = await tx
      .update(userSubscriptions)
      .set({
        planId: stillActive ? existing.planId : null,
        startedAt: stillActive ? existing.startedAt : null,
        expiresAt: stillActive ? new Date(newExpMs) : null,
        updatedAt: nowDate
      })
      .where(eq(userSubscriptions.userId, targetUserId))
      .returning();

    return {
      found: true,
      duplicate: false,
      userId: targetUserId,
      daysDeducted: payment.daysAdded,
      subscription: formatSubscriptionForClient(updated[0], nowMs)
    };
  });
}
