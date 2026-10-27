'use strict';

const { writeJsonAtomic, readJsonSafe } = require('./json-file');

function normalizePlayerStats(record, openId, name) {
  const existing = record || { openId, name: name || '玩家', hands: 0, wins: 0, totalNet: 0, biggestWin: 0 };
  if (name) existing.name = name;
  if (!Number.isSafeInteger(existing.bailoutCount)) existing.bailoutCount = 0;
  if (!Number.isSafeInteger(existing.bailoutTotal)) existing.bailoutTotal = 0;
  if (!existing.bailoutPhrases || typeof existing.bailoutPhrases !== 'object') existing.bailoutPhrases = {};
  return existing;
}

function sortStats(list) {
  return list.sort((a, b) => b.wins - a.wins || b.totalNet - a.totalNet || a.name.localeCompare(b.name, 'zh-CN'));
}

class StatsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 2, players: {}, chats: {} };
    this.load();
  }
  static chinaDateKey(date = new Date()) {
    const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return china.toISOString().slice(0, 10);
  }
  load() {
    const parsed = readJsonSafe(this.filePath, '永久战绩文件');
    if (parsed && parsed.players && typeof parsed.players === 'object') this.data = parsed;
    if (!this.data.chats || typeof this.data.chats !== 'object') this.migrateToPerChat();
  }
  save() {
    writeJsonAtomic(this.filePath, this.data);
  }

  // Version 1 kept one global record per player, so “战绩” showed players
  // from every group. Move old totals into the group they came from when that
  // can be worked out from the daily and undercover records.
  migrateToPerChat() {
    const chats = {};
    const knownChats = new Set([
      ...Object.values(this.data.daily || {}).flatMap((day) => Object.keys(day?.chats || {})),
      ...Object.keys(this.data.undercover || {}),
      ...Object.keys(this.data.undercoverAliases || {}),
    ]);
    const chatsOfPlayer = (openId) => new Set(Object.values(this.data.daily || {})
      .flatMap((day) => Object.entries(day?.chats || {}))
      .filter(([, chat]) => chat?.players?.[openId])
      .map(([chatId]) => chatId));
    for (const [openId, record] of Object.entries(this.data.players || {})) {
      const playerChats = knownChats.size === 1 ? knownChats : chatsOfPlayer(openId);
      if (playerChats.size !== 1) continue;
      const [chatId] = playerChats;
      if (!chats[chatId]) chats[chatId] = { players: {} };
      chats[chatId].players[openId] = JSON.parse(JSON.stringify(record));
    }
    this.data.chats = chats;
    this.data.version = 2;
  }

  ensurePlayer(openId, name) {
    const existing = normalizePlayerStats(this.data.players[openId], openId, name);
    this.data.players[openId] = existing;
    return existing;
  }
  ensureChatPlayer(chatId, openId, name) {
    const chat = this.data.chats[chatId] || { players: {} };
    const existing = normalizePlayerStats(chat.players[openId], openId, name);
    chat.players[openId] = existing;
    this.data.chats[chatId] = chat;
    return existing;
  }
  // Records to update for one player: the global total and, when known, the group's.
  recordsFor(player, chatId) {
    const records = [this.ensurePlayer(player.openId, player.name)];
    if (chatId) records.push(this.ensureChatPlayer(chatId, player.openId, player.name));
    return records;
  }
  ensureDaily() {
    if (!this.data.daily || typeof this.data.daily !== 'object') this.data.daily = {};
    if (!this.data.dailySent || typeof this.data.dailySent !== 'object') this.data.dailySent = {};
  }
  ensureDailyPlayer(dateKey, chatId, player) {
    this.ensureDaily();
    const day = this.data.daily[dateKey] || { chats: {} };
    const chat = day.chats[chatId] || { players: {} };
    const stats = chat.players[player.openId] || { openId: player.openId, name: player.name || '玩家', hands: 0, wins: 0, net: 0, allIns: 0, folds: 0, bailoutCount: 0, bailoutTotal: 0, biggestPot: 0 };
    if (player.name) stats.name = player.name;
    chat.players[player.openId] = stats;
    day.chats[chatId] = chat;
    this.data.daily[dateKey] = day;
    return stats;
  }
  recordHand(players, meta = {}) {
    for (const player of players) {
      const payout = Number(player.payout) || 0;
      const net = payout - (Number(player.contributed) || 0);
      for (const stats of this.recordsFor(player, meta.chatId)) {
        stats.hands += 1;
        if (payout > 0) stats.wins += 1;
        stats.totalNet += net;
        stats.biggestWin = Math.max(stats.biggestWin, net);
      }
      if (meta.chatId) {
        const daily = this.ensureDailyPlayer(StatsStore.chinaDateKey(), meta.chatId, player);
        daily.hands += 1;
        daily.wins += payout > 0 ? 1 : 0;
        daily.net += net;
        daily.allIns += Number(player.allIns) || 0;
        daily.folds += Number(player.folds) || 0;
        daily.biggestPot = Math.max(daily.biggestPot, Number(meta.potSize) || 0);
      }
    }
    this.save();
    return this.snapshot(players.map((player) => player.openId));
  }
  recordBailout(player, tier, grant, chatId = null) {
    const records = this.recordsFor(player, chatId);
    for (const record of records) {
      record.bailoutCount += 1;
      record.bailoutTotal += Number(grant) || 0;
      record.lastBailoutPhrase = tier.phrase;
      record.bailoutPhrases[tier.phrase] = (Number(record.bailoutPhrases[tier.phrase]) || 0) + 1;
    }
    const stats = records[records.length - 1];
    if (chatId) {
      const daily = this.ensureDailyPlayer(StatsStore.chinaDateKey(), chatId, player);
      daily.bailoutCount += 1;
      daily.bailoutTotal += Number(grant) || 0;
    }
    this.save();
    return { ...stats, bailoutPhrases: { ...stats.bailoutPhrases } };
  }
  snapshot(openIds) {
    return sortStats(openIds.map((id) => this.data.players[id]).filter(Boolean).map((stats) => {
      const normalized = this.ensurePlayer(stats.openId, stats.name);
      return { ...normalized, bailoutPhrases: { ...normalized.bailoutPhrases } };
    }));
  }
  snapshotAll() { return this.snapshot(Object.keys(this.data.players)); }
  // “战绩” in a group only shows hands played in that group.
  snapshotChat(chatId) {
    const players = Object.values(this.data.chats?.[chatId]?.players || {});
    return sortStats(players.map((record) => {
      const normalized = normalizePlayerStats(record, record.openId, record.name);
      return { ...normalized, bailoutPhrases: { ...normalized.bailoutPhrases } };
    }));
  }

  ensureUndercover() {
    if (!this.data.undercover || typeof this.data.undercover !== 'object') this.data.undercover = {};
  }
  lastUndercoverAlias(chatId, openId) {
    if (!this.data.undercoverAliases || typeof this.data.undercoverAliases !== 'object') this.data.undercoverAliases = {};
    return this.data.undercoverAliases[chatId]?.[openId] || null;
  }
  rememberUndercoverAliases(chatId, players) {
    if (!this.data.undercoverAliases || typeof this.data.undercoverAliases !== 'object') this.data.undercoverAliases = {};
    const chat = this.data.undercoverAliases[chatId] || {};
    for (const player of players) if (player.openId && player.anonymousName) chat[player.openId] = player.anonymousName;
    this.data.undercoverAliases[chatId] = chat;
    this.save();
  }
  recordUndercoverGame(chatId, players, winner) {
    this.ensureUndercover();
    const chat = this.data.undercover[chatId] || { players: {} };
    for (const player of players) {
      const stats = chat.players[player.openId] || { openId: player.openId, name: player.name || '玩家', games: 0, wins: 0, points: 0, undercoverGames: 0, undercoverWins: 0 };
      stats.name = player.name || stats.name;
      stats.games += 1;
      const won = player.isUndercover ? winner === '卧底' : winner === '平民';
      if (player.isUndercover) stats.undercoverGames += 1;
      if (won) stats.wins += 1;
      if (player.isUndercover && won) stats.undercoverWins += 1;
      stats.points += won ? (player.isUndercover ? 2 : 1) : 0;
      chat.players[player.openId] = stats;
    }
    this.data.undercover[chatId] = chat;
    this.save();
    return this.undercoverScores(chatId, players.map((player) => player.openId));
  }
  undercoverScores(chatId, openIds = null) {
    this.ensureUndercover();
    const values = Object.values(this.data.undercover[chatId]?.players || {});
    const allowed = openIds ? new Set(openIds) : null;
    return values.filter((item) => !allowed || allowed.has(item.openId)).map((item) => ({ ...item }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name, 'zh-CN'));
  }

  dailyTitles(dateKey, chatId) {
    this.ensureDaily();
    const players = Object.values(this.data.daily?.[dateKey]?.chats?.[chatId]?.players || {});
    if (!players.length) return [];
    const maxBy = (field, direction = 1) => players.slice().sort((a, b) => direction * ((Number(b[field]) || 0) - (Number(a[field]) || 0)) || a.name.localeCompare(b.name, 'zh-CN'))[0];
    const titles = [];
    const profit = maxBy('net');
    const unlucky = maxBy('net', -1);
    titles.push({ icon: '🏆', title: '今日盈利王', player: profit, detail: `净胜负 ${profit.net >= 0 ? '+' : ''}${profit.net}` });
    titles.push({ icon: '🥀', title: '今日冤种', player: unlucky, detail: `净胜负 ${unlucky.net >= 0 ? '+' : ''}${unlucky.net}` });
    for (const [field, icon, title, detail] of [
      ['allIns', '🔥', '最爱 All-in', 'All-in'],
      ['folds', '🛡️', '弃牌大师', '弃牌'],
      ['bailoutCount', '🆘', '补充筹码之王', '补充'],
      ['biggestPot', '💰', '最大底池制造者', '参与最大底池'],
    ]) {
      const player = maxBy(field);
      if ((Number(player[field]) || 0) > 0) titles.push({ icon, title, player, detail: `${detail} ${player[field]}${field === 'biggestPot' ? '' : ' 次'}` });
    }
    return titles;
  }

  wasDailySent(dateKey) { this.ensureDaily(); return Boolean(this.data.dailySent[dateKey]); }
  markDailySent(dateKey) { this.ensureDaily(); this.data.dailySent[dateKey] = true; this.save(); }
}

module.exports = { StatsStore };
