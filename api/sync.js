import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index.js';
import { symptomDiaryData } from '../lib/db/schema.js';
import { mergeDiaryPayloads, sanitizeDiaryPayload } from '../lib/diary.js';
import { getUserSubscription } from '../lib/subscriptions.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function readInitData(req, body) {
  const headerValue = req.headers['x-telegram-init-data'];
  return (Array.isArray(headerValue) ? headerValue[0] : headerValue) || body.initData || '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  const body = readBody(req);
  const user = getTelegramUserFromInitData(readInitData(req, body));
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  }

  const accountId = `tg_${user.id}`;

  try {
    if (req.method === 'GET') {
      const [rows, subscription] = await Promise.all([
        db
          .select({
            payload: symptomDiaryData.payload,
            version: symptomDiaryData.version,
            updatedAt: symptomDiaryData.updatedAt
          })
          .from(symptomDiaryData)
          .where(eq(symptomDiaryData.userId, accountId))
          .limit(1),
        getUserSubscription(accountId)
      ]);

      const stored = rows[0]?.payload ? sanitizeDiaryPayload(rows[0].payload) : null;

      return res.status(200).json({
        ok: true,
        data: stored,
        version: rows[0]?.version || 0,
        updatedAt: rows[0]?.updatedAt || null,
        subscription
      });
    }

    if (req.method === 'POST') {
      const incoming = sanitizeDiaryPayload(body.data);
      if (!incoming) {
        return res.status(400).json({ ok: false, error: 'Invalid or oversized diary payload' });
      }

      const [saved, subscription] = await Promise.all([
        db.transaction(async (tx) => {
          await tx
            .insert(symptomDiaryData)
            .values({
              userId: accountId,
              payload: {},
              version: 0
            })
            .onConflictDoNothing({ target: symptomDiaryData.userId });

          const existingRows = await tx
            .select()
            .from(symptomDiaryData)
            .where(eq(symptomDiaryData.userId, accountId))
            .for('update')
            .limit(1);

          const existing = existingRows[0];
          const merged = mergeDiaryPayloads(existing?.payload, incoming);
          const nextVersion = (existing?.version || 0) + 1;

          const updated = await tx
            .update(symptomDiaryData)
            .set({
              payload: merged,
              version: nextVersion,
              updatedAt: new Date()
            })
            .where(eq(symptomDiaryData.userId, accountId))
            .returning({
              version: symptomDiaryData.version,
              updatedAt: symptomDiaryData.updatedAt
            });

          return {
            data: merged,
            version: updated[0]?.version || nextVersion,
            updatedAt: updated[0]?.updatedAt || null
          };
        }),
        getUserSubscription(accountId)
      ]);

      return res.status(200).json({
        ok: true,
        data: saved.data,
        version: saved.version,
        updatedAt: saved.updatedAt,
        subscription
      });
    }

    if (req.method === 'DELETE') {
      await db
        .delete(symptomDiaryData)
        .where(eq(symptomDiaryData.userId, accountId));

      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[sync] Diary sync API error:', error);
    return res.status(500).json({ ok: false, error: 'Diary sync unavailable' });
  }
}
