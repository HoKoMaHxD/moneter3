'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const PREFIX = 'reader-token';
const VERSION = 'v1';
const TTL_MS = 10 * 60 * 1000;
const ALLOWED_CLOCK_SKEW_MS = 30 * 1000;

// The modal ID is self-contained and authenticated. Do not keep its validity
// solely in process memory: Discord may submit it after a process restart.
function signature({ slot, timestamp, userId, guildId, key }) {
  const payload = `snow-reader-token-modal:${VERSION}:${guildId}:${userId}:${slot}:${timestamp}`;
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(payload, 'utf8').digest().subarray(0, 16).toString('hex');
}

function createTokenModalId({ slot, userId, guildId, key, now = Date.now() }) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) throw new RangeError('Invalid reader slot');
  if (!/^\d{17,20}$/.test(String(userId)) || !/^\d{17,20}$/.test(String(guildId))) throw new Error('Invalid account or server ID');
  if (!/^[a-f\d]{64}$/i.test(String(key))) throw new Error('Invalid encryption key');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid timestamp');
  const timestamp = now.toString(36);
  const mac = signature({ slot, timestamp, userId, guildId, key });
  const customId = `${PREFIX}:${VERSION}:${slot}:${timestamp}:${mac}`;
  if (customId.length > 100) throw new Error('Discord modal ID is too long');
  return customId;
}

function verifyTokenModalId({ customId, userId, guildId, key, now = Date.now() }) {
  if (typeof customId !== 'string' || !/^reader-token:v1:[1-5]:[0-9a-z]{1,12}:[0-9a-f]{32}$/.test(customId)) return null;
  if (!/^\d{17,20}$/.test(String(userId)) || !/^\d{17,20}$/.test(String(guildId))) return null;
  if (!/^[a-f\d]{64}$/i.test(String(key)) || !Number.isSafeInteger(now)) return null;
  const [, , slotText, timestamp, providedMac] = customId.split(':');
  const issuedAt = parseInt(timestamp, 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > now + ALLOWED_CLOCK_SKEW_MS || now - issuedAt > TTL_MS) return null;
  // Canonical timestamp encoding avoids accepting alternate representations.
  if (issuedAt.toString(36) !== timestamp) return null;
  const slot = Number(slotText);
  const expectedMac = signature({ slot, timestamp, userId, guildId, key });
  if (!timingSafeEqual(Buffer.from(providedMac, 'hex'), Buffer.from(expectedMac, 'hex'))) return null;
  return slot;
}

module.exports = { createTokenModalId, verifyTokenModalId, TTL_MS };
