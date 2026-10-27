'use strict';

const { writeJsonAtomic, readJsonSafe } = require('./json-file');

const EMPTY_STATE = Object.freeze({ sequence: 0, tables: [], bankrolls: {}, games: null });

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

class TableStateStore {
  constructor(filePath) { this.filePath = filePath; }

  load() {
    if (!this.filePath) return { ...EMPTY_STATE };
    try {
      const parsed = readJsonSafe(this.filePath, '牌桌恢复文件');
      if (!parsed) return { ...EMPTY_STATE };
      return {
        sequence: Number.isSafeInteger(parsed.sequence) ? parsed.sequence : 0,
        tables: Array.isArray(parsed.tables) ? parsed.tables : [],
        bankrolls: plainObject(parsed.bankrolls) ? parsed.bankrolls : {},
        games: plainObject(parsed.games) ? parsed.games : null,
      };
    } catch (error) {
      console.error('读取牌桌恢复文件失败，将以空牌桌启动：', error.message || error);
      return { ...EMPTY_STATE };
    }
  }

  save(sequence, tables, bankrolls = {}, games = null) {
    if (!this.filePath) return;
    const payload = { version: 3, savedAt: new Date().toISOString(), sequence, tables, bankrolls };
    if (games) payload.games = games;
    writeJsonAtomic(this.filePath, payload);
  }
}

module.exports = { TableStateStore };
