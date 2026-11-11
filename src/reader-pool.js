'use strict';
const { ready } = require('./reader-switch');
const MAX_READERS = 5;

// Owns independent reader sessions. Each scan receives exactly one reader,
// so a scan never mixes data from different accounts mid-flight.
class ReaderPool {
  constructor({ makeClient, database, arenaId, scanner, onSecret = () => {}, onClient = () => {}, onChange = () => {} }) {
    Object.assign(this, { makeClient, database, arenaId, scanner, onSecret, onClient, onChange });
    this.slots = Array.from({ length: MAX_READERS }, () => ({ client: null, configured: false, error: '' }));
    this.busy = false;
    this.cursor = 0;
    this.lastUsed = null;
  }
  index(number) {
    if (!Number.isInteger(number) || number < 1 || number > MAX_READERS)
      throw new Error('رقم القارئ يجب أن يكون من 1 إلى 5.');
    return number - 1;
  }
  isCurrent(number, client) { return this.slots[this.index(number)].client === client; }
  states() {
    return this.slots.map((slot, i) => ({
      number: i + 1,
      configured: slot.configured,
      connected: !!slot.client?.isReady() && !!slot.client?.guilds?.cache?.has(this.arenaId),
      detail: !slot.configured ? 'غير مُعدّ' : slot.client?.isReady() && slot.client.guilds.cache.has(this.arenaId) ? 'متصل' : slot.error || 'غير متصل',
    }));
  }
  countReady() { return this.states().filter(s => s.connected).length; }
  nextReader() {
    for (let i = 0; i < MAX_READERS; i++) {
      const index = (this.cursor + i) % MAX_READERS;
      const slot = this.slots[index];
      if (slot.client?.isReady() && slot.client.guilds.cache.has(this.arenaId)) {
        this.cursor = (index + 1) % MAX_READERS;
        this.lastUsed = index + 1;
        return slot.client;
      }
    }
    throw new Error('لا يوجد قارئ متصل بأرينا. استخدم /حالة لفحص القراء الخمسة.');
  }
  notify(number, client, detail) {
    const slot = this.slots[this.index(number)];
    if (slot.client !== client) return;
    slot.error = detail;
    this.scanner.lastDirty = true;
    this.onChange();
  }
  async boot(number, token, timeout = 65000) {
    const slot = this.slots[this.index(number)];
    if (!token?.trim()) return false;
    slot.configured = true;
    slot.error = 'جاري الاتصال';
    this.onSecret(token);
    const client = this.makeClient(number);
    slot.client = client;
    this.onClient(number, client);
    try {
      await ready(client, token, timeout);
      if (!client.guilds.cache.has(this.arenaId)) throw new Error('الحساب ليس في سيرفر أرينا.');
      slot.error = '';
      this.onChange();
      return true;
    } catch (error) {
      slot.error = client.disabledCode || error.message || 'فشل الاتصال';
      client.destroy();
      slot.client = null;
      this.onChange();
      return false;
    }
  }
  async replace(number, token, actor) {
    const slot = this.slots[this.index(number)];
    if (this.busy) throw new Error('يوجد تحديث توكن جارٍ الآن.');
    if (typeof token !== 'string' || token.trim().length < 20 || token.trim().length > 300 || /\s/.test(token.trim()))
      throw new Error('صيغة التوكن غير صحيحة.');
    token = token.trim();
    this.busy = true;
    this.scanner.paused = true;
    this.onSecret(token);
    let candidate;
    try {
      candidate = this.makeClient(number);
      candidate.on('error', () => {});
      this.onClient(number, candidate);
      await ready(candidate, token, 65000);
      if (!candidate.guilds.cache.has(this.arenaId)) throw new Error('الحساب الجديد ليس موجودًا في أرينا.');
      if (this.scanner.active) await this.scanner.active.promise.catch(() => {});
      await this.database.saveToken(token, actor, number);
      const previous = slot.client;
      slot.client = candidate;
      slot.configured = true;
      slot.error = '';
      candidate = null;
      if (previous) previous.destroy();
      this.scanner.lastDirty = true;
      this.onChange();
      return true;
    } finally {
      if (candidate) candidate.destroy();
      this.scanner.paused = false;
      this.busy = false;
    }
  }
  destroy() { for (const slot of this.slots) { slot.client?.destroy(); slot.client = null; } }
}
module.exports = { ReaderPool, MAX_READERS };
