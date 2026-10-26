'use strict';

const fs = require('node:fs');
const path = require('node:path');

class TableStateStore {
  constructor(filePath) { this.filePath = filePath; }

  load() {
    try {
      if (!this.filePath || !fs.existsSync(this.filePath)) return { sequence: 0, tables: [], bankrolls: {} };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        sequence: Number.isSafeInteger(parsed.sequence) ? parsed.sequence : 0,
        tables: Array.isArray(parsed.tables) ? parsed.tables : [],
        bankrolls: parsed.bankrolls && typeof parsed.bankrolls === 'object' && !Array.isArray(parsed.bankrolls)
          ? parsed.bankrolls
          : {},
      };
    } catch (error) {
      console.error('读取牌桌恢复文件失败，将以空牌桌启动：', error.message || error);
      return { sequence: 0, tables: [], bankrolls: {} };
    }
  }

  save(sequence, tables, bankrolls = {}) {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = { version: 2, savedAt: new Date().toISOString(), sequence, tables, bankrolls };
    fs.writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

module.exports = { TableStateStore };
