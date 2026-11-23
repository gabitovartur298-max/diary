import { hasActivePro } from '../lib/subscriptions.js';
import { getTelegramUserFromInitData } from '../lib/telegram.js';

export const maxDuration = 60;

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const DEFAULT_FILE_NAME = 'Symptom_Diary_Report.pdf';
const DEFAULT_CAPTION = 'Ваш клинический PDF-отчёт из «Дневника симптомов»';

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 6;
const rateBuckets = globalThis.__symptomPdfRateBuckets || new Map();
globalThis.__symptomPdfRateBuckets = rateBuckets;

function checkRateLimit(userId) {
  const now = Date.now();
  const timestamps = (rateBuckets.get(userId) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_MAX_REQUESTS) {
    rateBuckets.set(userId, timestamps);
    return false;
  }
  timestamps.push(now);
  rateBuckets.set(userId, timestamps);
  if (rateBuckets.size > 500) {
    for (const [k, list] of rateBuckets.entries()) {
      if (list.every((ts) => now - ts >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return true;
}

function getHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value || '';
}

function getFileName(req) {
  const value = req.query?.fileName;
  const rawName = (Array.isArray(value) ? value[0] : value) || DEFAULT_FILE_NAME;
  const safeName = String(rawName)
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 120);
  if (!safeName) return DEFAULT_FILE_NAME;
  return safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
}

function getCaption(req) {
  const value = req.query?.caption;
  const caption = (Array.isArray(value) ? value[0] : value) || DEFAULT_CAPTION;
  return String(caption).replace(/\0/g, '').slice(0, 900);
}

async function readPdfBody(req) {
  const contentLength = Number(getHeader(req, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
    const error = new Error('PDF is too large');
    error.code = 'PDF_TOO_LARGE';
    throw error;
  }

  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_PDF_BYTES) {
      const error = new Error('PDF is too large');
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
    return res.status(500).json({ ok: false, error: 'BOT_TOKEN is not configured' });
  }

  const user = getTelegramUserFromInitData(getHeader(req, 'x-telegram-init-data'));
  if (!user) {
    return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Telegram authentication required' });
  }

  const accountId = `tg_${user.id}`;
  const isPro = await hasActivePro(accountId);
  if (!isPro) {
    return res.status(403).json({ ok: false, code: 'PRO_REQUIRED', error: 'Active PRO subscription required' });
  }

  if (!checkRateLimit(accountId)) {
    return res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: 'Too many PDF requests. Please wait a minute.' });
  }

  const contentType = getHeader(req, 'content-type').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/pdf') {
    return res.status(415).json({ ok: false, error: 'Expected an application/pdf request' });
  }

  try {
    const pdfBuffer = await readPdfBody(req);
    if (pdfBuffer.length === 0 || pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
      return res.status(400).json({ ok: false, error: 'Invalid PDF file' });
    }

    const formData = new FormData();
    formData.append('chat_id', user.id);
    formData.append('caption', getCaption(req));
    formData.append(
      'document',
      new Blob([pdfBuffer], { type: 'application/pdf' }),
      getFileName(req)
    );

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`,
      {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(20000)
      }
    );
    const telegramData = await telegramResponse.json().catch(() => null);

    if (!telegramResponse.ok || !telegramData?.ok) {
      const desc = telegramData?.description || 'Telegram could not receive the PDF';
      if (telegramResponse.status === 403 || /blocked|initiate conversation/i.test(desc)) {
        return res.status(403).json({
          ok: false,
          code: 'BOT_CHAT_UNAVAILABLE',
          error: 'Open the bot chat and press /start so it can send you PDF files.'
        });
      }
      if (telegramResponse.status === 429) {
        return res.status(429).json({
          ok: false,
          code: 'TELEGRAM_RATE_LIMIT',
          error: 'Telegram is temporarily busy, please try again shortly.'
        });
      }
      return res.status(502).json({ ok: false, error: desc });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error.code === 'PDF_TOO_LARGE') {
      return res.status(413).json({ ok: false, error: 'PDF is too large' });
    }
    console.error('[send-pdf] Delivery error:', error);
    return res.status(500).json({ ok: false, error: 'PDF delivery unavailable' });
  }
}
