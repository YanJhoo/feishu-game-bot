'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Write to a temporary file first, then swap it in. A crash or power cut can
// then never leave a half-written file in place of the real one.
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    // Windows can refuse a rename while another program (antivirus, backup)
    // has the target open. Fall back to copying over it.
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    fs.copyFileSync(temporary, filePath);
    fs.rmSync(temporary, { force: true });
  }
}

// Returns the parsed file, or null when it does not exist. A file that exists
// but cannot be parsed is kept as a dated backup so the next save cannot
// silently replace the only copy of the data.
function readJsonSafe(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${filePath}.corrupt-${stamp}`;
    try { fs.copyFileSync(filePath, backup); } catch (copyError) { console.error(`备份损坏的${label}失败：`, copyError.message || copyError); }
    console.error(`${label}已损坏（${error.message}），原文件已备份为 ${backup}，本次以空数据启动。`);
    return null;
  }
}

module.exports = { writeJsonAtomic, readJsonSafe };
