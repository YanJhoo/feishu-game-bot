'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PokerTable } = require('../src/table');
const { PHASES } = require('../src/constants');
const { TableManager } = require('../src/table-manager');
const { StatsStore } = require('../src/stats-store');
const { TableStateStore } = require('../src/table-state-store');
const { writeJsonAtomic, readJsonSafe } = require('../src/json-file');
const { bailoutTiers, bailoutTierForPhrase, DEFAULT_PHRASES } = require('../src/bailout');
const { withRateLimitRetry } = require('../src/feishu-transport');

const noStats = () => ({ recordHand: () => [], snapshotAll: () => [], snapshotChat: () => [] });
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `feishu-game-${name}-`));

function fourPlayerTable() {
  const table = new PokerTable({ chatId: 'c', roomId: 'r', ownerOpenId: 'a', config: { startingStack: 1000, smallBlind: 5, bigBlind: 10 } });
  for (const id of ['a', 'b', 'c', 'd']) table.join({ openId: id, name: id });
  table.buttonSeat = 4; // next hand: button seat 1, SB 2, BB 3, first to act seat 4
  table.startHand();
  table.drainEvents();
  return table;
}

test('别人离桌时，正在行动的玩家保留行动权', () => {
  const table = fourPlayerTable();
  assert.equal(table.buttonSeat, 1);
  assert.equal(table.activeSeat, 4);
  const version = table.turnVersion;
  table.leave('b'); // small blind leaves while seat 4 is acting
  assert.equal(table.activeSeat, 4);
  assert.equal(table.turnVersion, version, '当前行动卡片不应失效');
  assert.equal(table.playerById('b').folded, true);
  table.call('d');
  assert.equal(table.playerAtSeat(table.activeSeat).openId, 'a');
});

test('当前行动的玩家离桌时，轮到下一位', () => {
  const table = fourPlayerTable();
  table.leave('d');
  assert.equal(table.playerAtSeat(table.activeSeat).openId, 'a');
});

test('庄家按顺时针轮转，跳过暂停的玩家', () => {
  const table = new PokerTable({ chatId: 'c', roomId: 'r', ownerOpenId: 'a', config: { startingStack: 1000 } });
  for (const id of ['a', 'b', 'c']) table.join({ openId: id, name: id });
  table.startHand();
  const first = table.buttonSeat;
  const seen = [first];
  for (let hand = 0; hand < 3; hand += 1) {
    table.phase = PHASES.FINISHED;
    table.startHand();
    seen.push(table.buttonSeat);
  }
  assert.deepEqual(seen, [first, (first % 3) + 1, ((first + 1) % 3) + 1, first]);
  table.phase = PHASES.FINISHED;
  const next = (table.buttonSeat % 3) + 1;
  table.playerAtSeat(next).sittingOut = true;
  table.startHand();
  assert.equal(table.buttonSeat, (next % 3) + 1);
});

test('通用命令交给群里最近在玩的游戏', () => {
  const manager = new TableManager({ statsStore: noStats(), turnTimeoutMs: 0 });
  const chatId = 'g';
  manager.dispatch({ chatId, user: { openId: 'a', name: 'A' }, command: { type: 'OPEN' } });
  assert.equal(manager.parseText(chatId, '开始', 'a').type, 'START');

  manager.dispatch({ chatId, user: { openId: 'a', name: 'A' }, command: { type: 'SELECT_GAME', game: 'undercover' } });
  assert.deepEqual(manager.parseText(chatId, '开始', 'a'), { type: 'GAME_ACTION', action: 'START' });
  assert.deepEqual(manager.parseText(chatId, '解散', 'a'), { type: 'GAME_ACTION', action: 'END' });

  manager.dispatch({ chatId, user: { openId: 'a', name: 'A' }, command: manager.parseText(chatId, '加入 小A', 'a') });
  for (const word of ['加入', '开始', '查看', '离开', '解散']) {
    assert.equal(manager.parseText(chatId, word, 'a').type, { 加入: 'JOIN', 开始: 'START', 查看: 'VIEW', 离开: 'LEAVE', 解散: 'DISBAND' }[word]);
  }
  // Explicit undercover wording still reaches the room while poker has focus.
  assert.deepEqual(manager.parseText(chatId, '开始游戏', 'a'), { type: 'GAME_ACTION', action: 'START' });
  assert.deepEqual(manager.parseText(chatId, '结束游戏', 'a'), { type: 'GAME_ACTION', action: 'END' });
  manager.shutdown();
});

