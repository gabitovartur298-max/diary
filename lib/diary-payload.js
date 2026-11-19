const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_TIMEZONES = new Set([-480, -300, 0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 720]);
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PHOTO_LENGTH = 200_000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(strict, message) {
  if (strict) throw new Error(`INVALID_DIARY_${message}`);
  return null;
}

function safeId(value, strict = false) {
  if (typeof value === 'string' && ID_PATTERN.test(value) && !RESERVED_IDS.has(value)) return value;
  return invalid(strict, 'ID');
}

function safeText(value, maxLength, strict = false, fallback = '') {
  if (typeof value === 'string' && value.length <= maxLength) return value;
  if (strict) return invalid(true, 'TEXT');
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

function safeNumber(value, strict = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  return invalid(strict, 'TIMESTAMP');
}

function safePhoto(value, strict = false) {
  if (value === null || value === undefined || value === '') return null;
  if (
    typeof value === 'string' &&
    value.length <= MAX_PHOTO_LENGTH &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)
  ) {
    return value;
  }
  return invalid(strict, 'PHOTO');
}

function normalizeTag(tag, strict) {
  if (!isObject(tag)) return invalid(strict, 'TAG');
  const id = safeId(tag.id, strict);
  if (!id) return null;
  return {
    id,
    ru: safeText(tag.ru, 80, strict),
    en: safeText(tag.en, 80, strict),
    isCustom: true
  };
}

function normalizeEntry(entry, strict) {
  if (!isObject(entry)) return invalid(strict, 'ENTRY');
  const id = safeId(entry.id, strict);
  const category = safeId(entry.category, strict);
  const timestampMs = safeNumber(entry.timestampMs, strict);
  const severity = Number(entry.severity);
  if (!id || !category || !timestampMs) return null;
  if (!Number.isInteger(severity) || severity < 1 || severity > 10) return invalid(strict, 'SEVERITY');

  const notes = isObject(entry.notes) ? entry.notes : {};
  if (!isObject(entry.notes)) return invalid(strict, 'NOTES');
  const tags = Array.isArray(entry.tags)
    ? [...new Set(entry.tags.map(tag => safeId(tag, strict)).filter(Boolean))].slice(0, 50)
    : invalid(strict, 'TAGS') || [];
  const updatedAtMs = entry.updatedAtMs === undefined
    ? timestampMs
    : safeNumber(entry.updatedAtMs, strict) || timestampMs;

  return {
    id,
    category,
    severity,
    duration: safeId(entry.duration || 'none', strict) || 'none',
    tags,
    notes: {
      ru: safeText(notes.ru, 5000, strict),
      en: safeText(notes.en, 5000, strict)
    },
    timestampMs,
    updatedAtMs
  };
}

function normalizeCategory(category, strict) {
  if (!isObject(category)) return invalid(strict, 'CATEGORY');
  const customName = isObject(category.customName) ? category.customName : {};
  const customSub = isObject(category.customSub) ? category.customSub : {};
  if (!isObject(category.customName) || !isObject(category.customSub)) return invalid(strict, 'CATEGORY_NAMES');
  const tags = Array.isArray(category.tags)
    ? category.tags.map(tag => normalizeTag(tag, strict)).filter(Boolean).slice(0, 200)
    : invalid(strict, 'CATEGORY_TAGS') || [];

  return {
    icon: safeText(category.icon || '🩺', 16, strict, '🩺') || '🩺',
    customPhoto: safePhoto(category.customPhoto, strict),
    colorBg: 'bg-indigo-500/15',
    colorBorder: 'border-indigo-500',
    badgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    isCustom: true,
    customName: {
      ru: safeText(customName.ru, 28, strict),
      en: safeText(customName.en, 28, strict)
    },
    customSub: {
      ru: safeText(customSub.ru, 32, strict),
      en: safeText(customSub.en, 32, strict)
    },
    tags
  };
}

function normalizeDuration(duration, strict) {
  if (!isObject(duration)) return invalid(strict, 'DURATION');
  const id = safeId(duration.id, strict);
  if (!id) return null;
  return {
    id,
    ru: safeText(duration.ru, 32, strict),
    en: safeText(duration.en, 32, strict),
    isCustom: true
  };
}

function normalizeRecord(record, strict) {
  if (record === undefined || record === null) return {};
  if (!isObject(record)) return invalid(strict, 'RECORD') || {};
  return record;
}

