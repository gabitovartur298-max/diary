export const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024; // Безопасно ниже лимита Vercel 4.5 МБ

const MAX_ENTRIES = 5000;
const MAX_DELETED_ENTRIES = 5000;
const MAX_CUSTOM_CATEGORIES = 40;
const MAX_TAGS_PER_CATEGORY = 50;
const MAX_CUSTOM_DURATIONS = 50;
const MAX_PHOTO_DATA_URL_LEN = 80000;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function cleanStr(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/\0/g, '').trim().slice(0, maxLen);
}

function cleanIcon(value) {
  const s = cleanStr(value, 16).replace(/[<>"'&]/g, '');
  return s || '🩺';
}

function cleanPhoto(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_PHOTO_DATA_URL_LEN) return null;
  return DATA_IMAGE_RE.test(value) ? value : null;
}

function cleanIdList(arr, maxItems) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const id = item.trim().slice(0, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= maxItems) break;
  }
  return out;
}

function toTimestamp(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sanitizeTag(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanStr(raw.id, 80);
  const ru = cleanStr(raw.ru || raw.en, 60);
  const en = cleanStr(raw.en || raw.ru, 60);
  if (!id || !ru) return null;
  return {
    id,
    ru,
    en: en || ru,
    isCustom: true,
    updatedAtMs: toTimestamp(raw.updatedAtMs, 1)
  };
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanStr(raw.id, 80);
  const category = cleanStr(raw.category, 80);
  const timestampMs = Number(raw.timestampMs);
  if (!id || !category || !Number.isFinite(timestampMs)) return null;

  let severity = null;
  if (raw.severity !== null && raw.severity !== undefined) {
    const s = Math.round(Number(raw.severity));
    if (Number.isFinite(s) && s >= 1 && s <= 10) {
      severity = s;
    }
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((t) => typeof t === 'string')
        .map((t) => cleanStr(t, 80))
        .filter(Boolean)
        .slice(0, 30)
    : [];

  const noteRu = cleanStr(raw.notes?.ru, 4000);
  const noteEn = cleanStr(raw.notes?.en, 4000);

  return {
    id,
    category,
    severity,
    duration: cleanStr(raw.duration, 80) || 'none',
    tags,
    notes: {
      ru: noteRu,
      en: noteEn
    },
    timestampMs,
    updatedAtMs: toTimestamp(raw.updatedAtMs, timestampMs)
  };
}

export function sanitizeDiaryPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const lang = raw.lang === 'en' ? 'en' : 'ru';
  const langUpdatedAtMs = toTimestamp(raw.langUpdatedAtMs, raw.lang ? 1 : 0);

  const tzId = typeof raw.tzId === 'string' ? cleanStr(raw.tzId, 64) : null;
  const tzOffsetNum = Number(raw.tzOffsetMinutes);
  const tzOffsetMinutes =
    Number.isFinite(tzOffsetNum) && tzOffsetNum >= -720 && tzOffsetNum <= 840
      ? Math.round(tzOffsetNum)
      : 180;
  const tzUpdatedAtMs = toTimestamp(
    raw.tzUpdatedAtMs,
    raw.tzId || raw.tzOffsetMinutes !== undefined ? 1 : 0
  );

  const entries = [];
  if (Array.isArray(raw.entries)) {
    for (const item of raw.entries) {
      const clean = sanitizeEntry(item);
      if (clean) entries.push(clean);
      if (entries.length >= MAX_ENTRIES) break;
    }
  }

  const customCategories = {};
  if (raw.customCategories && typeof raw.customCategories === 'object' && !Array.isArray(raw.customCategories)) {
    const keys = Object.keys(raw.customCategories).slice(0, MAX_CUSTOM_CATEGORIES);
    for (const rawKey of keys) {
      const key = cleanStr(rawKey, 80);
      if (!key || !key.startsWith('custom_')) continue;
      const c = raw.customCategories[rawKey];
      if (!c || typeof c !== 'object') continue;

      const nameRu = cleanStr(c.customName?.ru || c.customName?.en, 40);
      const nameEn = cleanStr(c.customName?.en || nameRu, 40);
      if (!nameRu) continue;

      const subRu = cleanStr(c.customSub?.ru, 50);
      const subEn = cleanStr(c.customSub?.en || subRu, 50);

      const catTags = [];
      if (Array.isArray(c.tags)) {
        for (const t of c.tags) {
          const cleanT = sanitizeTag(t);
          if (cleanT) catTags.push(cleanT);
          if (catTags.length >= MAX_TAGS_PER_CATEGORY) break;
        }
      }

      customCategories[key] = {
        icon: cleanIcon(c.icon),
        customPhoto: cleanPhoto(c.customPhoto),
        colorBg: 'bg-indigo-500/15',
        colorBorder: 'border-indigo-500',
        badgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
        isCustom: true,
        customName: { ru: nameRu, en: nameEn || nameRu },
        customSub: { ru: subRu, en: subEn || subRu },
        tags: catTags,
        updatedAtMs: toTimestamp(c.updatedAtMs, 1)
      };
    }
  }

  const customTagsByCat = {};
  if (raw.customTagsByCat && typeof raw.customTagsByCat === 'object' && !Array.isArray(raw.customTagsByCat)) {
    const catKeys = Object.keys(raw.customTagsByCat).slice(0, 60);
    for (const rawCatKey of catKeys) {
      const catKey = cleanStr(rawCatKey, 80);
      if (!catKey || !Array.isArray(raw.customTagsByCat[rawCatKey])) continue;
      const list = [];
      for (const t of raw.customTagsByCat[rawCatKey]) {
        const cleanT = sanitizeTag(t);
        if (cleanT) list.push(cleanT);
        if (list.length >= MAX_TAGS_PER_CATEGORY) break;
      }
      if (list.length > 0) {
        customTagsByCat[catKey] = list;
      }
    }
  }

  const customDurations = [];
  if (Array.isArray(raw.customDurations)) {
    for (const d of raw.customDurations) {
      if (!d || typeof d !== 'object') continue;
      const id = cleanStr(d.id, 80);
      const ru = cleanStr(d.ru || d.en, 40);
      const en = cleanStr(d.en || d.ru, 40);
      if (!id || !ru) continue;
      customDurations.push({
        id,
        ru,
        en: en || ru,
        isCustom: true,
        updatedAtMs: toTimestamp(d.updatedAtMs, 1)
      });
      if (customDurations.length >= MAX_CUSTOM_DURATIONS) break;
    }
  }

  const rawPdf = raw.pdfOptions && typeof raw.pdfOptions === 'object' ? raw.pdfOptions : {};
  const pdfOptions = {
    sortMode: rawPdf.sortMode === 'time' ? 'time' : 'category',
    showTopKicker: rawPdf.showTopKicker !== false,
    showBotBrand: rawPdf.showBotBrand !== false,
    showFooter: rawPdf.showFooter !== false,
    customDocTitle:
      typeof rawPdf.customDocTitle === 'string' && rawPdf.customDocTitle.trim()
        ? cleanStr(rawPdf.customDocTitle, 160)
        : null,
    customDocSub:
      typeof rawPdf.customDocSub === 'string' && rawPdf.customDocSub.trim()
        ? cleanStr(rawPdf.customDocSub, 240)
        : null,
    updatedAtMs: toTimestamp(rawPdf.updatedAtMs, raw.pdfOptions ? 1 : 0)
  };

  const clean = {
    lang,
    langUpdatedAtMs,
    tzId,
    tzOffsetMinutes,
    tzUpdatedAtMs,
    entries,
    deletedEntryIds: cleanIdList(raw.deletedEntryIds, MAX_DELETED_ENTRIES),
    customCategories,
    deletedCustomCategoryIds: cleanIdList(raw.deletedCustomCategoryIds, 500),
    customTagsByCat,
    deletedCustomTagIds: cleanIdList(raw.deletedCustomTagIds, 1000),
    customDurations,
    deletedCustomDurationIds: cleanIdList(raw.deletedCustomDurationIds, 500),
    pdfOptions
  };

  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_PAYLOAD_BYTES) {
    return null;
  }

  return clean;
}

