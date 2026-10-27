'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeck, shuffle, secureRandomIndex, formatCardsVisual } = require('../src/cards');
const { bestHand, compareScores } = require('../src/evaluator');
const { PokerTable } = require('../src/table');
const { PHASES } = require('../src/constants');
const { TableManager } = require('../src/table-manager');
const { parseCommand } = require('../src/commands');
const { createTableCard, createLobbyCard, createHomeCard, createStartCard, createResultCard, createChipsCard, createStatsCard, createDailyTitleCard, createBailoutCard, createBailoutNoticeCard, createExclusiveBailoutCard, createRulesCard, createExclusiveHoleCard, createExclusiveHoleResponse } = require('../src/card-ui');
const { cardActionToCommand } = require('../src/interaction-adapter');
const { createFeishuTransport } = require('../src/feishu-transport');
const { StatsStore } = require('../src/stats-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BailoutScheduler } = require('../src/bailout-scheduler');
const { DailyTitleScheduler, millisecondsUntilNextChinaNine } = require('../src/daily-title-scheduler');
const { GameManager } = require('../src/game-manager');
const { createGameCard, createExclusiveWordCard, createExclusiveWordResponse, createExclusiveSpeechCard, createExclusiveSpeechResponse } = require('../src/game-ui');
const { WORD_PAIRS } = require('../src/game-content');
const { messageMentionsBot, stalePokerCardResponse } = require('../index');

function card(rank, suit) {
  const label = ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || String(rank);
  return { rank, suit, label, symbol: suit };
}

test('谁是卧底题库数量、结构与内容唯一性正确', () => {
  assert.equal(WORD_PAIRS.length, 80);
  assert.equal(new Set(WORD_PAIRS.map((pair) => pair.join('|'))).size, WORD_PAIRS.length);
  assert.equal(WORD_PAIRS.every((pair) => pair.length === 2 && pair.every((word) => typeof word === 'string' && word.trim())), true);
});

test('牌堆恰有 52 张唯一牌，洗牌不改变原牌堆', () => {
  const deck = createDeck();
  const mixed = shuffle(deck);
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((item) => item.id)).size, 52);
  assert.equal(mixed.length, 52);
  assert.equal(new Set(mixed.map((item) => item.id)).size, 52);
  assert.notEqual(mixed, deck);
  for (let index = 0; index < 20; index += 1) {
    const selected = secureRandomIndex(3);
    assert.ok(selected >= 0 && selected < 3);
  }
});

test('7 选 5 正确识别同花顺并比较踢脚', () => {
  const royal = bestHand([
    card(14, 'S'), card(13, 'S'), card(12, 'S'), card(11, 'S'), card(10, 'S'), card(2, 'H'), card(3, 'D'),
  ]);
  const quads = bestHand([
    card(9, 'S'), card(9, 'H'), card(9, 'D'), card(9, 'C'), card(14, 'S'), card(2, 'H'), card(3, 'D'),
  ]);
  assert.equal(royal.name, '同花顺');
  assert.equal(quads.name, '四条');
  assert.equal(compareScores(royal.score, quads.score), 1);
});

