'use strict';

const { StatsStore } = require('./stats-store');

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function chinaParts(now = new Date()) {
  const shifted = new Date(now.getTime() + CHINA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(), hour: shifted.getUTCHours(),
  };
}

function previousChinaDateKey(now = new Date()) {
  return StatsStore.chinaDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

function millisecondsUntilNextChinaNine(now = new Date()) {
  const parts = chinaParts(now);
  let target = Date.UTC(parts.year, parts.month, parts.day, 1, 0, 0, 0);
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return target - now.getTime();
}

class DailyTitleScheduler {
  constructor({ statsStore, targetChatId, onPublish, now = () => new Date() }) {
    this.statsStore = statsStore;
    this.targetChatId = targetChatId;
    this.onPublish = onPublish;
    this.now = now;
    this.timer = null;
  }

  async publishPreviousDay() {
    if (!this.targetChatId) return false;
    const dateKey = previousChinaDateKey(this.now());
    if (this.statsStore.wasDailySent(dateKey)) return false;
    const titles = this.statsStore.dailyTitles(dateKey, this.targetChatId);
    if (!titles.length) return false;
    await this.onPublish({ type: 'daily_title_card', chatId: this.targetChatId, dateKey, titles, fallbackText: `🏅 ${dateKey} 每日牌桌称号\n${titles.map((item) => `${item.title}：${item.player.name}（${item.detail}）`).join('\n')}` });
    this.statsStore.markDailySent(dateKey);
    return true;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try { await this.publishPreviousDay(); } catch (error) { console.error('发送每日称号失败：', error); }
      this.schedule();
    }, millisecondsUntilNextChinaNine(this.now()));
  }

  start() {
    if (chinaParts(this.now()).hour >= 9) this.publishPreviousDay().catch((error) => console.error('补发每日称号失败：', error));
    this.schedule();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }
}

module.exports = { DailyTitleScheduler, previousChinaDateKey, millisecondsUntilNextChinaNine };
