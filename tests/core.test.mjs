import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { mergeDiaryPayloads, sanitizeDiaryPayload } from '../lib/diary.js';
import {
  DAY_MS,
  formatSubscriptionForClient,
  resolvePlanFromPayment
} from '../lib/subscription-helpers.js';
import { getTelegramUserFromInitData, safeEqualStrings } from '../lib/telegram.js';

function signTelegramInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('telegram initData verification accepts valid, rejects tampered and expired', () => {
  const prevToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = '123456:TEST_BOT_TOKEN';

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const valid = signTelegramInitData(
      {
        auth_date: String(nowSec - 30),
        query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
        user: JSON.stringify({ id: 987654321, language_code: 'ru' })
      },
      process.env.BOT_TOKEN
    );

    const user = getTelegramUserFromInitData(valid);
    assert.deepEqual(user, { id: '987654321', languageCode: 'ru' });

    const tampered = valid.replace('987654321', '111111111');
    assert.equal(getTelegramUserFromInitData(tampered), null);

    const expired = signTelegramInitData(
      {
        auth_date: String(nowSec - 60 * 60 * 25),
        user: JSON.stringify({ id: 987654321, language_code: 'en' })
      },
      process.env.BOT_TOKEN
    );
    assert.equal(getTelegramUserFromInitData(expired), null);

    const farFuture = signTelegramInitData(
      {
        auth_date: String(nowSec + 600),
        user: JSON.stringify({ id: 987654321, language_code: 'en' })
      },
      process.env.BOT_TOKEN
    );
    assert.equal(getTelegramUserFromInitData(farFuture), null);

    assert.equal(safeEqualStrings('abc', 'abc'), true);
    assert.equal(safeEqualStrings('abc', 'abd'), false);
    assert.equal(safeEqualStrings('abc', 'abcd'), false);
  } finally {
    if (prevToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = prevToken;
  }
});

test('subscription helper resolves valid plans and blocks prototype/amount mismatches', () => {
  const plan1m = resolvePlanFromPayment('plan:1m:tg_123:1700000000', 50);
  assert.equal(plan1m?.id, '1m');
  assert.equal(plan1m?.days, 30);

  assert.equal(resolvePlanFromPayment('plan:1m:tg_123:1700000000', 250), null);
  assert.equal(resolvePlanFromPayment('plan:toString:tg_123:1', 50), null);
  assert.equal(resolvePlanFromPayment('plan:__proto__:tg_123:1', 50), null);

  const legacy6m = resolvePlanFromPayment('legacy_static_invoice', 250);
  assert.equal(legacy6m?.id, '6m');

  const nowMs = 1_700_000_000_000;
  const active = formatSubscriptionForClient(
    {
      planId: '6m',
      trialClaimed: true,
      trialClaimedAt: new Date(nowMs - DAY_MS),
      startedAt: new Date(nowMs - DAY_MS),
      expiresAt: new Date(nowMs + 10 * DAY_MS)
    },
    nowMs
  );
  assert.equal(active.active, true);
  assert.equal(active.planId, '6m');
  assert.equal(active.trialClaimed, true);

  const expired = formatSubscriptionForClient(
    {
      planId: '6m',
      trialClaimed: true,
      expiresAt: new Date(nowMs - 1000)
    },
    nowMs
  );
  assert.equal(expired.active, false);
  assert.equal(expired.planId, null);
  assert.equal(expired.trialClaimed, true);
});