export function mergeDiaryPayloads(existingRaw, incomingClean) {
  const existing = existingRaw && Object.keys(existingRaw).length > 0
    ? sanitizeDiaryPayload(existingRaw)
    : null;

  if (!existing) {
    return incomingClean;
  }

  const deletedEntryIds = new Set([
    ...existing.deletedEntryIds,
    ...incomingClean.deletedEntryIds
  ]);
  const deletedCustomCategoryIds = new Set([
    ...existing.deletedCustomCategoryIds,
    ...incomingClean.deletedCustomCategoryIds
  ]);
  const deletedCustomTagIds = new Set([
    ...existing.deletedCustomTagIds,
    ...incomingClean.deletedCustomTagIds
  ]);
  const deletedCustomDurationIds = new Set([
    ...existing.deletedCustomDurationIds,
    ...incomingClean.deletedCustomDurationIds
  ]);

  // Записи: побеждает более свежая updatedAtMs; удалённые не возвращаются
  const entriesById = new Map();
  for (const e of [...existing.entries, ...incomingClean.entries]) {
    if (deletedEntryIds.has(e.id) || deletedCustomCategoryIds.has(e.category)) continue;
    const prev = entriesById.get(e.id);
    if (!prev || e.updatedAtMs >= prev.updatedAtMs) {
      entriesById.set(e.id, e);
    }
  }

  // Пользовательские категории (с учётом удалений)
  const customCategories = {};
  const catKeys = new Set([
    ...Object.keys(existing.customCategories),
    ...Object.keys(incomingClean.customCategories)
  ]);
  for (const key of catKeys) {
    if (deletedCustomCategoryIds.has(key)) continue;
    const a = existing.customCategories[key];
    const b = incomingClean.customCategories[key];
    const chosen = !a ? b : !b ? a : b.updatedAtMs >= a.updatedAtMs ? b : a;

    // Сливаем теги внутри пользовательской категории
    const tagsMap = new Map();
    for (const t of [...(a?.tags || []), ...(b?.tags || [])]) {
      if (deletedCustomTagIds.has(t.id)) continue;
      const prev = tagsMap.get(t.id);
      if (!prev || t.updatedAtMs >= prev.updatedAtMs) {
        tagsMap.set(t.id, t);
      }
    }
    customCategories[key] = { ...chosen, tags: [...tagsMap.values()].slice(0, MAX_TAGS_PER_CATEGORY) };
  }

  // Пользовательские теги для стандартных категорий
  const customTagsByCat = {};
  const tagCatKeys = new Set([
    ...Object.keys(existing.customTagsByCat),
    ...Object.keys(incomingClean.customTagsByCat)
  ]);
  for (const catKey of tagCatKeys) {
    if (deletedCustomCategoryIds.has(catKey)) continue;
    const tagsMap = new Map();
    for (const t of [
      ...(existing.customTagsByCat[catKey] || []),
      ...(incomingClean.customTagsByCat[catKey] || [])
    ]) {
      if (deletedCustomTagIds.has(t.id)) continue;
      const prev = tagsMap.get(t.id);
      if (!prev || t.updatedAtMs >= prev.updatedAtMs) {
        tagsMap.set(t.id, t);
      }
    }
    if (tagsMap.size > 0) {
      customTagsByCat[catKey] = [...tagsMap.values()].slice(0, MAX_TAGS_PER_CATEGORY);
    }
  }

  // Пользовательские длительности
  const durationsMap = new Map();
  for (const d of [...existing.customDurations, ...incomingClean.customDurations]) {
    if (deletedCustomDurationIds.has(d.id)) continue;
    const prev = durationsMap.get(d.id);
    if (!prev || d.updatedAtMs >= prev.updatedAtMs) {
      durationsMap.set(d.id, d);
    }
  }

  const pickLangFromIncoming = incomingClean.langUpdatedAtMs >= existing.langUpdatedAtMs;
  const pickTzFromIncoming = incomingClean.tzUpdatedAtMs >= existing.tzUpdatedAtMs;
  const pickPdfFromIncoming = incomingClean.pdfOptions.updatedAtMs >= existing.pdfOptions.updatedAtMs;

  const sortedEntries = [...entriesById.values()]
    .sort((a, b) => b.timestampMs - a.timestampMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, MAX_ENTRIES);

  return {
    lang: pickLangFromIncoming ? incomingClean.lang : existing.lang,
    langUpdatedAtMs: Math.max(incomingClean.langUpdatedAtMs, existing.langUpdatedAtMs),
    tzId: pickTzFromIncoming ? incomingClean.tzId : existing.tzId,
    tzOffsetMinutes: pickTzFromIncoming ? incomingClean.tzOffsetMinutes : existing.tzOffsetMinutes,
    tzUpdatedAtMs: Math.max(incomingClean.tzUpdatedAtMs, existing.tzUpdatedAtMs),
    entries: sortedEntries,
    deletedEntryIds: [...deletedEntryIds].slice(-MAX_DELETED_ENTRIES),
    customCategories,
    deletedCustomCategoryIds: [...deletedCustomCategoryIds].slice(-500),
    customTagsByCat,
    deletedCustomTagIds: [...deletedCustomTagIds].slice(-1000),
    customDurations: [...durationsMap.values()].slice(0, MAX_CUSTOM_DURATIONS),
    deletedCustomDurationIds: [...deletedCustomDurationIds].slice(-500),
    pdfOptions: pickPdfFromIncoming ? incomingClean.pdfOptions : existing.pdfOptions
  };
}