test('只有谁是卧底房间时，通用命令仍然交给它', () => {
  const manager = new TableManager({ statsStore: noStats(), turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'u', user: { openId: 'a', name: 'A' }, command: { type: 'SELECT_GAME', game: 'undercover' } });
  manager.focus.clear();
  assert.deepEqual(manager.parseText('u', '加入', 'a'), { type: 'GAME_ACTION', action: 'JOIN' });
  manager.shutdown();
});

test('战绩按群分开，其他群看不到', () => {
  const dir = tempDir('stats');
  const store = new StatsStore(path.join(dir, 'stats.json'));
  store.recordHand([{ openId: 'ou_a', name: 'A群玩家', payout: 20, contributed: 10 }], { chatId: 'groupA' });
  store.recordHand([{ openId: 'ou_b', name: 'B群玩家', payout: 0, contributed: 10 }], { chatId: 'groupB' });
  store.recordBailout({ openId: 'ou_b', name: 'B群玩家' }, { phrase: '口令' }, 150, 'groupB');
  const manager = new TableManager({ statsStore: store, turnTimeoutMs: 0 });
  const [event] = manager.dispatch({ chatId: 'groupB', user: { openId: 'x', name: 'X' }, command: { type: 'STATS' } });
  assert.deepEqual(event.stats.map((item) => item.name), ['B群玩家']);
  assert.equal(event.stats[0].bailoutCount, 1);
  assert.equal(store.snapshotChat('groupA')[0].wins, 1);
  assert.equal(store.snapshotChat('nobody').length, 0);
  manager.shutdown();
  fs.rmSync(dir, { recursive: true });
});

test('旧版全局战绩会迁移到唯一出现过的群', () => {
  const dir = tempDir('migrate');
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    players: { ou_old: { openId: 'ou_old', name: '老玩家', hands: 9, wins: 4, totalNet: 300, biggestWin: 200 } },
    daily: { '2026-09-01': { chats: { only_group: { players: {} } } } },
  }));
  const store = new StatsStore(file);
  assert.equal(store.snapshotChat('only_group')[0].hands, 9);
  assert.equal(store.data.version, 2);
  fs.rmSync(dir, { recursive: true });
});

test('补充门槛和档位跟随初始筹码', () => {
  const table = new PokerTable({ chatId: 'c', roomId: 'r', ownerOpenId: 'a', config: { startingStack: 5000 } });
  table.join({ openId: 'a', name: 'a', stack: 4000 });
  table.join({ openId: 'b', name: 'b', stack: 9000 });
  assert.equal(table.canReceiveBailout('a').openId, 'a');
  const data = table.bailoutCardData('a', table.handNumber);
  assert.equal(data.cap, 5000);
  assert.equal(data.leaderReserve, 1000);
  assert.deepEqual(data.options.map((option) => option.amount), [750, 1500, 2250, 3000, 3750, 4500]);
  const receipt = table.grantBailout('a', 6);
  assert.equal(receipt.grant, 1000, '最多补到初始筹码');
  assert.equal(table.playerById('a').stack, 5000);
  assert.throws(() => table.canReceiveBailout('b'), /低于 5000/);
});

test('默认补充口令不含脏话，并支持自定义', () => {
  for (const phrase of DEFAULT_PHRASES) assert.doesNotMatch(phrase, /傻逼|蠢猪|蠢货|笨猪/);
  const custom = { BAILOUT_PHRASES: '一|二|三|四|五|六' };
  assert.deepEqual(bailoutTiers(1000, custom).map((tier) => tier.phrase), ['一', '二', '三', '四', '五', '六']);
  assert.equal(bailoutTierForPhrase('四', custom).level, 4);
  // A malformed list falls back to the defaults instead of breaking the game.
  const originalWarn = console.warn;
  console.warn = () => {};
  try { assert.deepEqual(bailoutTiers(1000, { BAILOUT_PHRASES: '只有一句' }).map((tier) => tier.phrase), [...DEFAULT_PHRASES]); }
  finally { console.warn = originalWarn; }
});