test('diary sanitization & merge preserves tombstones, timestamps, and English-only customs', () => {
  const clean = sanitizeDiaryPayload({
    lang: 'en',
    langUpdatedAtMs: 500,
    tzId: 'Europe/London',
    tzOffsetMinutes: 0,
    tzUpdatedAtMs: 600,
    entries: [
      {
        id: 'e_1',
        category: 'custom_1',
        severity: 7,
        duration: '1_5m',
        tags: ['t1'],
        notes: { ru: 'Test', en: 'Test' },
        timestampMs: 1000,
        updatedAtMs: 1000
      }
    ],
    customCategories: {
      custom_1: {
        icon: '<script>⚡',
        customPhoto: 'javascript:alert(1)',
        customName: { ru: '', en: 'Fever' },
        customSub: { ru: '', en: 'High temp' },
        tags: [{ id: 'ctag_1', ru: '', en: 'Chills', updatedAtMs: 700 }],
        updatedAtMs: 700
      }
    },
    customDurations: [{ id: 'cdur_1', ru: '', en: '45 min', updatedAtMs: 700 }]
  });

  assert.ok(clean);
  assert.equal(clean.customCategories.custom_1.icon, 'script⚡');
  assert.equal(clean.customCategories.custom_1.customPhoto, null);
  assert.equal(clean.customCategories.custom_1.customName.ru, 'Fever');
  assert.equal(clean.customCategories.custom_1.tags[0].ru, 'Chills');
  assert.equal(clean.customDurations[0].ru, '45 min');

  const existing = sanitizeDiaryPayload({
    lang: 'en',
    langUpdatedAtMs: 2000,
    tzId: 'Europe/London',
    tzOffsetMinutes: 0,
    tzUpdatedAtMs: 2000,
    entries: [
      { id: 'e_keep', category: 'migraine', severity: 4, timestampMs: 1000, updatedAtMs: 1000 },
      { id: 'e_del', category: 'custom_old', severity: 8, timestampMs: 1100, updatedAtMs: 1100 }
    ],
    customCategories: {
      custom_old: { icon: '🩺', customName: { ru: 'Old', en: 'Old' }, updatedAtMs: 1000 }
    },
    customTagsByCat: {
      migraine: [{ id: 'ctag_old', ru: 'OldTag', en: 'OldTag', updatedAtMs: 1000 }]
    },
    customDurations: [{ id: 'cdur_old', ru: '20m', en: '20m', updatedAtMs: 1000 }],
    pdfOptions: { sortMode: 'time', updatedAtMs: 2000 }
  });

  const incomingFromNewDevice = sanitizeDiaryPayload({
    lang: 'ru',
    langUpdatedAtMs: 0,
    tzOffsetMinutes: 180,
    tzUpdatedAtMs: 0,
    entries: [{ id: 'e_new', category: 'migraine', severity: 6, timestampMs: 3000, updatedAtMs: 3000 }],
    deletedCustomCategoryIds: ['custom_old'],
    deletedCustomTagIds: ['ctag_old'],
    deletedCustomDurationIds: ['cdur_old'],
    deletedEntryIds: ['e_del'],
    pdfOptions: { sortMode: 'category', updatedAtMs: 0 }
  });

  const merged = mergeDiaryPayloads(existing, incomingFromNewDevice);
  assert.equal(merged.lang, 'en');
  assert.equal(merged.tzId, 'Europe/London');
  assert.equal(merged.pdfOptions.sortMode, 'time');
  assert.equal(merged.customCategories.custom_old, undefined);
  assert.equal(merged.customTagsByCat.migraine, undefined);
  assert.equal(merged.customDurations.length, 0);
  assert.deepEqual(
    merged.entries.map((e) => e.id),
    ['e_new', 'e_keep']
  );
});

