export function readJsonBody(req) {
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

export function getHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : String(value || '');
}

export function readInitData(req, body = {}) {
  return getHeader(req, 'x-telegram-init-data') || body?.initData || '';
}

export function resolveAppUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
  if (prodHost) {
    return `https://${prodHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL || '';
  return host ? `https://${String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
}