test('写文件先写临时文件，损坏文件会被备份而不是覆盖', () => {
  const dir = tempDir('json');
  const file = path.join(dir, 'data.json');
  writeJsonAtomic(file, { ok: true });
  assert.deepEqual(readJsonSafe(file, '测试文件'), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), ['data.json']);

  fs.writeFileSync(file, '{"players": {"ou_x": ');
  const originalError = console.error;
  console.error = () => {};
  let store;
  try { store = new StatsStore(file); } finally { console.error = originalError; }
  store.recordHand([{ openId: 'ou_new', name: '新', payout: 0, contributed: 5 }], {});
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"players": {"ou_x": ');
  fs.rmSync(dir, { recursive: true });
});

test('谁是卧底房间重启后恢复', () => {
  const dir = tempDir('rooms');
  const tablesFile = path.join(dir, 'tables.json');
  const config = { tablesFile, statsStore: noStats(), turnTimeoutMs: 0, undercoverSpeakTimeoutMs: 0 };
  const manager = new TableManager(config);
  const chatId = 'room-chat';
  manager.dispatch({ chatId, user: { openId: 'a', name: 'A' }, command: { type: 'SELECT_GAME', game: 'undercover' } });
  for (const id of ['a', 'b', 'c']) manager.dispatch({ chatId, user: { openId: id, name: id }, command: { type: 'GAME_ACTION', action: 'JOIN' } });
  manager.dispatch({ chatId, user: { openId: 'a', name: 'A' }, command: { type: 'GAME_ACTION', action: 'START' } });
  const before = manager.games.get(chatId);
  manager.shutdown();

  const restored = new TableManager(config);
  const room = restored.games.get(chatId);
  assert.equal(room.phase, 'speaking');
  assert.deepEqual(room.players.map((player) => player.secret), before.players.map((player) => player.secret));
  assert.equal(restored.games.currentSpeaker(room).openId, manager.games.currentSpeaker(before).openId);
  assert.equal(new TableStateStore(tablesFile).load().games.rooms.length, 1);
  restored.shutdown();
  fs.rmSync(dir, { recursive: true });
});

test('超时处理排在同群消息之后执行', async () => {
  const manager = new TableManager({ statsStore: noStats(), turnTimeoutMs: 20, turnWarningMs: 0 });
  const queued = [];
  manager.setTaskRunner((chatId, task) => { queued.push(chatId); return task(); });
  const delivered = [];
  manager.setEventSink(async (events) => { delivered.push(...events); });
  manager.dispatch({ chatId: 't', user: { openId: 'a', name: 'A' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 't', user: { openId: 'a', name: 'A' }, command: { type: 'JOIN', name: 'A' } });
  manager.dispatch({ chatId: 't', user: { openId: 'b', name: 'B' }, command: { type: 'JOIN', name: 'B' } });
  manager.dispatch({ chatId: 't', user: { openId: 'a', name: 'A' }, command: { type: 'START' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(queued.includes('t'), '超时任务应通过群队列执行');
  assert.ok(delivered.some((event) => event.type === 'group' && /自动弃牌/.test(event.text)));
  manager.shutdown();
});

test('飞书限流时自动重试，其他错误直接抛出', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let calls = 0;
  const result = await withRateLimitRetry(async () => {
    calls += 1;
    if (calls < 3) { const error = new Error('limited'); error.response = { status: 400, data: { code: 99991400 } }; throw error; }
    return { code: 0 };
  }, { sleep });
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(sleeps, [500, 1000]);

  calls = 0;
  await assert.rejects(withRateLimitRetry(async () => { calls += 1; throw new Error('bot not in chat'); }, { sleep }), /bot not in chat/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(withRateLimitRetry(async () => { calls += 1; return { code: 99991400, msg: 'too fast' }; }, { sleep, retries: 2 }), /too fast/);
  assert.equal(calls, 3);
});