test('index.html inline script parses cleanly, runs without syntax/init errors, and matches backend sync/security rules', async () => {
  const htmlPath = path.resolve(process.cwd(), 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const inlineScripts = scriptMatches.filter((m) => !/\bsrc\s*=/i.test(m[1]));
  assert.equal(inlineScripts.length, 1, 'Expected exactly one inline <script> in index.html');

  const inlineCode = inlineScripts[0][2];
  new vm.Script(inlineCode, { filename: 'index.html' });

  assert.equal(html.includes('TELEGRAM_STARS_INVOICE_LINKS'), false);
  assert.equal(html.includes('lucide@latest'), false);
  assert.equal(html.includes('hover:bg-slate-750'), false);
  assert.equal(html.includes('/api/trial'), true);
  assert.equal(html.includes('/api/create-invoice'), true);
  assert.equal(html.includes('/api/sync'), true);
  assert.equal(html.includes('/api/send-pdf'), true);

  // Execute the inline script in a lightweight mock browser context to test client logic directly
  const storageMap = new Map();
  const mockEl = () => ({
    textContent: '',
    innerHTML: '',
    value: '',
    placeholder: '',
    className: '',
    disabled: false,
    checked: false,
    dataset: {},
    classList: {
      _set: new Set(['hidden']),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    style: {},
    appendChild() {},
    addEventListener() {},
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}
  });
  const elements = new Map();
  const context = {
    console,
    Date,
    Math,
    JSON,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Intl,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    navigator: { userAgent: 'node-test', language: 'en-US' },
    screen: { width: 390, height: 844 },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    },
    document: {
      visibilityState: 'visible',
      activeElement: null,
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, mockEl());
        return elements.get(id);
      },
      createElement: () => mockEl(),
      addEventListener: () => {}
    },
    window: {
      Telegram: { WebApp: { initData: '', initDataUnsafe: {} } },
      confirm: () => true
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(inlineCode, context, { filename: 'index.html' });

  // 1. Unique SVG IDs for asthma icon
  const svg1 = context.getAsthmaExhalingFaceSvg();
  const svg2 = context.getAsthmaExhalingFaceSvg();
  const id1 = svg1.match(/id="(asthmaFaceGrad_\d+)"/)?.[1];
  const id2 = svg2.match(/id="(asthmaFaceGrad_\d+)"/)?.[1];
  assert.ok(id1 && id2 && id1 !== id2, 'Expected unique SVG gradient IDs');

  // 2. XSS escaping in custom category icon & invalid customPhoto rejection
  const renderedIcon = vm.runInContext(`
    CATEGORIES.custom_xss = {
      icon: '<img src=x>',
      customPhoto: 'javascript:alert(1)',
      customName: { ru: 'Test', en: 'Test' },
      customSub: { ru: 'Sub', en: 'Sub' },
      tags: [],
      isCustom: true
    };
    renderCategoryIconHtml('custom_xss', 'grid');
  `, context);
  assert.equal(renderedIcon.includes('<img'), false);
  assert.equal(renderedIcon.includes('javascript:'), false);

  // 3. DST offset accuracy for Europe/London (winter = 0, summer = +60)
  assert.equal(context.getTimeZoneOffsetMinutesAt('Europe/London', Date.UTC(2026, 0, 15, 12, 0)), 0);
  assert.equal(context.getTimeZoneOffsetMinutesAt('Europe/London', Date.UTC(2026, 6, 15, 12, 0)), 60);

  // 4. Client canonical payload matches server sanitizeDiaryPayload structure with zero false diffs
  context.applyDiaryPayloadToState({
    lang: 'en',
    langUpdatedAtMs: 12345,
    tzId: 'Europe/London',
    tzOffsetMinutes: 0,
    tzUpdatedAtMs: 12345,
    entries: [
      { id: 'e_a', category: 'migraine', severity: 5, duration: '1_5m', tags: ['m_aura'], notes: { ru: '', en: '' }, timestampMs: 2000, updatedAtMs: 2000 },
      { id: 'e_b', category: 'migraine', severity: 8, duration: 'none', tags: [], notes: { ru: 'x', en: 'x' }, timestampMs: 1000, updatedAtMs: 1000 }
    ],
    deletedEntryIds: ['e_deleted'],
    deletedCustomCategoryIds: ['custom_gone'],
    deletedCustomTagIds: ['ctag_gone'],
    deletedCustomDurationIds: ['cdur_gone'],
    pdfOptions: { sortMode: 'time', updatedAtMs: 555 }
  });
  const clientPayload = JSON.parse(JSON.stringify(context.buildUserDataPayload()));
  const serverSanitized = sanitizeDiaryPayload(clientPayload);
  const clientCanonicalFromServer = JSON.parse(JSON.stringify(context.canonicalizeDiaryPayload(serverSanitized)));
  assert.deepEqual(clientCanonicalFromServer, clientPayload);

  // 5. No free client bypass outside Telegram
  await context.claimFreeTrial();
  assert.equal(context.isSubscriptionCurrentlyValid(), false);
  await context.confirmStarsPayment();
  assert.equal(context.isSubscriptionCurrentlyValid(), false);
});
