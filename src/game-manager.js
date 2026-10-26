'use strict';

const crypto = require('node:crypto');
const { WORD_PAIRS } = require('./game-content');

function eventBase(chatId, game, title) { return { type: 'game_card', chatId, game, title }; }
function nameOf(state, openId) { return state.players.find((p) => p.openId === openId)?.name || '玩家'; }
function activePlayers(state) { return state.players.filter((p) => p.alive !== false); }
function enabled(value) { return value === true || /^(1|true|yes|on)$/i.test(String(value || '')); }
const ABSTAIN_VOTE = '__abstain__';
const ANONYMOUS_NAMES = Object.freeze([
  '摸鱼王', '卷王', '表哥', '甲方', '投手', '素材佬',
  '数据怪', '爆单王', '背锅侠', '显眼包', '气氛组', '大聪明',
  '戏精', '嘴替', '段子手', '狠人', '社牛', '社恐', '锦鲤', '老六',
]);
function randomIndexExcept(length, excluded = null) {
  if (length <= 1 || !Number.isSafeInteger(excluded)) return crypto.randomInt(length);
  const index = crypto.randomInt(length - 1);
  return index >= excluded ? index + 1 : index;
}
function shuffled(items) {
  const output = items.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(index + 1);
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

class GameManager {
  constructor(config = {}) {
    this.rooms = new Map();
    this.allowSoloGame = enabled(config.allowSoloGame);
    this.scoreStore = config.scoreStore || null;
    this.lastWordIndex = new Map();
  }
  get(chatId) { return this.rooms.get(chatId); }
  parseText(chatId, text, openId = null) {
    const value = String(text || '').trim();
    const room = this.get(chatId);
    if (/^(谁是卧底|卧底)$/.test(value)) return { type: 'SELECT_GAME', game: 'undercover' };
    if (!room) return null;
    if (/^(加入|加入游戏)$/.test(value)) return { type: 'GAME_ACTION', action: 'JOIN' };
    if (/^开始(?:游戏)?$/.test(value)) return { type: 'GAME_ACTION', action: 'START' };
    if (/^离开(?:游戏|房间)?$/.test(value)) return { type: 'GAME_ACTION', action: 'LEAVE' };
    if (/^(查看|状态)$/.test(value)) return { type: 'GAME_ACTION', action: 'VIEW' };
    if (/^(解散|结束游戏|结束房间)$/.test(value)) return { type: 'GAME_ACTION', action: 'END' };
    if (room.game === 'undercover') {
      const vote = value.match(/^投票\s*(.+)$/);
      if (vote) return { type: 'GAME_ACTION', action: 'VOTE_NAME', targetName: vote[1].trim() };
      if (/^(弃票|弃权|过票)$/.test(value)) return { type: 'GAME_ACTION', action: 'ABSTAIN' };
      if (/^比分$/.test(value)) return { type: 'GAME_ACTION', action: 'SCORE' };
    }
    return null;
  }
  currentSpeaker(roomOrChatId) {
    const room = typeof roomOrChatId === 'string' ? this.get(roomOrChatId) : roomOrChatId;
    if (!room || room.phase !== 'speaking') return null;
    const openId = room.speakingOrder?.[room.speakerIndex];
    return room.players.find((player) => player.openId === openId && player.alive !== false) || null;
  }
  privateSpeechTarget(openId) {
    const matches = [...this.rooms.values()].filter((room) => room.game === 'undercover'
      && room.phase === 'speaking'
      && room.speechArmedOpenId === openId
      && this.currentSpeaker(room)?.openId === openId);
    if (matches.length !== 1) return null;
    const room = matches[0];
    return { room, player: this.currentSpeaker(room) };
  }
  parsePrivateSpeech(openId, text) {
    const target = this.privateSpeechTarget(openId);
    const raw = String(text || '').trim();
    if (!target || !raw) return null;
    const content = raw.replace(/^描述\s*/, '').trim();
    if (!content) return null;
    return { chatId: target.room.chatId, player: target.player, command: { type: 'GAME_ACTION', action: 'SPEAK', text: content } };
  }
  prepareSpeakingOrder(room) {
    room.speakingOrder = shuffled(activePlayers(room).map((player) => player.openId));
    room.speakerIndex = 0;
    room.speechArmedOpenId = this.currentSpeaker(room)?.openId || null;
  }
  assignAnonymousNames(room) {
    const available = ANONYMOUS_NAMES.slice();
    for (const player of shuffled(room.players)) {
      const storedName = typeof this.scoreStore?.lastUndercoverAlias === 'function'
        ? this.scoreStore.lastUndercoverAlias(room.chatId, player.openId)
        : null;
      const previousName = player.anonymousName || storedName || null;
      const candidates = available.filter((name) => name !== previousName);
      const selected = candidates[crypto.randomInt(candidates.length)];
      available.splice(available.indexOf(selected), 1);
      player.previousAnonymousName = previousName;
      player.anonymousName = selected;
    }
    if (typeof this.scoreStore?.rememberUndercoverAliases === 'function') this.scoreStore.rememberUndercoverAliases(room.chatId, room.players);
  }
  speakerPrompt(room) {
    const player = this.currentSpeaker(room);
    if (!player) return null;
    room.speechArmedOpenId = player.openId;
    return {
      type: 'private', openId: player.openId,
      text: `🎭 第 ${room.round} 轮轮到你匿名描述\n你的编号：${player.anonymousName}\n直接回复这条私信写描述即可，机器人会代你匿名发送到群里。不要在群里发描述。`,
    };
  }
  select(chatId, user, game) {
    if (game !== 'undercover') throw new Error('无法识别游戏');
    const existing = this.get(chatId);
    if (existing && existing.phase !== 'finished') throw new Error('本群已有游戏房间，请先结束当前游戏');
    const room = { chatId, game, phase: 'lobby', hostId: user.openId, players: [], round: 0, turnVersion: 1 };
    this.rooms.set(chatId, room);
    return this.card(room, '已创建房间');
  }
  dispatch(chatId, user, command) {
    let result;
    if (command.type === 'SELECT_GAME') result = this.select(chatId, user, command.game);
    else if (command.type === 'GAME_ACTION') {
      const room = this.get(chatId);
      const betweenRoundActions = new Set(['SCORE', 'START', 'JOIN', 'LEAVE', 'VIEW', 'END']);
      if (!room || (room.phase === 'finished' && !betweenRoundActions.has(command.action))) throw new Error('当前没有进行中的游戏，请先选择游戏');
      result = this.action(room, user, command);
    } else return [];
    return Array.isArray(result) ? result : [result];
  }
  action(room, user, command) {
    const knownPlayer = room.players.find((player) => player.openId === user.openId);
    if (knownPlayer && user.name) knownPlayer.name = user.name;
    if (command.action === 'VIEW') return this.card(room, '当前房间状态');
    if (command.action === 'END') {
      this.rooms.delete(room.chatId);
      return { type: 'group', chatId: room.chatId, text: '🛑 谁是卧底房间已解散。' };
    }
    if (command.action === 'JOIN') return this.join(room, user);
    if (command.action === 'LEAVE') return this.leave(room, user);
    if (command.action === 'START') return this.start(room, user);
    return this.undercoverAction(room, user, command);
  }
  join(room, user) {
    if (!['lobby', 'finished'].includes(room.phase)) throw new Error('游戏已经开始，不能中途加入');
    if (room.players.some((p) => p.openId === user.openId)) throw new Error('你已经加入这个房间');
    if (room.players.length >= 12) throw new Error('最多 12 名玩家');
    room.players.push({ openId: user.openId, name: user.name || `玩家${room.players.length + 1}`, alive: true });
    room.turnVersion += 1;
    return this.card(room, `${user.name || '玩家'} 加入成功`);
  }
  leave(room, user) {
    if (!['lobby', 'finished'].includes(room.phase)) throw new Error('本局进行中，请在结算后离开房间');
    const player = room.players.find((item) => item.openId === user.openId);
    if (!player) throw new Error('你不在这个房间中');
    room.players = room.players.filter((item) => item.openId !== user.openId);
    room.turnVersion += 1;
    if (room.hostId === user.openId && room.players.length) room.hostId = room.players[0].openId;
    if (!room.players.length) {
      this.rooms.delete(room.chatId);
      return { type: 'group', chatId: room.chatId, text: `👋 ${player.name} 已离开，房间因无人自动关闭。` };
    }
    return this.card(room, `${player.name} 已离开，剩余 ${room.players.length} 人`);
  }
  start(room, user) {
    if (!['lobby', 'finished'].includes(room.phase)) throw new Error('游戏已经开始，请使用最新卡片');
    if (!room.players.some((player) => player.openId === user.openId)) throw new Error('只有已加入玩家可以开始游戏');
    const minimumPlayers = this.allowSoloGame ? 1 : 3;
    if (room.players.length < minimumPlayers) throw new Error('谁是卧底至少需要 3 名玩家');
    room.phase = 'speaking';
    room.lastSettlement = null;
    {
      const wordIndex = randomIndexExcept(WORD_PAIRS.length, this.lastWordIndex.get(room.chatId));
      this.lastWordIndex.set(room.chatId, wordIndex);
      const selectedPair = WORD_PAIRS[wordIndex];
      const pair = crypto.randomInt(2) === 0 ? selectedPair : [selectedPair[1], selectedPair[0]];
      const undercover = crypto.randomInt(room.players.length);
      room.round = 1;
      room.players.forEach((p, i) => { p.secret = i === undercover ? pair[1] : pair[0]; p.isUndercover = i === undercover; p.speeches = []; p.speech = null; p.alive = true; });
      this.assignAnonymousNames(room);
      this.prepareSpeakingOrder(room);
      room.votes = {};
      room.turnVersion += 1;
      const events = room.players.map((p) => ({ type: 'private', openId: p.openId, text: `🔒 谁是卧底 · 仅你可见\n你的编号：${p.anonymousName}\n你的词语是：${p.secret}\n轮到你时机器人会私信提醒；请在私聊回复描述，由机器人匿名代发。` }));
      events.push(this.card(room, '词语已私信发送，也可以点击卡片随时查看'));
      events.push(this.speakerPrompt(room));
      return events;
    }
  }
  undercoverAction(room, user, command) {
    if (command.action === 'SCORE') {
      if (room.phase !== 'finished') throw new Error('本局结算后才能查看比分');
      return this.card(room, '', { scoreOnly: true, scores: this.undercoverScores(room) });
    }
    const player = room.players.find((p) => p.openId === user.openId);
    if (!player || player.alive === false) throw new Error('你不是当前游戏玩家');
    if (command.action === 'ARM_SPEECH') {
      if (room.phase !== 'speaking') throw new Error('当前不是描述阶段');
      if (this.currentSpeaker(room)?.openId !== user.openId) throw new Error('还没轮到你描述');
      room.speechArmedOpenId = user.openId;
      return this.speakerPrompt(room);
    }
    if (room.phase === 'speaking') {
      if (this.currentSpeaker(room)?.openId !== user.openId) throw new Error('还没轮到你描述');
      if (command.action !== 'SPEAK') throw new Error('请在机器人私聊中回复描述内容');
      player.speech = command.text;
      player.speeches.push({ round: room.round, text: command.text });
      room.speechArmedOpenId = null;
      return this.advanceSpeaker(room, `${player.anonymousName} 已匿名描述`);
    }
    if (room.phase === 'voting' && (command.action === 'VOTE_NAME' || command.action === 'ABSTAIN')) {
      room.votes = room.votes || {};
      if (command.action === 'ABSTAIN') room.votes[user.openId] = ABSTAIN_VOTE;
      else {
        const targetName = command.targetName || command.targetOpenId;
        const target = room.players.find((p) => p.anonymousName === targetName || p.name === targetName || p.openId === targetName);
        if (!target || target.alive === false) throw new Error('找不到可投票的玩家');
        room.votes[user.openId] = target.openId;
      }
      if (Object.keys(room.votes).length < activePlayers(room).length) return this.card(room, `${player.name} 已${command.action === 'ABSTAIN' ? '弃票' : '投票'}，等待其他玩家`);
      const ballots = Object.values(room.votes);
      const abstainCount = ballots.filter((id) => id === ABSTAIN_VOTE).length;
      const counts = ballots.filter((id) => id !== ABSTAIN_VOTE).reduce((all, id) => ({ ...all, [id]: (all[id] || 0) + 1 }), {});
      const voteSummary = activePlayers(room).map((item) => ({ openId: item.openId, name: item.anonymousName, votes: counts[item.openId] || 0 }));
      if (abstainCount) voteSummary.push({ openId: ABSTAIN_VOTE, name: '弃票', votes: abstainCount });
      room.votes = {};
      if (!Object.keys(counts).length) return this.nextUndercoverRound(room, '全员弃票，本轮无人淘汰', voteSummary);
      const max = Math.max(...Object.values(counts));
      const leaders = Object.keys(counts).filter((id) => counts[id] === max);
      if (leaders.length !== 1) return this.nextUndercoverRound(room, '本轮平票，无人淘汰', voteSummary);
      const targetId = leaders[0];
      const eliminated = room.players.find((p) => p.openId === targetId);
      eliminated.alive = false;
      const remaining = activePlayers(room);
      const undercovers = remaining.filter((p) => p.isUndercover);
      const civilians = remaining.filter((p) => !p.isUndercover);
      const winner = eliminated.isUndercover ? '平民' : undercovers.length >= civilians.length ? '卧底' : null;
      if (winner) {
        room.phase = 'finished';
        room.turnVersion += 1;
        this.recordUndercoverResult(room, winner);
        const undercoverPlayers = room.players.filter((p) => p.isUndercover);
        const civilianPlayer = room.players.find((p) => !p.isUndercover);
        const settlement = {
          voteSummary,
          result: {
            winner,
            eliminated: `${eliminated.anonymousName}（${eliminated.name}）`,
            undercovers: undercoverPlayers.map((p) => `${p.anonymousName}（${p.name}）`),
            undercoverWord: undercoverPlayers[0]?.secret || '未知',
            civilianWord: civilianPlayer?.secret || '未知',
            reveals: room.players.map((p) => ({ name: p.name, anonymousName: p.anonymousName, isUndercover: p.isUndercover })),
          },
          descriptions: this.descriptionSummary(room, room.round, true),
        };
        room.lastSettlement = settlement;
        return this.card(room, `${eliminated.anonymousName} 被淘汰，${winner}获胜`, settlement);
      }
      return this.nextUndercoverRound(room, `${eliminated.anonymousName} 被淘汰`, voteSummary);
    }
    throw new Error('请等待当前阶段结束');
  }
  advanceSpeaker(room, status = '') {
    room.speechArmedOpenId = null;
    const next = Number(room.speakerIndex) + 1;
    room.speakerIndex = next;
    room.turnVersion += 1;
    if (next < room.speakingOrder.length) return [this.card(room, status || '轮到下一位匿名描述'), this.speakerPrompt(room)];
    room.phase = 'voting';
    return this.card(room, '描述结束，请点击匿名编号投票');
  }
  nextUndercoverRound(room, status, voteSummary) {
    const completedRound = room.round;
    room.phase = 'speaking'; room.round += 1; this.prepareSpeakingOrder(room);
    room.turnVersion += 1;
    return [this.card(room, `${status}，进入第 ${room.round} 轮匿名描述`, { voteSummary, descriptions: this.descriptionSummary(room, completedRound) }), this.speakerPrompt(room)];
  }
  timeoutSpeaker(chatId, expectedOpenId) {
    const room = this.get(chatId);
    if (!room || room.game !== 'undercover' || room.phase !== 'speaking') return [];
    const player = this.currentSpeaker(room);
    if (!player || player.openId !== expectedOpenId) return [];
    player.speech = null;
    player.speeches.push({ round: room.round, text: '（未发言）' });
    room.speechArmedOpenId = null;
    const event = this.advanceSpeaker(room, '上一位未发言，已自动跳过');
    return Array.isArray(event) ? event : [event];
  }
  wordData(chatId, openId) {
    const room = this.get(chatId);
    if (!room || room.game !== 'undercover' || room.phase === 'lobby') throw new Error('卧底游戏还没有开始');
    const player = room.players.find((item) => item.openId === openId);
    if (!player || !player.secret) throw new Error('你不是本局玩家');
    const currentSpeaker = this.currentSpeaker(room);
    return { chatId, openId, word: player.secret, anonymousName: player.anonymousName, round: room.round || 1, canSpeak: room.phase === 'speaking' && currentSpeaker?.openId === openId, currentSpeakerName: currentSpeaker ? '当前匿名玩家' : null };
  }
  speechData(chatId, openId) {
    const room = this.get(chatId);
    if (!room || room.game !== 'undercover' || room.phase !== 'speaking') throw new Error('当前不是描述阶段');
    const player = room.players.find((item) => item.openId === openId);
    if (!player || player.alive === false) throw new Error('你不是本局玩家');
    if (this.currentSpeaker(room)?.openId !== openId) throw new Error('还没轮到你描述');
    room.speechArmedOpenId = openId;
    return { chatId, openId, anonymousName: player.anonymousName, round: room.round, turnVersion: room.turnVersion };
  }
  undercoverScores(room) {
    if (!this.scoreStore || typeof this.scoreStore.undercoverScores !== 'function') return [];
    return this.scoreStore.undercoverScores(room.chatId, room.players.map((player) => player.openId));
  }
  descriptionSummary(room, round = room.round, reveal = false) {
    return room.players.map((player) => ({ name: reveal ? `${player.anonymousName}（${player.name}）` : player.anonymousName, alive: player.alive !== false, text: player.speeches?.find((speech) => speech.round === round)?.text || '（未发言）' }));
  }
  completedDescriptions(room, round = room.round) {
    return room.players.flatMap((player) => {
      const speech = player.speeches?.find((item) => item.round === round);
      return speech ? [{ name: player.anonymousName, alive: player.alive !== false, text: speech.text }] : [];
    });
  }
  recordUndercoverResult(room, winner) {
    if (!this.scoreStore || typeof this.scoreStore.recordUndercoverGame !== 'function') return [];
    return this.scoreStore.recordUndercoverGame(room.chatId, room.players, winner);
  }
  card(room, status = '', extra = {}) {
    const settlement = room.phase === 'finished' ? (room.lastSettlement || {}) : {};
    const event = { ...eventBase(room.chatId, room.game, '🕵️ 谁是卧底'), phase: room.phase, players: room.players, playerLimit: 12, turnVersion: room.turnVersion, template: room.phase === 'lobby' ? 'turquoise' : room.phase === 'finished' ? 'green' : 'blue', ...settlement, ...extra };
    {
      const phaseLabel = room.phase === 'lobby' ? '等待加入' : room.phase === 'speaking' ? `第 ${room.round} 轮描述` : room.phase === 'voting' ? '投票淘汰' : '本局结算';
      event.body = `**状态：${phaseLabel}**\n${status || '请加入游戏'}`;
      if (room.phase === 'finished') event.title = '🏁 谁是卧底结算';
      if ((room.phase === 'voting' || room.phase === 'finished') && !event.descriptions) event.descriptions = this.descriptionSummary(room);
      if (room.phase === 'lobby') event.actions = [{ label: '加入游戏', action: 'GAME_JOIN', type: 'primary' }, { label: '开始游戏', action: 'GAME_START' }, { label: '解散房间', action: 'GAME_END', type: 'danger' }];
      if (room.phase === 'voting') {
        event.voteActions = activePlayers(room).map((p) => ({ label: p.anonymousName, action: 'GAME_VOTE', extra: { targetOpenId: p.openId } }));
        event.abstainAction = { label: '弃票 / 不投任何人', action: 'GAME_ABSTAIN', type: 'primary' };
        event.utilityActions = [{ label: '查看我的词语', action: 'GAME_SHOW_WORD' }];
        event.note = '每人一票；平票或全员弃票时，无人淘汰并直接进入下一轮描述。';
      }
      if (room.phase === 'speaking') {
        if (!event.descriptions) event.descriptions = this.completedDescriptions(room);
        event.anonymousTurn = Boolean(this.currentSpeaker(room));
        event.currentAnonymousName = this.currentSpeaker(room)?.anonymousName || null;
        event.actions = [{ label: '匿名描述', action: 'GAME_SPEAK_READY', type: 'primary' }, { label: '查看我的词语', action: 'GAME_SHOW_WORD' }];
        event.note = '本轮顺序已随机打乱；当前玩家点击“匿名描述”，在仅本人可见的输入卡中提交。私聊回复仍可作为备用。';
      } else if (room.phase === 'lobby') {
        event.note = '至少 3 名玩家；所有人权限相同，都可以开始或解散房间。';
      } else if (room.phase === 'finished') {
        event.actions = [
          { label: '再来一局', action: 'GAME_START', type: 'primary' },
          { label: '离开房间', action: 'GAME_LEAVE' },
          { label: '加入游戏', action: 'GAME_JOIN' },
          { label: '查看比分', action: 'GAME_SCORE' },
          { label: '解散房间', action: 'GAME_END', type: 'danger' },
        ];
      }
    }
    return event;
  }
}

module.exports = { GameManager };
