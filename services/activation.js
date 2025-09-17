'use strict';

function buildActivationRegex(pattern) {
  try {
    if (pattern && typeof pattern === 'string') {
      return new RegExp(pattern, 'i');
    }
  } catch {}
  // Default: optional greeting + assistant name variants, followed by optional punctuation/space
  return /(?:^|\b)(?:\s*(hey|ok|yo|hi|hello)\s*,?\s*)?(omi|jarvis|echo|assistant)\b[,:\-\s]*/i;
}

function parseTimeToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function withinQuietHours(preferences, nowDate = new Date()) {
  if (!preferences) return false;
  if (preferences.mute) return true; // hard mute overrides
  const start = parseTimeToMinutes(preferences.dndQuietHoursStart);
  const end = parseTimeToMinutes(preferences.dndQuietHoursEnd);
  if (start == null || end == null) return false;
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  if (start === end) return false; // no-op window
  if (start < end) {
    return nowMinutes >= start && nowMinutes < end;
  }
  // Window crosses midnight
  return nowMinutes >= start || nowMinutes < end;
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]/g, '')
    .trim();
}

function isNearDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.includes(shorter)) {
    return shorter.length / longer.length >= 0.9;
  }
  return false;
}

module.exports = {
  buildActivationRegex,
  withinQuietHours,
  normalizeText,
  isNearDuplicate
};

