import { getTelegramUserFromInitData } from '../lib/telegram.js';

export const config = {
  api: {
    bodyParser: false
  }
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
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 120);
  return safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
}

function getCaption(req) {
  const value = req.query?.caption;
  const caption = (Array.isArray(value) ? value[0] : value) || DEFAULT_CAPTION;
  return String(caption).slice(0, 900);
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
    return res.status(401).json({ ok: false, error: 'Telegram authentication required' });
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

    const telegramResponse = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData
    });
    const telegramData = await telegramResponse.json().catch(() => null);

    if (!telegramResponse.ok || !telegramData?.ok) {
      return res.status(502).json({
        ok: false,
        error: telegramData?.description || 'Telegram could not receive the PDF'
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error.code === 'PDF_TOO_LARGE') {
      return res.status(413).json({ ok: false, error: 'PDF is too large' });
    }
    console.error('[v0] PDF delivery error:', error);
    return res.status(500).json({ ok: false, error: 'PDF delivery unavailable' });
  }
}
