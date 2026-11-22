import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
