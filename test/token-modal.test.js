'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenModalId, verifyTokenModalId, TTL_MS } = require('../src/token-modal');

const key = 'f5'.repeat(32);
const otherKey = 'ab'.repeat(32);
const userId = '141947703742562304';
const guildId = '1516358993939922994';
const otherUser = '181947703742562304';
const otherGuild = '2516358993939922994';
const now = Date.UTC(2026, 10, 11, 7, 30);
function create(slot = 1) { return createTokenModalId({ slot, userId, guildId, key, now }); }
function check(customId, overrides = {}) {
  return verifyTokenModalId({ customId, userId, guildId, key, now, ...overrides });
}

test('all five reader slot modals validate independently', () => {
  for (let slot = 1; slot <= 5; slot++) {
    const customId = create(slot);
    assert.ok(customId.length <= 100, 'Discord accepts a 100-character custom ID');
    assert.equal(check(customId), slot);
  }
});

test('validation is stateless, so process restart loses no window state', () => {
  const id = create(3);
  delete require.cache[require.resolve('../src/token-modal')];
  const { verifyTokenModalId: coldVerify } = require('../src/token-modal');
  assert.equal(coldVerify({ customId:id,userId,guildId,key,now:now+120000 }), 3);
});

test('10-minute expiry and minor clock skew are respected', () => {
  const id = create(5);
  assert.equal(check(id, { now:now+TTL_MS }), 5);
  assert.equal(check(id, { now:now+TTL_MS+1 }), null);
  assert.equal(check(id, { now:now-30000 }), 5);
  assert.equal(check(id, { now:now-30001 }), null);
});

test('other user, guild or key cannot submit another modal', () => {
  const id = create(2);
  assert.equal(check(id, { userId:otherUser }), null);
  assert.equal(check(id, { guildId:otherGuild }), null);
  assert.equal(check(id, { key:otherKey }), null);
});

test('tampered slot, timestamp, signature and malformed IDs are rejected', () => {
  const id = create(4);
  const parts = id.split(':');
  assert.equal(check(id.replace(':4:', ':1:')), null);
  assert.equal(check(id.replace(parts[3], '1')), null);
  assert.equal(check(id.slice(0,-1) + (id.endsWith('0')?'1':'0')), null);
  assert.equal(check('reader-token:totally-unknown'), null);
  assert.equal(check('reader-token:v1:0:abc:'+'0'.repeat(32)), null);
  assert.equal(check('reader-token:v1:6:abc:'+'0'.repeat(32)), null);
  assert.equal(check(id + ':suffix'), null);
});

test('refuse bogus input on creation and verification', () => {
  assert.throws(() => create(0), RangeError);
  assert.throws(() => create(6), RangeError);
  assert.throws(() => createTokenModalId({slot:1,userId,guildId,key:'bad',now}),/key/i);
  assert.equal(check(''), null);
  assert.equal(check(create(), { userId:'xxx' }), null);
});
