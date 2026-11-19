import { getTelegramUserFromInitData } from '../lib/telegram.js';
import { ensureDatabaseSchema, getPool } from '../lib/db/index.js';
import { consumeRateLimit } from '../lib/rate-limit.js';
import { getSubscriptionStatus } from '../lib/subscriptions.js';

export const config = {
  api: { bodyParser: false }
};

export const maxDuration = 60;

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const DEFAULT_FILE_NAME = 'Symptom_Diary_Report.pdf';
const DEFAULT_CAPTION = 'Ваш клинический PDF-отчёт из «Дневника симптомов»';

function getHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value || '';
}

function getFileName(req) {
  const value = req.query?.fileName;
  const rawName = (Array.isArray(value) ? value[0] : value) || DEFAULT_FILE_NAME;
  const safeName = String(rawName)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  return safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
}

function getCaption(req) {
  const value = req.query?.caption;
  const caption = (Array.isArray(value) ? value[0] : value) || DEFAULT_CAPTION;
  return String(caption).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 900);
}

async function readPdfBody(req) {
  const contentLength = Number(getHeader(req, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
    const error = new Error('PDF_TOO_LARGE');
    error.code = 'PDF_TOO_LARGE';
    throw error;
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_PDF_BYTES) {
      const error = new Error('PDF_TOO_LARGE');
      error.code = 'PDF_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!process.env.BOT_TOKEN) {
    return res.status(503).json({ ok: false, error: 'PDF delivery temporarily unavailable' });
  }

  const user = getTelegramUserFromInitData(getHeader(req, 'x-telegram-init-data'));
  if (!user) return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
  const pool = getPool();
  if (!pool) return res.status(503).json({ ok: false, error: 'PDF delivery temporarily unavailable' });

  try {
    await ensureDatabaseSchema();
    const rate = await consumeRateLimit(pool, 'pdf', user.id);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    const subscription = await getSubscriptionStatus(user.id);
    if (!subscription.active) {
      return res.status(403).json({ ok: false, error: 'An active PRO subscription is required' });
    }

    const contentType = getHeader(req, 'content-type').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/pdf') {
      return res.status(415).json({ ok: false, error: 'Expected an application/pdf request' });
    }

    const pdfBuffer = await readPdfBody(req);
    if (pdfBuffer.length === 0 || pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
      return res.status(400).json({ ok: false, error: 'Invalid PDF file' });
    }

    const formData = new FormData();
    formData.append('chat_id', user.id);
    formData.append('caption', getCaption(req));
    formData.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), getFileName(req));

    const telegramResponse = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(20_000)
    });
    const telegramData = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !telegramData?.ok) {
      return res.status(502).json({ ok: false, error: 'Telegram could not receive the PDF' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error.code === 'PDF_TOO_LARGE') {
      return res.status(413).json({ ok: false, error: 'PDF is too large' });
    }
    console.error('PDF delivery failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(503).json({ ok: false, error: 'PDF delivery temporarily unavailable' });
  }
}