test('完整跟注与过牌流程会进入摊牌，筹码守恒', () => {
  const table = new PokerTable({ chatId: 'chat-1', roomId: 'TX0001', ownerOpenId: 'a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.startHand();
  let guard = 0;
  while (table.isActive() && guard < 30) {
    const player = table.playerAtSeat(table.activeSeat);
    if (table.toCall(player) === 0) table.check(player.openId);
    else table.call(player.openId);
    guard += 1;
  }
  assert.ok(guard < 30);
  assert.equal(table.phase, PHASES.FINISHED);
  assert.equal(table.board.length, 5);
  assert.equal(table.players.reduce((sum, player) => sum + player.stack, 0), 200);
  const finishEvents = table.drainEvents();
  const result = finishEvents.find((event) => event.type === 'result_card');
  assert.ok(result);
  assert.equal(finishEvents.some((event) => event.type === 'table_card' && event.finished), false);
  const compactResult = JSON.stringify(createResultCard(result));
  assert.match(compactResult, /玩家结果/);
  assert.match(compactResult, new RegExp(formatCardsVisual(result.players.find((player) => player.played).cards)));
  assert.match(compactResult, /当前筹码/);
  assert.match(compactResult, /可补充/);
  assert.match(compactResult, /(👑|➖)/);
  assert.match(compactResult, /(💀|➖)/);
  assert.doesNotMatch(compactResult, /最佳五张/);
  assert.equal((compactResult.match(/公共牌/g) || []).length, 1);
  assert.match(compactResult, /开始下一局/);
  assert.match(compactResult, /离开牌桌/);
  assert.doesNotMatch(compactResult, /结算后筹码/);
});

test('隐藏开关允许单人测试，并真实扣除单人投入以测试补充筹码', () => {
  const normal = new PokerTable({ chatId: 'chat-solo-off', roomId: 'TXSOLO0', ownerOpenId: 'solo' });
  normal.join({ openId: 'solo', name: '测试员' });
  assert.throws(() => normal.startHand(), /至少需要 2 名/);

  const solo = new PokerTable({ chatId: 'chat-solo-on', roomId: 'TXSOLO1', ownerOpenId: 'solo', config: { startingStack: 1000, smallBlind: 5, bigBlind: 10, allowSoloGame: true } });
  solo.join({ openId: 'solo', name: '测试员' });
  solo.startHand();
  const start = solo.drainEvents().find((event) => event.type === 'start_card');
  assert.equal(start.smallBlindAmount, 0);
  assert.equal(start.bigBlindAmount, 10);
  const soloStartJson = JSON.stringify(createStartCard(start));
  assert.match(soloStartJson, /单人测试/);
  assert.doesNotMatch(soloStartJson, /小盲/);
  solo.raiseTo('solo', 250);
  let actions = 1;
  while (solo.isActive() && actions < 10) {
    solo.check('solo');
    actions += 1;
  }
  assert.equal(actions, 4);
  assert.equal(solo.phase, PHASES.FINISHED);
  assert.equal(solo.board.length, 5);
  assert.equal(solo.playerById('solo').stack, 750);
  const soloEvents = solo.drainEvents();
  const result = soloEvents.find((event) => event.type === 'result_card');
  assert.equal(result.players[0].canBailout, true);
  assert.match(result.fallbackText, /已扣除本局投入 250 筹码/);
  const completed = soloEvents.find((event) => event.type === 'hand_complete');
  assert.equal(completed.solo, true);
});

test('开始下一局会延续现有筹码而不是重置为初始筹码', () => {
  const table = new PokerTable({ chatId: 'chat-stack-carry', roomId: 'TXCARRY', ownerOpenId: 'a', config: { startingStack: 1000, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.playerById('a').stack = 4620;
  table.playerById('b').stack = 3180;
  table.phase = PHASES.FINISHED;
  table.startHand();
  assert.equal(table.players.reduce((sum, player) => sum + player.stack, 0), 4620 + 3180 - 15);
  assert.ok(table.playerById('a').stack >= 4610);
  assert.ok(table.playerById('b').stack >= 3170);
});

test('牌桌内存在破产玩家时禁止开始下一局', () => {
  const table = new PokerTable({ chatId: 'chat-bankrupt-block', roomId: 'TXBLOCK', ownerOpenId: 'a' });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.join({ openId: 'c', name: '破产玩家' });
  table.playerById('c').stack = 0;
  table.playerById('c').sittingOut = true;
  assert.throws(() => table.startHand(), /破产玩家.*筹码为 0.*补充.*离开牌桌/);
  assert.equal(table.phase, PHASES.WAITING);
  assert.equal(table.handNumber, 0);
});

test('边池按有效资格结算，并能分池', () => {
  const table = new PokerTable({ chatId: 'chat-2', roomId: 'TX0002', ownerOpenId: 'a' });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.join({ openId: 'c', name: '丙' });
  const [a, b, c] = table.seatedPlayers();
  for (const player of [a, b, c]) {
    player.inHand = true;
    player.folded = false;
    player.stack = 0;
  }
  a.contributed = 50;
  b.contributed = 100;
  c.contributed = 100;
  a.cards = [card(2, 'S'), card(3, 'H')];
  b.cards = [card(4, 'S'), card(5, 'H')];
  c.cards = [card(6, 'S'), card(7, 'H')];
  table.board = [card(14, 'D'), card(13, 'D'), card(12, 'D'), card(11, 'D'), card(10, 'D')];
  table.buttonSeat = 1;
  table.showdown();
  assert.equal(table.lastResult.pots.length, 2);
  assert.deepEqual(table.lastResult.pots.map((pot) => pot.amount), [150, 100]);
  assert.equal(a.stack, 50);
  assert.equal(b.stack, 100);
  assert.equal(c.stack, 100);
  assert.equal(a.stack + b.stack + c.stack, 250);
});

test('最小加注与翻牌前行动顺序生效', () => {
  const table = new PokerTable({ chatId: 'chat-3', roomId: 'TX0003', ownerOpenId: 'a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.join({ openId: 'c', name: '丙' });
  table.startHand();
  const opener = table.playerAtSeat(table.activeSeat);
  assert.throws(() => table.raiseTo(opener.openId, 15), /最小加注/);
  table.raiseTo(opener.openId, 20);
  while (table.phase === PHASES.PREFLOP) {
    const caller = table.playerAtSeat(table.activeSeat);
    table.call(caller.openId);
  }
  assert.equal(table.phase, PHASES.FLOP);
  assert.equal(table.board.length, 3);
});

test('无人需要继续决策时自动发完公共牌并结算', () => {
  const table = new PokerTable({ chatId: 'chat-runout', roomId: 'TXRUN', ownerOpenId: 'a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.startHand();
  let actor = table.playerAtSeat(table.activeSeat);
  table.allIn(actor.openId);
  actor = table.playerAtSeat(table.activeSeat);
  table.call(actor.openId);
  assert.equal(table.phase, PHASES.FINISHED);
  assert.equal(table.board.length, 5);
  assert.ok(table.drainEvents().some((event) => event.type === 'group' && event.text.includes('自动发完公共牌')));
});

test('不同 chat_id 的牌桌和玩家状态相互隔离', () => {
  const manager = new TableManager({ startingStack: 200, turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'group-a', user: { openId: 'owner-a' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'group-b', user: { openId: 'owner-b' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'group-a', user: { openId: 'a1' }, command: { type: 'JOIN', name: '甲' } });
  manager.dispatch({ chatId: 'group-b', user: { openId: 'b1' }, command: { type: 'JOIN', name: '乙' } });
  assert.equal(manager.get('group-a').players.length, 1);
  assert.equal(manager.get('group-b').players.length, 1);
  assert.notEqual(manager.get('group-a').roomId, manager.get('group-b').roomId);
  manager.shutdown();
});

test('德州和谁是卧底均允许非创建者解散房间', () => {
  const manager = new TableManager({ turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'group-equal-poker', user: { openId: 'creator' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'group-equal-poker', user: { openId: 'other', name: '其他人' }, command: { type: 'DISBAND' } });
  assert.equal(manager.get('group-equal-poker').phase, PHASES.DISBANDED);

  manager.dispatch({ chatId: 'group-equal-undercover', user: { openId: 'creator', name: '创建者' }, command: { type: 'SELECT_GAME', game: 'undercover' } });
  manager.dispatch({ chatId: 'group-equal-undercover', user: { openId: 'other', name: '其他人' }, command: { type: 'GAME_ACTION', action: 'JOIN' } });
  const ended = manager.dispatch({ chatId: 'group-equal-undercover', user: { openId: 'other', name: '其他人' }, command: { type: 'GAME_ACTION', action: 'END' } });
  assert.equal(manager.games.get('group-equal-undercover'), undefined);
  assert.match(ended[0].text, /已解散/);
  manager.shutdown();
});

test('普通群聊静默忽略，只解析明确的游戏指令', () => {
  assert.equal(parseCommand('大家晚上吃什么'), null);
  assert.equal(parseCommand('我觉得跟注的人很勇敢'), null);
  assert.deepEqual(parseCommand('@_user_1 跟注'), { type: 'CALL' });
  assert.deepEqual(parseCommand('跟注100'), { type: 'CALL' });
  assert.deepEqual(parseCommand('加注 30'), { type: 'RAISE_TO', amount: 30 });
  assert.deepEqual(parseCommand('加注30'), { type: 'RAISE_TO', amount: 30 });
  assert.deepEqual(parseCommand('加注到30'), { type: 'RAISE_TO', amount: 30 });
  assert.deepEqual(parseCommand('改名 牌神'), { type: 'RENAME', name: '牌神' });
  assert.deepEqual(parseCommand('补充'), { type: 'BAILOUT_MENU' });
  assert.deepEqual(parseCommand('补充筹码'), { type: 'BAILOUT_MENU' });
  assert.deepEqual(parseCommand('开桌'), { type: 'INTERFACE' });
  assert.deepEqual(parseCommand('开德州'), { type: 'OPEN' });
  assert.deepEqual(parseCommand('暂停'), { type: 'SIT_OUT', enabled: true });
  assert.deepEqual(parseCommand('恢复参赛'), { type: 'SIT_OUT', enabled: false });
  assert.equal(parseCommand('托管过牌'), null);
  assert.equal(parseCommand('托管跟注50'), null);
  assert.equal(parseCommand('取消托管'), null);
});

test('谁是卧底房间完成基本流程', () => {
  const games = new GameManager();
  const chatId = 'chat-games';
  assert.equal(games.parseText(chatId, '谁是卧底').game, 'undercover');
  const roomEvents = games.dispatch(chatId, { openId: 'host', name: '主持' }, { type: 'SELECT_GAME', game: 'undercover' });
  assert.equal(roomEvents[0].type, 'game_card');
  for (let i = 0; i < 3; i += 1) games.dispatch(chatId, { openId: `u${i}`, name: `玩家${i}` }, { type: 'GAME_ACTION', action: 'JOIN' });
  const lobbyCard = JSON.stringify(createGameCard(games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'VIEW' })[0]));
  assert.match(lobbyCard, /已加入玩家（3\/12）/);
  assert.match(lobbyCard, /<at id=u0>/);
  assert.doesNotMatch(lobbyCard, /查看比分/);
  const started = games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'START' });
  assert.equal(started.filter((event) => event.type === 'private').length, 4);
  const startedCard = started.find((event) => event.type === 'game_card');
  const startedCardJson = JSON.stringify(createGameCard(startedCard));
  assert.match(startedCardJson, /查看我的词语/);
  assert.match(startedCardJson, /下一位：/);
  assert.match(startedCardJson, /顺序已随机打乱/);
  assert.match(startedCardJson, /匿名描述/);
  assert.doesNotMatch(startedCardJson, /查看比分/);
  assert.doesNotMatch(startedCardJson, /<at id=/);
  assert.doesNotMatch(startedCardJson, /已加入玩家/);
  assert.equal(games.parseText(chatId, '我在旁边聊天', 'u1'), null);
  assert.equal(games.parseText(chatId, '这是当前玩家的普通聊天', 'u0'), null);
  const firstSpeaker = games.currentSpeaker(chatId);
  const allowedAliases = new Set(['摸鱼王', '卷王', '表哥', '甲方', '投手', '素材佬', '数据怪', '爆单王', '背锅侠', '显眼包', '气氛组', '大聪明', '戏精', '嘴替', '段子手', '狠人', '社牛', '社恐', '锦鲤', '老六']);
  assert.equal(allowedAliases.size, 20);
  assert.equal(games.get(chatId).players.every((player) => allowedAliases.has(player.anonymousName)), true);
  assert.equal(new Set(games.get(chatId).players.map((player) => player.anonymousName)).size, 3);
  const speechData = games.speechData(chatId, firstSpeaker.openId);
  const speechCardJson = JSON.stringify(createExclusiveSpeechCard(speechData));
  assert.match(speechCardJson, /anonymous_speech_form/);
  assert.match(speechCardJson, /anonymous_speech/);
  assert.match(speechCardJson, /匿名发送/);
  assert.match(speechCardJson, new RegExp(firstSpeaker.anonymousName));
  assert.equal(createExclusiveSpeechResponse(speechData).card.type, 'raw');
  const otherPlayer = games.get(chatId).players.find((player) => player.openId !== firstSpeaker.openId);
  assert.throws(() => games.dispatch(chatId, otherPlayer, { type: 'GAME_ACTION', action: 'ARM_SPEECH' }), /还没轮到/);
  assert.equal(games.parseText(chatId, '描述发在群里的内容', firstSpeaker.openId), null);
  const privateSpeech = games.parsePrivateSpeech(firstSpeaker.openId, '描述这是机器人代发的内容');
  assert.equal(privateSpeech.command.action, 'SPEAK');
  assert.equal(privateSpeech.command.text, '这是机器人代发的内容');
  games.dispatch(chatId, firstSpeaker, privateSpeech.command);
  assert.equal(games.parsePrivateSpeech(firstSpeaker.openId, '重复描述'), null);
  assert.throws(() => games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'START' }), /已经开始/);
  const currentSpeaker = games.currentSpeaker(chatId);
  const wordData = games.wordData(chatId, currentSpeaker.openId);
  assert.equal(typeof wordData.word, 'string');
  const exclusiveWordJson = JSON.stringify(createExclusiveWordCard(wordData));
  assert.match(exclusiveWordJson, /仅你可见 · 我的词语/);
  assert.match(exclusiveWordJson, /开始描述/);
  const waitingPlayer = games.get(chatId).players.find((player) => player.openId !== currentSpeaker.openId);
  assert.doesNotMatch(JSON.stringify(createExclusiveWordCard(games.wordData(chatId, waitingPlayer.openId))), /GAME_SPEAK_READY/);
  assert.equal(createExclusiveWordResponse(wordData).card.type, 'raw');
  games.get(chatId).players.forEach((player, index) => { player.isUndercover = index === 0; });
  while (games.get(chatId).phase === 'speaking') {
    const speaker = games.currentSpeaker(chatId);
    games.dispatch(chatId, speaker, { type: 'GAME_ACTION', action: 'SPEAK', text: '这是我的匿名描述' });
  }
  const room = games.get(chatId);
  const undercoverPlayer = room.players.find((player) => player.isUndercover);
  let finalEvents;
  for (const player of room.players) finalEvents = games.dispatch(chatId, { openId: player.openId, name: player.name }, { type: 'GAME_ACTION', action: 'VOTE_NAME', targetName: undercoverPlayer.anonymousName });
  assert.equal(games.get(chatId).phase, 'finished');
  const resultJson = JSON.stringify(createGameCard(finalEvents[0]));
  assert.match(resultJson, /平民获胜/);
  assert.match(resultJson, /卧底.*玩家0/);
  assert.match(resultJson, /平民「.+」｜卧底「.+」/);
  assert.match(resultJson, /票数/);
  assert.match(resultJson, /描述/);
  assert.match(resultJson, /身份揭晓/);
  assert.match(resultJson, /摸鱼王|卷王|表哥|甲方|投手|素材佬|数据怪|爆单王|背锅侠|显眼包|气氛组|大聪明/);
  assert.doesNotMatch(resultJson, /已加入玩家/);
  assert.doesNotMatch(resultJson, /至少 3 名玩家/);
  assert.doesNotMatch(resultJson, /1\/1 胜/);
  assert.match(resultJson, /再来一局/);
  assert.match(resultJson, /离开房间/);
  assert.match(resultJson, /查看比分/);
  assert.match(resultJson, /解散房间/);
  const scoreCardJson = JSON.stringify(createGameCard(games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'SCORE' })[0]));
  assert.match(scoreCardJson, /谁是卧底比分/);
  const afterLeave = games.dispatch(chatId, { openId: 'u2', name: '玩家2' }, { type: 'GAME_ACTION', action: 'LEAVE' });
  assert.match(JSON.stringify(createGameCard(afterLeave[0])), /房间内 2 人/);
  games.dispatch(chatId, { openId: 'u3', name: '玩家3' }, { type: 'GAME_ACTION', action: 'JOIN' });
  const previousAliases = Object.fromEntries(games.get(chatId).players.map((player) => [player.openId, player.anonymousName]));
  const replay = games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'START' });
  assert.equal(replay.filter((event) => event.type === 'private').length, 4);
  assert.equal(games.get(chatId).phase, 'speaking');
  assert.equal(games.get(chatId).players.every((player) => player.anonymousName !== previousAliases[player.openId]), true);

  const solo = new GameManager({ allowSoloGame: true });
  solo.dispatch('solo-undercover', { openId: 'one', name: '测试员' }, { type: 'SELECT_GAME', game: 'undercover' });
  solo.dispatch('solo-undercover', { openId: 'one', name: '测试员' }, { type: 'GAME_ACTION', action: 'JOIN' });
  assert.equal(solo.dispatch('solo-undercover', { openId: 'one', name: '测试员' }, { type: 'GAME_ACTION', action: 'START' }).filter((event) => event.type === 'private').length, 2);

  assert.throws(() => solo.dispatch('unknown-game', { openId: 'one', name: '测试员' }, { type: 'SELECT_GAME', game: 'unknown_game' }), /无法识别游戏/);
});

test('谁是卧底描述超时会静默跳过并在最后进入投票', () => {
  const games = new GameManager();
  const chatId = 'chat-undercover-timeout';
  games.dispatch(chatId, { openId: 'u0', name: '甲' }, { type: 'SELECT_GAME', game: 'undercover' });
  for (let i = 0; i < 3; i += 1) games.dispatch(chatId, { openId: `u${i}`, name: `玩家${i}` }, { type: 'GAME_ACTION', action: 'JOIN' });
  games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'START' });
  assert.equal(games.timeoutSpeaker(chatId, 'wrong').length, 0);
  const first = games.currentSpeaker(chatId);
  assert.equal(games.timeoutSpeaker(chatId, first.openId)[0].phase, 'speaking');
  assert.equal(first.speech, null);
  assert.equal(games.get(chatId).speakerIndex, 1);
  games.timeoutSpeaker(chatId, games.currentSpeaker(chatId).openId);
  const voting = games.timeoutSpeaker(chatId, games.currentSpeaker(chatId).openId)[0];
  assert.equal(voting.phase, 'voting');
  const votingJson = JSON.stringify(createGameCard(voting));
  assert.match(votingJson, /请选择要淘汰的玩家/);
  assert.match(votingJson, /弃票 \/ 不投任何人/);
  assert.doesNotMatch(votingJson, /查看比分/);
  assert.equal(games.parseText(chatId, '过票', 'u0').action, 'ABSTAIN');
  games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'ABSTAIN' });
  games.dispatch(chatId, { openId: 'u1', name: '玩家1' }, { type: 'GAME_ACTION', action: 'ABSTAIN' });
  const allAbstained = games.dispatch(chatId, { openId: 'u2', name: '玩家2' }, { type: 'GAME_ACTION', action: 'ABSTAIN' });
  assert.equal(games.get(chatId).phase, 'speaking');
  assert.equal(games.get(chatId).round, 2);
  assert.equal(games.get(chatId).players.every((player) => player.alive), true);
  assert.match(JSON.stringify(createGameCard(allAbstained[0])), /弃票.*3/);
});

