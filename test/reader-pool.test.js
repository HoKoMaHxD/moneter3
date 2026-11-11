'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ReaderPool } = require('../src/reader-pool');
const TOKEN = 'private-test-token-not-real-0123456789';
function fakeClient({ badLogin = false } = {}) {
  const c = new EventEmitter();
  c.online = false;
  c.guilds = { cache: new Map([['arena', {}]]) };
  c.isReady = () => c.online && !c.destroyed;
  c.login = async () => { if (badLogin) throw Error('Rejected'); c.online = true; c.emit('ready'); };
  c.destroy = () => { c.destroyed = true; c.online = false; };
  return c;
}
function fixture() {
  const saved = [];
  const clients = [];
  const scanner = { paused:false, lastDirty:false };
  const pool = new ReaderPool({makeClient: () => { const c=fakeClient();clients.push(c);return c;},
    database:{saveToken: async (token,owner,number)=>saved.push([token,owner,number])},
    scanner,arenaId:'arena'});
  return {pool,scanner,saved,clients};
}
test('five independent slots; only connected slots are rotated', async()=>{
  const f=fixture();
  assert.equal(f.pool.countReady(),0);
  await f.pool.boot(1,TOKEN);
  await f.pool.boot(3,TOKEN);
  await f.pool.boot(5,TOKEN);
  assert.deepEqual(f.pool.states().map(s=>s.connected),[true,false,true,false,true]);
  assert.deepEqual(Array.from({length:7},()=>{f.pool.nextReader();return f.pool.lastUsed;}),[1,3,5,1,3,5,1]);
  f.clients[1].destroy();
  assert.deepEqual(Array.from({length:4},()=>{f.pool.nextReader();return f.pool.lastUsed;}),[5,1,5,1]);
  assert.equal(f.pool.countReady(),2);
});
test('slot update preserves other readers and saves selected slot only',async()=>{
  const f=fixture();
  await f.pool.boot(1,TOKEN);
  await f.pool.boot(2,TOKEN);
  const first=f.pool.slots[0].client,oldSecond=f.pool.slots[1].client;
  await f.pool.replace(2,TOKEN+'X','admin');
  assert.equal(first.destroyed,undefined);
  assert.equal(oldSecond.destroyed,true);
  assert.equal(f.pool.slots[0].client,first);
  assert.deepEqual(f.saved,[[TOKEN+'X','admin',2]]);
  assert.equal(f.scanner.paused,false);
  assert.ok(!JSON.stringify(f.pool.states()).includes(TOKEN));
});
test('failed save preserves old reader; invalid index rejected',async()=>{
  const f=fixture();await f.pool.boot(4,TOKEN);
  const old=f.pool.slots[3].client;
  f.pool.database.saveToken=async()=>{throw Error('storage unavailable');};
  await assert.rejects(f.pool.replace(4,TOKEN+'X','admin'),/storage unavailable/);
  assert.equal(f.pool.slots[3].client,old);
  assert.equal(old.destroyed,undefined);
  assert.equal(f.pool.countReady(),1);
  assert.equal(f.scanner.paused,false);
  await assert.rejects(f.pool.replace(6,TOKEN,'admin'),/1 إلى 5/);
});
