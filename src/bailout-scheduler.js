'use strict';

class BailoutScheduler {
  constructor({ delayMs = 10000, onCommit, onError = console.error }) {
    this.delayMs = Math.max(1000, Number(delayMs) || 10000);
    this.onCommit = onCommit;
    this.onError = onError;
    this.byMessage = new Map();
    this.byPlayer = new Map();
  }

  playerKey(record) { return `${record.chatId}:${record.openId}`; }

  schedule(record) {
    if (!record.messageId) throw new Error('补充口令缺少消息 ID，请重新发送');
    const playerKey = this.playerKey(record);
    if (this.byPlayer.has(playerKey)) throw new Error('你已有一条补充口令等待到账，请勿重复发送');
    const pending = { ...record, playerKey, timer: null };
    pending.timer = setTimeout(async () => {
      try {
        await this.commit(record.messageId);
      } catch (error) {
        try { await this.onError(error, pending); } catch (reportError) { console.error('报告补充筹码错误失败：', reportError); }
      }
    }, this.delayMs);
    this.byMessage.set(record.messageId, pending);
    this.byPlayer.set(playerKey, record.messageId);
    return pending;
  }

  take(messageId) {
    const pending = this.byMessage.get(messageId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.byMessage.delete(messageId);
    this.byPlayer.delete(pending.playerKey);
    return pending;
  }

  cancel(messageId) { return this.take(messageId); }

  cancelChat(chatId) {
    const cancelled = [];
    for (const [messageId, pending] of this.byMessage) {
      if (pending.chatId !== chatId) continue;
      const record = this.take(messageId);
      if (record) cancelled.push(record);
    }
    return cancelled;
  }

  async commit(messageId) {
    const pending = this.take(messageId);
    if (!pending) return false;
    await this.onCommit(pending);
    return true;
  }

  shutdown() {
    for (const pending of this.byMessage.values()) clearTimeout(pending.timer);
    this.byMessage.clear();
    this.byPlayer.clear();
  }
}

module.exports = { BailoutScheduler };