test('谁是卧底平票不会误淘汰，结算身份与累计比分会持久保存', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'undercover-score-'));
  const scoreFile = path.join(directory, 'stats.json');
  const stats = new StatsStore(scoreFile);
  const games = new GameManager({ scoreStore: stats });
  const chatId = 'chat-undercover-score';
  games.dispatch(chatId, { openId: 'u0', name: '甲' }, { type: 'SELECT_GAME', game: 'undercover' });
  for (let i = 0; i < 4; i += 1) games.dispatch(chatId, { openId: `u${i}`, name: `玩家${i}` }, { type: 'GAME_ACTION', action: 'JOIN' });
  games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'START' });
  const storedAliases = new StatsStore(scoreFile);
  for (const player of games.get(chatId).players) assert.equal(storedAliases.lastUndercoverAlias(chatId, player.openId), player.anonymousName);
  games.get(chatId).players.forEach((player, index) => { player.isUndercover = index === 0; });
  while (games.get(chatId).phase === 'speaking') {
    const speaker = games.currentSpeaker(chatId);
    games.dispatch(chatId, speaker, { type: 'GAME_ACTION', action: 'SPEAK', text: `描述-${speaker.anonymousName}` });
  }
  games.dispatch(chatId, { openId: 'u0', name: '玩家0' }, { type: 'GAME_ACTION', action: 'VOTE_NAME', targetOpenId: 'u0' });
  games.dispatch(chatId, { openId: 'u1', name: '玩家1' }, { type: 'GAME_ACTION', action: 'VOTE_NAME', targetOpenId: 'u0' });
  games.dispatch(chatId, { openId: 'u2', name: '玩家2' }, { type: 'GAME_ACTION', action: 'VOTE_NAME', targetOpenId: 'u1' });
  const tied = games.dispatch(chatId, { openId: 'u3', name: '玩家3' }, { type: 'GAME_ACTION', action: 'VOTE_NAME', targetOpenId: 'u1' });
  assert.equal(games.get(chatId).phase, 'speaking');
  assert.equal(games.get(chatId).round, 2);
  assert.equal(games.get(chatId).players.every((player) => player.alive), true);
  assert.match(JSON.stringify(createGameCard(tied[0])), /本轮平票/);
  while (games.get(chatId).phase === 'speaking') {
    const speaker = games.currentSpeaker(chatId);
    games.dispatch(chatId, speaker, { type: 'GAME_ACTION', action: 'SPEAK', text: `第二轮-${speaker.anonymousName}` });
  }
  let result;
  for (let i = 0; i < 4; i += 1) result = games.dispatch(chatId, { openId: `u${i}`, name: `玩家${i}` }, { type: 'GAME_ACTION', action: 'VOTE_NAME', targetOpenId: 'u0' });
  const resultJson = JSON.stringify(createGameCard(result[0]));
  assert.match(resultJson, /平民获胜/);
  assert.match(resultJson, /卧底.*玩家0/);
  assert.match(resultJson, /比分/);
  const reloaded = new StatsStore(scoreFile).undercoverScores(chatId);
  assert.equal(reloaded.find((item) => item.openId === 'u0').points, 0);
  assert.equal(reloaded.find((item) => item.openId === 'u1').points, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('暂停玩家不会进入下一局，恢复后可重新参赛', () => {
  const table = new PokerTable({ chatId: 'chat-sitout', roomId: 'TXSIT', ownerOpenId: 'a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.join({ openId: 'c', name: '丙' });
  table.setSittingOut('c', true);
  table.startHand();
  assert.equal(table.playerById('c').inHand, false);
  while (table.isActive()) table.fold(table.playerAtSeat(table.activeSeat).openId);
  table.setSittingOut('c', false);
  table.startHand();
  assert.equal(table.playerById('c').inHand, true);
});

test('行动提示在群里 @ 玩家且不显示座位号', () => {
  const table = new PokerTable({ chatId: 'chat-at', roomId: 'TXAT', ownerOpenId: 'ou_a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'ou_a', name: '甲' });
  table.join({ openId: 'ou_b', name: '乙' });
  table.startHand();
  const startEvents = table.drainEvents();
  const prompt = startEvents.filter((event) => event.type === 'table_card').at(-1);
  const privateTurn = startEvents.find((event) => event.type === 'private_turn_card');
  assert.ok(privateTurn);
  assert.equal(privateTurn.openId, prompt.action.openId);
  assert.match(JSON.stringify(createExclusiveHoleCard(privateTurn)), /仅你可见的底牌/);
  const card = createTableCard(prompt);
  const serialized = JSON.stringify(card);
  assert.match(serialized, new RegExp(`<at id=${prompt.action.openId}><\\/at>`));
  const chipText = card.elements[2].text.content;
  assert.match(chipText, /甲/);
  assert.match(chipText, /乙/);
  assert.doesNotMatch(chipText, /<at /);
  assert.doesNotMatch(serialized, /号位/);
  assert.match(serialized, /(过牌|跟注 5)/);
  assert.match(serialized, /加注到 20/);
  assert.match(serialized, /满池/);
  assert.match(serialized, /底池赔率/);
  assert.doesNotMatch(serialized, /托管设置/);
  assert.match(serialized, /加注 数字金额/);
  assert.doesNotMatch(serialized, /custom_raise_form/);
  assert.match(serialized, /查看我的底牌/);
  assert.equal(card.config.update_multi, false);
  const refreshed = stalePokerCardResponse(table, prompt.action.openId);
  assert.equal(refreshed.card.type, 'raw');
  assert.match(JSON.stringify(refreshed), new RegExp(`"turnVersion":"${table.turnVersion}"`));
  assert.match(stalePokerCardResponse(table, 'ou_wrong').toast.content, /现在轮到/);
  assert.equal(cardActionToCommand({ value: { action: 'CHECK' } }).type, 'CHECK');
  assert.equal(cardActionToCommand({ value: { action: 'SHOW_HOLE' } }).type, 'SHOW_HOLE');
  assert.deepEqual(cardActionToCommand({ value: { action: 'RAISE_CUSTOM' }, formValue: { raise_amount: '75' } }), { type: 'RAISE_TO', amount: 75 });

  const actor = table.playerAtSeat(table.activeSeat);
  const oldTurnVersion = table.turnVersion;
  table.allIn(actor.openId);
  const allInMessage = table.drainEvents().find((event) => event.type === 'group' && event.text.includes('全下到'));
  assert.match(allInMessage.text, new RegExp(`<at user_id="${actor.openId}">`));
  assert.match(allInMessage.text, /下一位：<at user_id=/);
  assert.doesNotMatch(allInMessage.text, /玩家\d+：全下到/);
  assert.equal(table.holeCardData(actor.openId, table.handNumber, oldTurnVersion).player.openId, actor.openId);
});

test('群内独享卡只按真实玩家返回自己的底牌，并拒绝旧局与旁观者', () => {
  const table = new PokerTable({ chatId: 'chat-private-card', roomId: 'TXPRIVATE', ownerOpenId: 'ou_a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'ou_a', name: '甲' });
  table.join({ openId: 'ou_b', name: '乙' });
  table.startHand();
  const a = table.holeCardData('ou_a', table.handNumber, table.turnVersion);
  const b = table.holeCardData('ou_b', table.handNumber, table.turnVersion);
  assert.deepEqual(a.player.cards, table.playerById('ou_a').cards);
  assert.deepEqual(b.player.cards, table.playerById('ou_b').cards);
  assert.notDeepEqual(a.player.cards, b.player.cards);
  const aCard = createExclusiveHoleCard(a);
  assert.equal(aCard.config.update_multi, false);
  assert.match(JSON.stringify(aCard), /仅你可见的底牌/);
  const response = createExclusiveHoleResponse(a);
  assert.equal(response.card.type, 'raw');
  assert.deepEqual(response.card.data, aCard);
  assert.throws(() => table.holeCardData('ou_watcher', table.handNumber, table.turnVersion), /不是本局玩家/);
  assert.throws(() => table.holeCardData('ou_a', table.handNumber - 1, table.turnVersion), /上一局/);
});

test('群聊模式每局只私聊一次底牌，后续行动留在群卡', () => {
  const table = new PokerTable({ chatId: 'chat-group-only', roomId: 'TXGROUP', ownerOpenId: 'ou_a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10, turnCardMode: 'group' } });
  table.join({ openId: 'ou_a', name: '甲' });
  table.join({ openId: 'ou_b', name: '乙' });
  table.startHand();
  const events = table.drainEvents();
  const initialHoleCards = events.filter((event) => event.type === 'private');
  assert.equal(initialHoleCards.length, 2);
  assert.deepEqual(new Set(initialHoleCards.map((event) => event.openId)), new Set(['ou_a', 'ou_b']));
  assert.equal(initialHoleCards.every((event) => event.text.includes('第 1 局底牌')), true);
  assert.equal(events.some((event) => event.type === 'private_turn_card'), false);
  const start = events.find((event) => event.type === 'start_card');
  assert.equal(start.turnCardMode, 'group');
  assert.match(JSON.stringify(createStartCard(start)), /每局开始私聊一次底牌/);
  const prompt = events.filter((event) => event.type === 'table_card').at(-1);
  assert.match(JSON.stringify(createTableCard(prompt)), /查看我的底牌/);
});

test('公共牌进入群牌桌卡片，并显示扑克牌图形和底池', () => {
  const table = new PokerTable({ chatId: 'chat-board', roomId: 'TXBOARD', ownerOpenId: 'a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.startHand();
  while (table.phase === PHASES.PREFLOP) {
    const actor = table.playerAtSeat(table.activeSeat);
    if (table.toCall(actor) > 0) table.call(actor.openId);
    else table.check(actor.openId);
  }
  const streetEvents = table.drainEvents().filter((event) => event.type === 'table_card' && event.title.includes('翻牌 Flop'));
  assert.equal(streetEvents.length, 1);
  const flopEvent = streetEvents[0];
  assert.ok(flopEvent);
  assert.ok(flopEvent.action);
  assert.equal(flopEvent.board.length, 3);
  const uiCard = createTableCard(flopEvent);
  assert.match(JSON.stringify(uiCard), /公共牌/);
  assert.match(JSON.stringify(uiCard), /底池/);
  assert.match(JSON.stringify(uiCard), /最近行动/);
  assert.match(formatCardsVisual([card(14, 'H'), card(13, 'D')]), /♥️A.*♦️K/);
});

test('低于 1000 可按固定档位补充，每局一次且保留筹码王优势', () => {
  const statsStore = { recordHand: () => [], snapshotAll: () => [] };
  const manager = new TableManager({ startingStack: 1000, smallBlind: 5, bigBlind: 10, turnTimeoutMs: 0, statsStore });
  manager.dispatch({ chatId: 'group-open', user: { openId: 'owner' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'group-open', user: { openId: 'owner' }, command: { type: 'JOIN', name: '房主' } });
  manager.dispatch({ chatId: 'group-open', user: { openId: 'friend' }, command: { type: 'JOIN', name: '朋友' } });
  manager.dispatch({ chatId: 'group-open', user: { openId: 'friend' }, command: { type: 'START' } });
  const table = manager.get('group-open');
  assert.equal(table.phase, PHASES.PREFLOP);
  table.phase = PHASES.FINISHED;
  table.playerById('owner').stack = 1500;
  table.playerById('friend').stack = 0;
  const bailoutEvents = manager.dispatch({ chatId: 'group-open', user: { openId: 'friend' }, command: { type: 'BAILOUT', level: 1 } });
  assert.equal(table.playerById('friend').stack, 150);
  assert.equal(bailoutEvents.some((event) => event.type === 'table_card'), false);
  table.playerById('friend').stack = 0;
  assert.throws(() => manager.dispatch({ chatId: 'group-open', user: { openId: 'friend' }, command: { type: 'BAILOUT', level: 2 } }), /已经补充过/);
  table.handNumber += 1;
  table.playerById('friend').stack = 900;
  manager.dispatch({ chatId: 'group-open', user: { openId: 'friend' }, command: { type: 'BAILOUT', level: 1 } });
  assert.equal(table.playerById('friend').stack, 1000);
  table.handNumber += 1;
  table.playerById('friend').stack = 0;
  manager.dispatch({ chatId: 'group-open', user: { openId: 'friend' }, command: { type: 'BAILOUT', level: 6 } });
  assert.equal(table.playerById('friend').stack, 900);
  assert.throws(() => manager.dispatch({ chatId: 'group-open', user: { openId: 'owner' }, command: { type: 'BAILOUT', level: 1 } }), /低于 1000/);
  assert.deepEqual(parseCommand('我是菜鸟，这把确实没打明白'), { type: 'BAILOUT', level: 1 });
  assert.deepEqual(parseCommand('我已当众证明自己牌技稀烂，求各位高手赏我一次复仇机会'), { type: 'BAILOUT', level: 6 });
  manager.shutdown();
});

test('发送补充会列出低筹码玩家并提供仅本人可见的补充入口', () => {
  const manager = new TableManager({ startingStack: 1000, turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'group-bailout-menu', user: { openId: 'a' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'group-bailout-menu', user: { openId: 'a', name: '筹码王' }, command: { type: 'JOIN', name: null } });
  manager.dispatch({ chatId: 'group-bailout-menu', user: { openId: 'b', name: '待补充' }, command: { type: 'JOIN', name: null } });
  const table = manager.get('group-bailout-menu');
  table.phase = PHASES.FINISHED;
  table.playerById('a').stack = 4620;
  table.playerById('b').stack = 500;
  const events = manager.dispatch({ chatId: 'group-bailout-menu', user: { openId: 'a', name: '筹码王' }, command: { type: 'BAILOUT_MENU' } });
  const bailout = events.find((event) => event.type === 'bailout_card');
  assert.ok(bailout);
  assert.deepEqual(bailout.players.map((player) => player.name), ['待补充']);
  const cardJson = JSON.stringify(createBailoutCard(bailout));
  assert.match(cardJson, /<at id=b>/);
  assert.match(cardJson, /查看我的补充档位/);
  assert.match(cardJson, /SHOW_BAILOUT/);
  assert.match(cardJson, /TX0001/);
  manager.shutdown();
});

test('永久战绩写入文件并可在重启后读取', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-poker-stats-'));
  const file = path.join(directory, 'stats.json');
  const store = new StatsStore(file);
  store.recordHand([
    { openId: 'ou_a', name: '甲', contributed: 40, payout: 100 },
    { openId: 'ou_b', name: '乙', contributed: 60, payout: 0 },
  ]);
  const reloaded = new StatsStore(file);
  assert.deepEqual(reloaded.snapshot(['ou_a'])[0], {
    openId: 'ou_a', name: '甲', hands: 1, wins: 1, totalNet: 60, biggestWin: 60,
    bailoutCount: 0, bailoutTotal: 0, bailoutPhrases: {},
  });
  reloaded.recordBailout({ openId: 'ou_b', name: '乙' }, { phrase: '测试补充语录' }, 300);
  reloaded.recordBailout({ openId: 'ou_b', name: '乙' }, { phrase: '测试补充语录' }, 250);
  const shame = new StatsStore(file).snapshot(['ou_b'])[0];
  assert.equal(shame.bailoutCount, 2);
  assert.equal(shame.bailoutTotal, 550);
  assert.equal(shame.bailoutPhrases['测试补充语录'], 2);
  assert.equal(reloaded.snapshotAll().length, 2);
  fs.rmSync(directory, { recursive: true });
});

test('结算卡不再另发公开提醒，点击后独享六档按钮并可自动补充', () => {
  const table = new PokerTable({ chatId: 'chat-bailout', roomId: 'TXAID', ownerOpenId: 'a', config: { startingStack: 1000, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'a', name: '甲' });
  table.join({ openId: 'b', name: '乙' });
  table.playerById('a').stack = 2000;
  table.playerById('b').stack = 900;
  table.playerById('a').inHand = true;
  table.playerById('b').inHand = true;
  table.lastResult = { payouts: { a: 0, b: 0 } };
  table.finishHand(['测试结算']);
  const events = table.drainEvents();
  assert.equal(events.some((item) => item.type === 'bailout_notice_card'), false);
  const result = events.find((item) => item.type === 'result_card');
  const resultJson = JSON.stringify(createResultCard(result));
  assert.match(resultJson, /补充筹码/);
  assert.doesNotMatch(resultJson, /牌技稀烂/);
  const data = table.bailoutCardData('b', result.handNumber);
  assert.equal(data.options.length, 6);
  assert.equal(data.options[0].amount, 150);
  assert.equal(data.options[5].amount, 900);
  const privateJson = JSON.stringify(createExclusiveBailoutCard(data));
  assert.match(privateJson, /牌技稀烂/);
  assert.match(privateJson, /仅你可见/);
  assert.equal((privateJson.match(/BAILOUT_AUTO/g) || []).length, 6);
  assert.equal((privateJson.match(/确认选择/g) || []).length, 6);
  assert.deepEqual(cardActionToCommand({ value: { action: 'BAILOUT_AUTO', level: '6', handNumber: String(result.handNumber) } }), { type: 'BAILOUT', level: 6, handNumber: result.handNumber });
  const receipt = table.grantBailout('b', 1);
  assert.equal(receipt.grant, 100);
  const publicResult = table.drainEvents().find((item) => item.type === 'group');
  assert.match(publicResult.text, new RegExp(receipt.tier.phrase));
  assert.match(publicResult.text, /<at user_id="b">乙<\/at> 说：/);
  assert.match(publicResult.text, /🤡 耻辱补充：1级｜领取 100｜当前筹码 1000/);
  assert.throws(() => table.bailoutCardData('a', result.handNumber), /低于 1000/);
});

test('“筹码”返回当前所有入座玩家的简洁筹码卡', () => {
  const statsStore = { recordHand: () => [], snapshotAll: () => [] };
  const manager = new TableManager({ statsStore, turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'chat-chips', user: { openId: 'a' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'chat-chips', user: { openId: 'a' }, command: { type: 'JOIN', name: '甲' } });
  manager.dispatch({ chatId: 'chat-chips', user: { openId: 'b' }, command: { type: 'JOIN', name: '乙' } });
  const events = manager.dispatch({ chatId: 'chat-chips', user: { openId: 'a' }, command: parseCommand('筹码') });
  assert.equal(events.at(-1).type, 'chips_card');
  const cardJson = JSON.stringify(createChipsCard(events.at(-1)));
  assert.match(cardJson, /当前筹码/);
  assert.match(cardJson, /1000/);
  assert.doesNotMatch(cardJson, /<at /);
  manager.shutdown();
});

test('离桌、解散和重启后仍保留长期筹码，重新加入恢复原余额', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-poker-bankrolls-'));
  const tablesFile = path.join(directory, 'tables.json');
  const statsStore = { recordHand: () => [], snapshotAll: () => [] };
  const config = { tablesFile, statsStore, startingStack: 1000, turnTimeoutMs: 0 };

  const manager = new TableManager(config);
  manager.dispatch({ chatId: 'chat-bankroll', user: { openId: 'a' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'chat-bankroll', user: { openId: 'a', name: '甲' }, command: { type: 'JOIN', name: null } });
  manager.dispatch({ chatId: 'chat-bankroll', user: { openId: 'b', name: '乙' }, command: { type: 'JOIN', name: null } });
  manager.get('chat-bankroll').playerById('b').stack = 4321;
  manager.dispatch({ chatId: 'chat-bankroll', user: { openId: 'b', name: '乙' }, command: { type: 'LEAVE' } });

  const afterLeave = manager.dispatch({ chatId: 'chat-bankroll', user: { openId: 'a' }, command: { type: 'CHIPS' } })[0];
  assert.deepEqual(afterLeave.players.find((player) => player.openId === 'b'), {
    openId: 'b', name: '乙', stack: 4321, seated: false, inHand: false, folded: false, allIn: false,
  });
  assert.match(JSON.stringify(createChipsCard(afterLeave)), /已离桌/);
  manager.dispatch({ chatId: 'chat-bankroll', user: { openId: 'a' }, command: { type: 'DISBAND' } });
  manager.shutdown();

  const restored = new TableManager(config);
  const withoutTable = restored.dispatch({ chatId: 'chat-bankroll', user: { openId: 'b' }, command: { type: 'CHIPS' } })[0];
  assert.equal(withoutTable.players.find((player) => player.openId === 'b').stack, 4321);
  restored.dispatch({ chatId: 'chat-bankroll', user: { openId: 'a' }, command: { type: 'OPEN' } });
  restored.dispatch({ chatId: 'chat-bankroll', user: { openId: 'b', name: '乙新昵称' }, command: { type: 'JOIN', name: null } });
  assert.equal(restored.get('chat-bankroll').playerById('b').stack, 4321);
  assert.equal(restored.get('chat-bankroll').playerById('b').name, '乙新昵称');
  restored.shutdown();

  const saved = JSON.parse(fs.readFileSync(tablesFile, 'utf8'));
  assert.equal(saved.version, 3);
  assert.equal(saved.bankrolls['chat-bankroll'].b.stack, 4321);
  fs.rmSync(directory, { recursive: true });
});

test('“战绩”返回历史卡片，两个验牌口令返回固定彩蛋', () => {
  const statsStore = { recordHand: () => [], snapshotAll: () => [{ openId: 'ou_a', name: '甲', hands: 3, wins: 2, totalNet: 500, biggestWin: 400, bailoutCount: 2, bailoutTotal: 600, bailoutPhrases: { '测试补充语录': 2 } }] };
  const manager = new TableManager({ statsStore, turnTimeoutMs: 0 });
  const stats = manager.dispatch({ chatId: 'chat-stats', user: { openId: 'ou_a' }, command: parseCommand('战绩') });
  assert.equal(stats[0].type, 'stats_card');
  assert.equal(stats[0].stats[0].hands, 3);
  const statsCard = JSON.stringify(createStatsCard(stats[0]));
  assert.match(statsCard, /补充筹码耻辱榜/);
  assert.match(statsCard, /补充.*2 次/);
  assert.match(statsCard, /测试补充语录/);
  for (const phrase of ['我要验牌', '窝腰验牌']) {
    const event = manager.dispatch({ chatId: 'chat-stats', user: { openId: 'ou_a' }, command: parseCommand(phrase) });
    assert.equal(event[0].text, '牌没有问题，给我擦皮鞋');
  }
  manager.shutdown();
});

test('“规则”在没有牌桌时也能返回完整的新手教学卡', () => {
  const statsStore = { recordHand: () => [], snapshotAll: () => [] };
  const manager = new TableManager({ statsStore, turnTimeoutMs: 0 });
  const events = manager.dispatch({ chatId: 'chat-rules', user: { openId: 'ou_new' }, command: parseCommand('规则') });
  assert.equal(events[0].type, 'rules_card');
  const serialized = JSON.stringify(createRulesCard(events[0]));
  assert.match(serialized, /翻牌前 Preflop/);
  assert.match(serialized, /加注20/);
  assert.match(serialized, /牌型大小/);
  manager.shutdown();
});

test('补充筹码延迟到账，撤回原消息会精确取消', async () => {
  const committed = [];
  const scheduler = new BailoutScheduler({ delayMs: 60000, onCommit: async (pending) => committed.push(pending.messageId) });
  scheduler.schedule({ messageId: 'om_recalled', chatId: 'chat-a', openId: 'ou_a', command: { type: 'BAILOUT', level: 1 } });
  assert.ok(scheduler.cancel('om_recalled'));
  assert.equal(await scheduler.commit('om_recalled'), false);
  assert.deepEqual(committed, []);

  scheduler.schedule({ messageId: 'om_kept', chatId: 'chat-a', openId: 'ou_a', command: { type: 'BAILOUT', level: 2 } });
  assert.throws(() => scheduler.schedule({ messageId: 'om_duplicate', chatId: 'chat-a', openId: 'ou_a', command: { type: 'BAILOUT', level: 3 } }), /等待到账/);
  assert.equal(await scheduler.commit('om_kept'), true);
  assert.deepEqual(committed, ['om_kept']);
  scheduler.schedule({ messageId: 'om_disbanded', chatId: 'chat-b', openId: 'ou_b', command: { type: 'BAILOUT', level: 3 } });
  assert.equal(scheduler.cancelChat('chat-b').length, 1);
  assert.equal(await scheduler.commit('om_disbanded'), false);
  scheduler.shutdown();
});

test('超时前提醒会 @ 当前玩家', () => {
  const table = new PokerTable({ chatId: 'chat-warning', roomId: 'TXWARN', ownerOpenId: 'ou_a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'ou_a', name: '甲' });
  table.join({ openId: 'ou_b', name: '乙' });
  table.startHand();
  table.drainEvents();
  assert.equal(table.warnTurn(table.turnVersion, 10), true);
  const warning = table.drainEvents().find((event) => event.type === 'group').text;
  const warned = table.playerAtSeat(table.activeSeat);
  assert.match(warning, new RegExp(`<at user_id="${warned.openId}">${warned.name}<\\/at>`));
  assert.match(warning, /还剩 10 秒/);
});

test('同一玩家连续两局超时会在下一局自动暂停参赛', () => {
  const table = new PokerTable({ chatId: 'chat-timeout-sit', roomId: 'TXTMO', ownerOpenId: 'ou_a', config: { startingStack: 100, smallBlind: 5, bigBlind: 10 } });
  table.join({ openId: 'ou_a', name: '甲' });
  table.join({ openId: 'ou_b', name: '乙' });
  table.startHand();
  let target = table.playerAtSeat(table.activeSeat);
  table.timeout(table.turnVersion);
  assert.equal(target.timeoutStreak, 1);
  while (table.isActive()) table.fold(table.playerAtSeat(table.activeSeat).openId);
  table.startHand();
  while (table.playerAtSeat(table.activeSeat).openId !== target.openId) {
    table.call(table.playerAtSeat(table.activeSeat).openId);
  }
  table.timeout(table.turnVersion);
  assert.equal(target.timeoutStreak, 2);
  assert.equal(target.sittingOut, true);
});

test('每日称号只统计指定大群，并且同一天只发送一次', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-poker-daily-'));
  const store = new StatsStore(path.join(directory, 'stats.json'));
  const now = new Date('2026-08-20T02:00:00.000Z'); // 北京时间 10:00
  const yesterday = '2026-08-19';
  store.data.daily = {
    [yesterday]: {
      chats: {
        'big-group': { players: {
          a: { openId: 'a', name: '大群赢家', hands: 2, wins: 2, net: 500, allIns: 1, folds: 0, bailoutCount: 0, bailoutTotal: 0, biggestPot: 800 },
          b: { openId: 'b', name: '大群输家', hands: 2, wins: 0, net: -500, allIns: 0, folds: 3, bailoutCount: 1, bailoutTotal: 300, biggestPot: 800 },
        } },
        'small-group': { players: {
          x: { openId: 'x', name: '小群玩家', hands: 20, wins: 20, net: 99999, allIns: 99, folds: 99, bailoutCount: 99, bailoutTotal: 99999, biggestPot: 99999 },
        } },
      },
    },
  };
  store.save();
  const published = [];
  const scheduler = new DailyTitleScheduler({ statsStore: store, targetChatId: 'big-group', now: () => now, onPublish: async (event) => published.push(event) });
  assert.equal(await scheduler.publishPreviousDay(), true);
  assert.equal(await scheduler.publishPreviousDay(), false);
  assert.equal(published.length, 1);
  assert.equal(published[0].chatId, 'big-group');
  assert.doesNotMatch(JSON.stringify(published[0]), /小群玩家/);
  assert.match(JSON.stringify(createDailyTitleCard(published[0])), /大群赢家/);
  assert.equal(millisecondsUntilNextChinaNine(new Date('2026-08-20T00:59:00.000Z')), 60 * 1000);
  fs.rmSync(directory, { recursive: true });
});

test('每次牌桌变化都发送新的群卡片，确保全员同步', async () => {
  const calls = [];
  const client = {
    im: { v1: { message: {
      create: async (payload) => { calls.push({ method: 'create', payload }); return { data: { message_id: 'om_card' } }; },
      patch: async (payload) => { calls.push({ method: 'patch', payload }); return {}; },
    } } },
  };
  const transport = createFeishuTransport(client);
  const event = {
    type: 'table_card', chatId: 'chat-card', cardKey: '1:flop', handNumber: 1, title: '翻牌 Flop', phase: 'flop', board: [],
    pot: 20, currentBet: 0, players: [], action: null, finished: false,
    startingStack: 1000, timeoutSeconds: 60, turnVersion: 3, fallbackText: 'fallback',
  };
  await transport.deliver([event]);
  await transport.deliver([{ ...event, title: '转牌 Turn', turnVersion: 4 }]);
  assert.equal(calls[0].method, 'create');
  assert.equal(calls[0].payload.data.msg_type, 'interactive');
  assert.equal(calls[1].method, 'create');
  assert.equal(calls[1].payload.data.msg_type, 'interactive');
});

test('某位玩家私聊失败不会阻断后续群行动卡片', async () => {
  const calls = [];
  const client = {
    im: { v1: { message: {
      create: async (payload) => {
        calls.push(payload);
        if (payload.params.receive_id_type === 'open_id') throw new Error('private denied');
        return { data: { message_id: 'om_group_card' } };
      },
    } } },
  };
  const transport = createFeishuTransport(client);
  await transport.deliver([
    { type: 'private', openId: 'ou_denied', text: '底牌' },
    {
      type: 'table_card', chatId: 'chat-card', title: '轮到玩家', board: [], pot: 15,
      currentBet: 10, players: [], action: null, finished: false, startingStack: 1000,
      timeoutSeconds: 60, turnVersion: 2, fallbackText: 'fallback',
    },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.msg_type, 'interactive');
});

test('轮到玩家时会自动发送带底牌和操作按钮的私聊卡片', async () => {
  const calls = [];
  const client = { im: { v1: { message: { create: async (payload) => { calls.push(payload); return { data: { message_id: 'om_private_card' } }; } } } } };
  const transport = createFeishuTransport(client);
  await transport.deliver([{
    type: 'private_turn_card', openId: 'ou_actor', chatId: 'chat-origin', handNumber: 3,
    turnVersion: 9, phase: '翻牌 Flop', board: [card(2, 'S'), card(7, 'H'), card(11, 'D')],
    pot: 30, currentBet: 10,
    player: { openId: 'ou_actor', name: '甲', cards: [card(14, 'S'), card(13, 'H')], stack: 990, folded: false },
    action: { openId: 'ou_actor', stack: 990, toCall: 0, minimumTarget: 20 },
    fallbackText: '轮到你行动',
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.receive_id_type, 'open_id');
  assert.equal(calls[0].data.receive_id, 'ou_actor');
  assert.equal(calls[0].data.msg_type, 'interactive');
  assert.match(calls[0].data.content, /仅你可见的底牌/);
  assert.match(calls[0].data.content, /CHECK/);
  assert.match(calls[0].data.content, /chat-origin/);
});

test('@机器人空指令会返回首页卡片，开桌后返回大厅按钮卡片', () => {
  const manager = new TableManager({ startingStack: 1000, turnTimeoutMs: 0 });
  const homeEvent = manager.dispatch({ chatId: 'group-ui', user: { openId: 'owner' }, command: { type: 'INTERFACE' } })[0];
  assert.equal(homeEvent.type, 'home_card');
  const homeCardJson = JSON.stringify(createHomeCard(homeEvent));
  assert.match(homeCardJson, /德州扑克/);
  assert.doesNotMatch(homeCardJson, /进入德州扑克/);
  assert.match(homeCardJson, /谁是卧底/);
  const lobbyEvents = manager.dispatch({ chatId: 'group-ui', user: { openId: 'owner' }, command: { type: 'OPEN' } });
  const lobbyEvent = lobbyEvents.find((event) => event.type === 'lobby_card');
  const lobbyCard = JSON.stringify(createLobbyCard(lobbyEvent));
  assert.match(lobbyCard, /加入牌桌/);
  assert.match(lobbyCard, /开始游戏/);
  assert.equal(cardActionToCommand({ value: { action: 'OPEN' } }).type, 'OPEN');
  assert.deepEqual(cardActionToCommand({ value: { action: 'SELECT_GAME', game: 'undercover' } }), { type: 'SELECT_GAME', game: 'undercover' });
  assert.deepEqual(cardActionToCommand({ value: { action: 'GAME_SHOW_WORD', game: 'undercover' } }), { type: 'SHOW_GAME_WORD' });
  assert.deepEqual(cardActionToCommand({ value: { action: 'GAME_SCORE', game: 'undercover' } }), { type: 'GAME_ACTION', action: 'SCORE' });
  assert.deepEqual(cardActionToCommand({ value: { action: 'GAME_SPEAK_READY', game: 'undercover' } }), { type: 'GAME_ACTION', action: 'ARM_SPEECH' });
  assert.deepEqual(cardActionToCommand({ value: { action: 'GAME_SPEAK_SUBMIT', game: 'undercover' }, formValue: { anonymous_speech: '  我的描述  ' } }), { type: 'GAME_ACTION', action: 'SPEAK', text: '我的描述' });
  assert.deepEqual(cardActionToCommand({ name: 'anonymous_speech_submit', form_value: { anonymous_speech: '飞书只返回按钮名称' } }), { type: 'GAME_ACTION', action: 'SPEAK', text: '飞书只返回按钮名称' });
  assert.deepEqual(cardActionToCommand({ value: { action: 'GAME_ABSTAIN', game: 'undercover' } }), { type: 'GAME_ACTION', action: 'ABSTAIN' });
  assert.deepEqual(cardActionToCommand({ value: { action: 'GAME_LEAVE', game: 'undercover' } }), { type: 'GAME_ACTION', action: 'LEAVE' });
  assert.equal(cardActionToCommand({ value: { action: 'JOIN' } }).type, 'JOIN');
  manager.shutdown();
});

test('只在消息真正艾特机器人时打开大厅，艾特别人保持静默', () => {
  const bot = { openId: 'ou_bot', name: '运营助手' };
  assert.equal(messageMentionsBot({ mentions: [{ id: { open_id: 'ou_bot' }, name: '运营助手' }] }, bot), true);
  assert.equal(messageMentionsBot({ mentions: [{ id: { open_id: 'ou_friend' }, name: '朋友' }] }, bot), false);
  assert.equal(messageMentionsBot({ mentions: [{ name: '运营助手' }] }, { name: '运营助手' }), true);
});

test('无法读取飞书昵称时要求加入昵称，并支持已有玩家改名', () => {
  const manager = new TableManager({ turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'group-name', user: { openId: 'owner' }, command: { type: 'OPEN' } });
  assert.throws(
    () => manager.dispatch({ chatId: 'group-name', user: { openId: 'owner', name: null }, command: { type: 'JOIN', name: null } }),
    /加入 你的昵称/,
  );
  manager.dispatch({ chatId: 'group-name', user: { openId: 'owner', name: null }, command: { type: 'JOIN', name: '旧昵称' } });
  manager.dispatch({ chatId: 'group-name', user: { openId: 'owner', name: null }, command: { type: 'RENAME', name: '新昵称' } });
  assert.equal(manager.get('group-name').playerById('owner').name, '新昵称');
  manager.shutdown();
});

test('牌桌状态写入文件并可在重启后恢复当前行动', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-poker-tables-'));
  const tablesFile = path.join(directory, 'tables.json');
  const config = { tablesFile, startingStack: 200, smallBlind: 5, bigBlind: 10, turnTimeoutMs: 0 };
  const manager = new TableManager(config);
  manager.dispatch({ chatId: 'chat-restore', user: { openId: 'a' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'chat-restore', user: { openId: 'a', name: '甲' }, command: { type: 'JOIN', name: null } });
  manager.dispatch({ chatId: 'chat-restore', user: { openId: 'b', name: '乙' }, command: { type: 'JOIN', name: null } });
  manager.dispatch({ chatId: 'chat-restore', user: { openId: 'a' }, command: { type: 'START' } });
  const before = manager.get('chat-restore');
  const expected = { phase: before.phase, activeSeat: before.activeSeat, board: before.board, stacks: before.players.map((player) => player.stack), deckLength: before.deck.length };
  manager.shutdown();

  const restoredManager = new TableManager(config);
  const restored = restoredManager.get('chat-restore');
  assert.ok(restored);
  assert.equal(restored.phase, expected.phase);
  assert.equal(restored.activeSeat, expected.activeSeat);
  assert.deepEqual(restored.board, expected.board);
  assert.deepEqual(restored.players.map((player) => player.stack), expected.stacks);
  assert.equal(restored.deck.length, expected.deckLength);
  restoredManager.shutdown();
  fs.rmSync(directory, { recursive: true });
});

test('下一局不会自动开始，只有玩家点击按钮后才立即开局', () => {
  const manager = new TableManager({ turnTimeoutMs: 0 });
  manager.dispatch({ chatId: 'chat-delay', user: { openId: 'a' }, command: { type: 'OPEN' } });
  manager.dispatch({ chatId: 'chat-delay', user: { openId: 'a', name: '甲' }, command: { type: 'JOIN', name: null } });
  manager.dispatch({ chatId: 'chat-delay', user: { openId: 'b', name: '乙' }, command: { type: 'JOIN', name: null } });
  manager.get('chat-delay').phase = PHASES.FINISHED;
  assert.equal(manager.get('chat-delay').phase, PHASES.FINISHED);
  const started = manager.dispatch({ chatId: 'chat-delay', user: { openId: 'a' }, command: { type: 'NEXT_HAND' } });
  assert.ok(started.some((event) => event.type === 'start_card'));
  assert.equal(started.some((event) => event.type === 'group' && event.text.includes('秒后开始')), false);
  assert.equal(manager.get('chat-delay').phase, PHASES.PREFLOP);
  manager.shutdown();
});
