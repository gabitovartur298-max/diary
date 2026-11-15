import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index.js';
import { symptomDiaryData } from '../lib/db/schema.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

const MAX_PAYLOAD_LENGTH = 8 * 1024 * 1024;

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

function isValidPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!Array.isArray(payload.entries) || payload.entries.length > 10000) return false;
  if (payload.deletedEntryIds !== undefined && !Array.isArray(payload.deletedEntryIds)) return false;

  try {
    return JSON.stringify(payload).length <= MAX_PAYLOAD_LENGTH;
  } catch {
    return false;
  }
}

function getAccountId(req, body) {
  const user = getTelegramUserFromInitData(readInitData(req, body));
  return user ? `tg_${user.id}` : null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  const body = readBody(req);
  const accountId = getAccountId(req, body);
  if (!accountId) {
    return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  }

  try {
    if (req.method === 'GET') {
      const rows = await db
        .select({
          payload: symptomDiaryData.payload,
          updatedAt: symptomDiaryData.updatedAt
        })
        .from(symptomDiaryData)
        .where(eq(symptomDiaryData.userId, accountId))
        .limit(1);

      return res.status(200).json({
        ok: true,
        data: rows[0]?.payload || null,
        updatedAt: rows[0]?.updatedAt || null
      });
    }

    if (req.method === 'POST') {
      const payload = body.data;
      if (!isValidPayload(payload)) {
        return res.status(400).json({ ok: false, error: 'Invalid diary payload' });
      }

      const rows = await db
        .insert(symptomDiaryData)
        .values({
          userId: accountId,
          payload
        })
        .onConflictDoUpdate({
          target: symptomDiaryData.userId,
          set: {
            payload,
            updatedAt: new Date()
          }
        })
        .returning({ updatedAt: symptomDiaryData.updatedAt });

      return res.status(200).json({
        ok: true,
        updatedAt: rows[0]?.updatedAt || null
      });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[v0] Diary sync API error:', error);
    return res.status(500).json({ ok: false, error: 'Diary sync unavailable' });
  }
}
