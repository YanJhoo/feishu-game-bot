'use strict';

class RecentMessageDeduper {
  constructor({ ttlMs = 10 * 60 * 1000, maximum = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.maximum = maximum;
    this.items = new Map();
  }

  seen(id) {
    if (!id) return false;
    const now = Date.now();
    const previous = this.items.get(id);
    if (previous && now - previous < this.ttlMs) return true;
    this.items.set(id, now);
    if (this.items.size > this.maximum) this.prune(now);
    return false;
  }

  prune(now = Date.now()) {
    for (const [id, timestamp] of this.items) {
      if (now - timestamp >= this.ttlMs || this.items.size > this.maximum) this.items.delete(id);
    }
  }
}

class ChatQueue {
  constructor() { this.chains = new Map(); }

  enqueue(chatId, task) {
    const previous = this.chains.get(chatId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const clear = () => {
      if (this.chains.get(chatId) === cleanup) this.chains.delete(chatId);
    };
    // The chain stored for later work must never remain rejected, otherwise
    // its cleanup promise can become an unhandled rejection and stop Node.
    const cleanup = next.then(clear, clear);
    this.chains.set(chatId, cleanup);
    return next;
  }
}

module.exports = { RecentMessageDeduper, ChatQueue };
