import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const symptomDiaryData = pgTable('symptom_diary_data', {
  userId: text('user_id').primaryKey(),
  payload: jsonb('payload').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const userSubscriptions = pgTable('user_subscriptions', {
  userId: text('user_id').primaryKey(),
  trialClaimed: boolean('trial_claimed').notNull().default(false),
  trialClaimedAt: timestamp('trial_claimed_at', { withTimezone: true }),
  planId: text('plan_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const starPayments = pgTable('star_payments', {
  chargeId: text('charge_id').primaryKey(),
  userId: text('user_id').notNull(),
  planId: text('plan_id').notNull(),
  starsAmount: integer('stars_amount').notNull(),
  daysAdded: integer('days_added').notNull(),
  invoicePayload: text('invoice_payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  refundedAt: timestamp('refunded_at', { withTimezone: true })
});

export const botUsers = pgTable('bot_users', {
  telegramId: text('telegram_id').primaryKey(),
  accountId: text('account_id').notNull(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  languageCode: text('language_code'),
  hasStartedBot: boolean('has_started_bot').notNull().default(false),
  botBlocked: boolean('bot_blocked').notNull().default(false),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
});

export const promoCodes = pgTable('promo_codes', {
  code: text('code').primaryKey(),
  discountPercent: integer('discount_percent').notNull(),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  durationHours: integer('duration_hours'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const promoRedemptions = pgTable('promo_redemptions', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  userId: text('user_id').notNull(),
  planId: text('plan_id').notNull(),
  discountPercent: integer('discount_percent').notNull(),
  chargeId: text('charge_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const analyticsEvents = pgTable('analytics_events', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  eventName: text('event_name').notNull(),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