export function normalizeDiaryPayload(input, { strict = false } = {}) {
  if (!isObject(input)) {
    if (strict) invalid(true, 'PAYLOAD');
    input = {};
  }

  const rawEntries = input.entries === undefined ? [] : input.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length > 10_000) invalid(strict, 'ENTRIES');
  const entries = (Array.isArray(rawEntries) ? rawEntries : [])
    .slice(0, 10_000)
    .map(entry => normalizeEntry(entry, strict))
    .filter(Boolean);

  const rawDeleted = input.deletedEntryIds === undefined ? [] : input.deletedEntryIds;
  if (!Array.isArray(rawDeleted)) invalid(strict, 'DELETED_IDS');
  const deletedEntryIds = [...new Set(
    (Array.isArray(rawDeleted) ? rawDeleted : []).map(id => safeId(id, strict)).filter(Boolean)
  )];

  const customCategories = Object.create(null);
  const rawCategories = normalizeRecord(input.customCategories, strict);
  Object.entries(rawCategories).slice(0, 200).forEach(([key, category]) => {
    const id = safeId(key, strict);
    const normalized = normalizeCategory(category, strict);
    if (id && normalized) customCategories[id] = normalized;
  });

  const customTagsByCat = Object.create(null);
  const rawTags = normalizeRecord(input.customTagsByCat, strict);
  Object.entries(rawTags).slice(0, 200).forEach(([key, tags]) => {
    const id = safeId(key, strict);
    if (!id) return;
    if (!Array.isArray(tags)) {
      invalid(strict, 'CUSTOM_TAGS');
      return;
    }
    customTagsByCat[id] = tags.map(tag => normalizeTag(tag, strict)).filter(Boolean).slice(0, 200);
  });

  const rawDurations = input.customDurations === undefined ? [] : input.customDurations;
  if (!Array.isArray(rawDurations)) invalid(strict, 'DURATIONS');
  const customDurations = (Array.isArray(rawDurations) ? rawDurations : [])
    .map(duration => normalizeDuration(duration, strict))
    .filter(Boolean)
    .slice(0, 200);

  const pdf = normalizeRecord(input.pdfOptions, strict);
  const lang = input.lang === 'en' ? 'en' : 'ru';
  if (input.lang !== undefined && input.lang !== 'ru' && input.lang !== 'en') invalid(strict, 'LANGUAGE');
  const tzOffsetMinutes = Number(input.tzOffsetMinutes);
  if (input.tzOffsetMinutes !== undefined && !SAFE_TIMEZONES.has(tzOffsetMinutes)) invalid(strict, 'TIMEZONE');

  return {
    lang,
    tzOffsetMinutes: SAFE_TIMEZONES.has(tzOffsetMinutes) ? tzOffsetMinutes : 180,
    entries,
    deletedEntryIds,
    customCategories,
    customTagsByCat,
    customDurations,
    pdfOptions: {
      sortMode: pdf.sortMode === 'time' ? 'time' : 'category',
      showTopKicker: pdf.showTopKicker !== false,
      showBotBrand: pdf.showBotBrand !== false,
      showFooter: pdf.showFooter !== false,
      customDocTitle: pdf.customDocTitle === null || pdf.customDocTitle === undefined
        ? null
        : safeText(pdf.customDocTitle, 200, strict),
      customDocSub: pdf.customDocSub === null || pdf.customDocSub === undefined
        ? null
        : safeText(pdf.customDocSub, 500, strict)
    }
  };
}

export function validateDiaryPayload(payload) {
  return normalizeDiaryPayload(payload, { strict: true });
}

export function getEntryRevision(entry) {
  return Number(entry?.updatedAtMs || entry?.timestampMs || 0);
}

export function mergeDiaryPayloads(localData, remoteData) {
  const local = normalizeDiaryPayload(localData);
  const remote = normalizeDiaryPayload(remoteData);
  const merged = { ...remote, ...local };
  const deletedEntryIds = new Set([...remote.deletedEntryIds, ...local.deletedEntryIds]);
  const entriesById = new Map();

  [...remote.entries, ...local.entries].forEach(entry => {
    if (deletedEntryIds.has(entry.id)) return;
    const previous = entriesById.get(entry.id);
    if (!previous || getEntryRevision(entry) >= getEntryRevision(previous)) {
      entriesById.set(entry.id, entry);
    }
  });

  merged.entries = [...entriesById.values()];
  merged.deletedEntryIds = [...deletedEntryIds];
  merged.customCategories = Object.assign(Object.create(null), remote.customCategories, local.customCategories);
  merged.customTagsByCat = Object.create(null);

  const tagCategoryKeys = new Set([
    ...Object.keys(remote.customTagsByCat),
    ...Object.keys(local.customTagsByCat)
  ]);
  tagCategoryKeys.forEach(categoryKey => {
    const tagsById = new Map();
    [
      ...(remote.customTagsByCat[categoryKey] || []),
      ...(local.customTagsByCat[categoryKey] || [])
    ].forEach(tag => tagsById.set(tag.id, tag));
    merged.customTagsByCat[categoryKey] = [...tagsById.values()];
  });

  const durationsById = new Map();
  [...remote.customDurations, ...local.customDurations].forEach(duration => {
    durationsById.set(duration.id, duration);
  });
  merged.customDurations = [...durationsById.values()];
  merged.pdfOptions = { ...remote.pdfOptions, ...local.pdfOptions };

  return normalizeDiaryPayload(merged);
}
