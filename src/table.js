'use strict';

const { MAX_PLAYERS, PHASES } = require('./constants');
const { createDeck, shuffle, secureRandomIndex, formatCards } = require('./cards');
const { bestHand, compareScores } = require('./evaluator');
const { BAILOUT_TIERS } = require('./bailout');

const PHASE_LABELS = Object.freeze({
  [PHASES.PREFLOP]: '翻牌前 Preflop',
  [PHASES.FLOP]: '翻牌 Flop',
  [PHASES.TURN]: '转牌 Turn',
  [PHASES.RIVER]: '河牌 River',
  [PHASES.SHOWDOWN]: '摊牌 Showdown',
  [PHASES.WAITING]: '等待开局',
  [PHASES.FINISHED]: '本局已结束',
});

const ACTIVE_PHASES = new Set([PHASES.PREFLOP, PHASES.FLOP, PHASES.TURN, PHASES.RIVER]);

function integer(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function enabled(value) {
  return value === true || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function escapeMentionName(value) {
  return String(value || '玩家')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mentionPlayer(player) {
  return `<at user_id="${player.openId}">${escapeMentionName(player.name)}</at>`;
}

class PokerTable {
  constructor({ chatId, roomId, ownerOpenId, config = {} }) {
    this.chatId = chatId;
    this.roomId = roomId;
    this.ownerOpenId = ownerOpenId;
    this.config = {
      startingStack: integer(config.startingStack, 1000),
      smallBlind: integer(config.smallBlind, 5),
      bigBlind: integer(config.bigBlind, 10),
      turnTimeoutMs: integer(config.turnTimeoutMs, 0),
      turnWarningMs: integer(config.turnWarningMs, 10000),
      allowSoloGame: enabled(config.allowSoloGame),
      turnCardMode: String(config.turnCardMode || '').toLowerCase() === 'group' ? 'group' : 'private',
    };
    if (this.config.smallBlind >= this.config.bigBlind) this.config.smallBlind = Math.max(1, Math.floor(this.config.bigBlind / 2));

    this.players = [];
    this.phase = PHASES.WAITING;
    this.handNumber = 0;
    this.buttonSeat = null;
    this.smallBlindSeat = null;
    this.bigBlindSeat = null;
    this.deck = [];
    this.board = [];
    this.burned = [];
    this.currentBet = 0;
    this.minimumRaise = this.config.bigBlind;
    this.pending = new Set();
    this.actedSinceFullRaise = new Set();
    this.activeSeat = null;
    this.turnVersion = 0;
    this.lastResult = null;
    this.actionLog = [];
    this.events = [];
  }

  emitGroup(text) { this.events.push({ type: 'group', chatId: this.chatId, text }); }
  emitActionGroup(text) {
    const event = { type: 'group', chatId: this.chatId, text };
    this.events.push(event);
    return event;
  }
  appendNextActor(event) {
    if (!event || !this.isActive() || this.activeSeat === null) return;
    const next = this.playerAtSeat(this.activeSeat);
    if (next) event.text += `　下一位：${mentionPlayer(next)}`;
  }
  emitPrivate(openId, text) { this.events.push({ type: 'private', openId, text }); }
  emitPrivateTurnCard(player) {
    const data = this.holeCardData(player.openId, this.handNumber, this.turnVersion);
    this.events.push({
      type: 'private_turn_card', openId: player.openId, ...data,
      fallbackText: `➡️ 轮到你行动\n底牌：${formatCards(player.cards)}\n${data.phase}｜需跟注：${data.action?.toCall || 0}｜当前筹码：${player.stack}`,
    });
  }
  drainEvents() { const events = this.events; this.events = []; return events; }
  isActive() { return ACTIVE_PHASES.has(this.phase); }
  isOwner(openId) { return this.ownerOpenId === openId; }

  toState() {
    return {
      chatId: this.chatId, roomId: this.roomId, ownerOpenId: this.ownerOpenId,
      config: this.config, players: this.players, phase: this.phase, handNumber: this.handNumber,
      buttonSeat: this.buttonSeat, smallBlindSeat: this.smallBlindSeat, bigBlindSeat: this.bigBlindSeat,
      deck: this.deck, board: this.board, burned: this.burned, currentBet: this.currentBet,
      minimumRaise: this.minimumRaise, pending: [...this.pending], actedSinceFullRaise: [...this.actedSinceFullRaise],
      activeSeat: this.activeSeat, turnVersion: this.turnVersion, lastResult: this.lastResult, actionLog: this.actionLog,
    };
  }

  static fromState(state, runtimeConfig = {}) {
    if (!state || !state.chatId || !state.roomId || !state.ownerOpenId) throw new Error('牌桌恢复数据不完整');
    const definedRuntimeConfig = Object.fromEntries(Object.entries(runtimeConfig).filter(([, value]) => value !== undefined));
    const table = new PokerTable({
      chatId: state.chatId, roomId: state.roomId, ownerOpenId: state.ownerOpenId,
      config: { ...(state.config || {}), ...definedRuntimeConfig },
    });
    for (const key of ['players', 'deck', 'board', 'burned', 'actionLog']) table[key] = Array.isArray(state[key]) ? state[key] : [];
    for (const player of table.players) {
      player.sittingOut = Boolean(player.sittingOut);
      player.timeoutStreak = Number(player.timeoutStreak) || 0;
      player.handStartStack = Number.isFinite(player.handStartStack) ? player.handStartStack : player.stack;
      player.handStats = player.handStats && typeof player.handStats === 'object' ? player.handStats : { allIns: 0, folds: 0 };
    }
    for (const key of ['phase', 'handNumber', 'buttonSeat', 'smallBlindSeat', 'bigBlindSeat', 'currentBet', 'minimumRaise', 'activeSeat', 'turnVersion', 'lastResult']) {
      if (state[key] !== undefined) table[key] = state[key];
    }
    table.pending = new Set(Array.isArray(state.pending) ? state.pending : []);
    table.actedSinceFullRaise = new Set(Array.isArray(state.actedSinceFullRaise) ? state.actedSinceFullRaise : []);
    table.events = [];
    return table;
  }

  seatedPlayers() { return this.players.slice().sort((a, b) => a.seat - b.seat); }
  playerById(openId) { return this.players.find((player) => player.openId === openId); }
  playerAtSeat(seat) { return this.players.find((player) => player.seat === seat); }
  inHandPlayers() { return this.players.filter((player) => player.inHand); }
  contenders() { return this.players.filter((player) => player.inHand && !player.folded); }
  actionablePlayers() { return this.players.filter((player) => player.inHand && !player.folded && !player.allIn && player.stack > 0); }
  totalPot() { return this.players.reduce((sum, player) => sum + player.contributed, 0); }

  tableCardData(title, action = null, finished = false) {
    const boardText = this.board.length ? formatCards(this.board) : '等待发牌';
    const fallbackAction = action
      ? `\n轮到 ${mentionPlayer(action)} 行动：${action.toCall > 0 ? `跟注 ${action.toCall}` : '过牌'} / 加注 ${action.minimumTarget} / allin / 弃牌\n其他金额请发送：加注 数字金额`
      : '';
    return {
      type: 'table_card',
      chatId: this.chatId,
      roomId: this.roomId,
      cardKey: `${this.handNumber}:${this.phase}`,
      title,
      phase: PHASE_LABELS[this.phase] || this.phase,
      board: this.board.slice(),
      pot: this.totalPot(),
      currentBet: this.currentBet,
      players: this.seatedPlayers().map((player) => ({
        openId: player.openId,
        name: player.name,
        stack: player.stack,
        folded: player.folded,
        allIn: player.allIn,
        sittingOut: player.sittingOut,
        delta: player.stack - (Number.isFinite(player.handStartStack) ? player.handStartStack : player.stack),
      })),
      actionLog: this.actionLog.slice(-2),
      action,
      finished,
      startingStack: this.config.startingStack,
      timeoutSeconds: Math.floor(this.config.turnTimeoutMs / 1000),
      handNumber: this.handNumber,
      turnVersion: this.turnVersion,
      fallbackText: `🃏 ${title}\n公共牌：${boardText}\n底池：${this.totalPot()}｜当前下注：${this.currentBet}${fallbackAction}`,
    };
  }

  emitTableCard(title, action = null, finished = false) {
    this.events.push(this.tableCardData(title, action, finished));
  }

  currentTableCardData(title = '牌桌已刷新') {
    if (this.isActive()) return this.tableCardData(`${PHASE_LABELS[this.phase]} · ${title}`, this.currentActionData());
    return this.tableCardData(title, null, this.phase === PHASES.FINISHED);
  }

  emitLobbyCard(title = '等待玩家加入') {
    this.events.push({
      type: 'lobby_card',
      chatId: this.chatId,
      title,
      roomId: this.roomId,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      startingStack: this.config.startingStack,
      players: this.seatedPlayers().map((player) => ({ openId: player.openId, name: player.name, stack: player.stack })),
      turnVersion: this.turnVersion,
      fallbackText: `🃏 ${title}\n房间：${this.roomId}\n盲注：${this.config.smallBlind}/${this.config.bigBlind}\n人数：${this.players.length}/9\n发送“加入 昵称”加入，至少 2 人后发送“开始”。`,
    });
  }

  currentActionData() {
    if (!this.isActive() || this.activeSeat === null) return null;
    const player = this.playerAtSeat(this.activeSeat);
    if (!player) return null;
    const call = this.toCall(player);
    const pot = this.totalPot();
    const minimumTarget = this.currentBet === 0
      ? Math.max(this.config.bigBlind, this.minimumRaise)
      : this.currentBet + this.minimumRaise;
    const maximumTarget = player.streetContribution + player.stack;
    const raisePresets = [
      ['½池', 0.5], ['⅔池', 2 / 3], ['满池', 1],
    ].map(([label, ratio]) => {
      const calculated = this.currentBet === 0
        ? Math.ceil(pot * ratio)
        : this.currentBet + Math.ceil((pot + call) * ratio);
      return { label, amount: Math.max(minimumTarget, calculated) };
    }).filter((preset, index, items) => preset.amount <= maximumTarget
      && preset.amount > this.currentBet
      && preset.amount !== minimumTarget
      && items.findIndex((candidate) => candidate.amount === preset.amount) === index);
    return {
      openId: player.openId,
      name: player.name,
      stack: player.stack,
      toCall: call,
      minimumTarget,
      maximumTarget,
      raisePresets,
      potAfterCall: pot + call,
      potOdds: call > 0 ? Math.round((call / (pot + call)) * 100) : 0,
    };
  }

  holeCardData(openId, expectedHandNumber, expectedTurnVersion) {
    if (!this.isActive()) throw new Error('当前没有进行中的牌局');
    if (String(expectedHandNumber) !== String(this.handNumber)) throw new Error('这张卡属于上一局，请使用最新牌桌卡片');
    const player = this.playerById(openId);
    if (!player || !player.inHand || player.cards.length !== 2) throw new Error('你不是本局玩家，无法查看底牌');
    const isCurrent = this.activeSeat === player.seat && !player.folded;
    return {
      chatId: this.chatId,
      handNumber: this.handNumber,
      turnVersion: this.turnVersion,
      phase: PHASE_LABELS[this.phase] || this.phase,
      board: this.board.slice(),
      pot: this.totalPot(),
      currentBet: this.currentBet,
      player: { openId: player.openId, name: player.name, cards: player.cards.slice(), stack: player.stack, folded: player.folded },
      action: isCurrent ? this.currentActionData() : null,
      timeoutSeconds: Math.floor(this.config.turnTimeoutMs / 1000),
    };
  }

  emitCurrentInterface() {
    if (this.phase === PHASES.WAITING) this.emitLobbyCard('当前牌桌');
    else if (this.isActive()) this.emitTableCard(`${PHASE_LABELS[this.phase]} · 当前牌桌`, this.currentActionData());
    else this.emitTableCard('本局已结束', null, true);
  }

  nextSeat(fromSeat, predicate) {
    for (let offset = 1; offset <= MAX_PLAYERS; offset += 1) {
      const seat = ((fromSeat - 1 + offset) % MAX_PLAYERS) + 1;
      const player = this.playerAtSeat(seat);
      if (player && predicate(player)) return seat;
    }
    return null;
  }

  cycleSeatsFrom(firstSeat, players) {
    const wanted = new Set(players.map((player) => player.openId));
    const ordered = [];
    let seat = firstSeat;
    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      const player = this.playerAtSeat(seat);
      if (player && wanted.has(player.openId)) ordered.push(player);
      seat = (seat % MAX_PLAYERS) + 1;
    }
    return ordered;
  }

  join({ openId, name, stack }) {
    if (this.isActive()) throw new Error('游戏已经开始，暂时不能加入');
    const existing = this.playerById(openId);
    if (existing) {
      if (name) existing.name = name;
      throw new Error('你已经在牌桌中');
    }
    if (this.players.length >= MAX_PLAYERS) throw new Error(`牌桌最多只能容纳 ${MAX_PLAYERS} 名玩家`);
    const used = new Set(this.players.map((player) => player.seat));
    const seat = Array.from({ length: MAX_PLAYERS }, (_, index) => index + 1).find((candidate) => !used.has(candidate));
    const initialStack = Number.isSafeInteger(stack) && stack >= 0 ? stack : this.config.startingStack;
    const player = {
      openId,
      name: name || `玩家${seat}`,
      seat,
      stack: initialStack,
      cards: [],
      inHand: false,
      folded: false,
      allIn: false,
      leaving: false,
      contributed: 0,
      streetContribution: 0,
      lastBailoutHand: -1,
      sittingOut: false,
      timeoutStreak: 0,
      handStartStack: initialStack,
      handStats: { allIns: 0, folds: 0 },
    };
    this.players.push(player);
    this.turnVersion += 1;
    return player;
  }

  leave(openId) {
    const player = this.playerById(openId);
    if (!player) throw new Error('你不在这张牌桌中');
    if (!this.isActive()) {
      this.players = this.players.filter((candidate) => candidate.openId !== openId);
      this.turnVersion += 1;
      this.emitGroup(`👋 ${player.name} 已离开牌桌。`);
      return;
    }
    player.leaving = true;
    this.emitGroup(`👋 ${player.name} 将在本局结束后离桌。`);
    if (player.inHand && !player.folded) {
      this.foldPlayer(player, { forced: true, reason: '离桌' });
    }
  }

  rename(openId, rawName) {
    const player = this.playerById(openId);
    if (!player) throw new Error('请先加入牌桌');
    const name = String(rawName || '').trim();
    if (!name || name.length > 20) throw new Error('昵称长度必须为 1 到 20 个字符');
    player.name = name;
    this.emitGroup(`✏️ 昵称已修改为：${name}`);
    return player;
  }

  setSittingOut(openId, enabled) {
    const player = this.playerById(openId);
    if (!player) throw new Error('请先加入牌桌');
    player.sittingOut = Boolean(enabled);
    if (!player.sittingOut) player.timeoutStreak = 0;
    this.emitGroup(`${player.sittingOut ? '⏸️' : '▶️'} ${mentionPlayer(player)} ${player.sittingOut ? '将在下一局暂停参赛' : '已恢复参赛'}`);
    return player;
  }

  toggleSittingOut(openId) {
    const player = this.playerById(openId);
    if (!player) throw new Error('请先加入牌桌');
    return this.setSittingOut(openId, !player.sittingOut);
  }

  canReceiveBailout(openId) {
    if (this.isActive()) throw new Error('牌局进行中，结算后才能领取救济筹码');
    const player = this.playerById(openId);
    if (!player) throw new Error('请先加入牌桌');
    if (player.stack >= 1000) throw new Error(`你还有 ${player.stack} 筹码，只有筹码低于 1000 才能使用补充口令`);
    if (player.lastBailoutHand === this.handNumber) throw new Error('你在本局结算后已经补充过一次筹码，请参加下一局后再使用');
    return player;
  }

  bailoutOptions() {
    const currentHighest = Math.max(0, ...this.players.map((player) => player.stack));
    const highestStack = currentHighest > 0 ? currentHighest : this.config.startingStack;
    return {
      highestStack,
      options: BAILOUT_TIERS.map((tier) => ({ ...tier })),
    };
  }

  grantBailout(openId, level) {
    const player = this.canReceiveBailout(openId);
    const bailout = this.bailoutOptions();
    const selected = bailout.options.find((option) => option.level === Number(level));
    if (!selected) throw new Error('无法识别补充筹码档位');
    const grant = Math.min(
      selected.amount,
      Math.max(0, 1000 - player.stack),
      Math.max(0, bailout.highestStack - player.stack - 200),
    );
    if (grant <= 0) throw new Error('你当前已接近筹码王；必须为筹码王保留至少 200 筹码的领先优势');
    player.stack += grant;
    player.lastBailoutHand = this.handNumber;
    this.turnVersion += 1;
    player.allIn = false;
    player.folded = false;
    this.emitGroup(`💸 ${mentionPlayer(player)} 说：“${selected.phrase}”\n🤡 耻辱补充：${selected.level}级｜领取 ${grant}｜当前筹码 ${player.stack}`);
    return { player, tier: selected, grant };
  }

  bailoutCardData(openId, expectedHandNumber) {
    if (String(this.handNumber) !== String(expectedHandNumber)) throw new Error('这张补充提醒属于上一局，请使用最新卡片');
    const player = this.canReceiveBailout(openId);
    const bailout = this.bailoutOptions();
    return {
      chatId: this.chatId,
      handNumber: this.handNumber,
      turnVersion: this.turnVersion,
      player: { openId: player.openId, name: player.name, stack: player.stack },
      highestStack: bailout.highestStack,
      options: bailout.options,
    };
  }

  emitChipCard() {
    const players = this.seatedPlayers().map((player) => ({
      openId: player.openId,
      name: player.name,
      stack: player.stack,
      inHand: player.inHand,
      folded: player.folded,
      allIn: player.allIn,
    }));
    this.events.push({
      type: 'chips_card', chatId: this.chatId, players,
      turnVersion: this.turnVersion,
      fallbackText: `💰 当前筹码\n${players.map((player) => `${player.name}：${player.stack}`).join('\n')}`,
    });
  }

  emitBailoutCard() {
    if (this.isActive()) throw new Error('牌局进行中，结算后才能补充筹码');
    const players = this.seatedPlayers()
      .filter((player) => player.stack < 1000 && player.lastBailoutHand !== this.handNumber)
      .map((player) => ({ openId: player.openId, name: player.name, stack: player.stack }));
    if (!players.length) throw new Error('当前没有可以补充筹码的玩家');
    const bailout = this.bailoutOptions();
    this.events.push({
      type: 'bailout_card', chatId: this.chatId, roomId: this.roomId,
      handNumber: this.handNumber, turnVersion: this.turnVersion,
      players, highestStack: bailout.highestStack,
      fallbackText: `🆘 可补充筹码\n${players.map((player) => `${player.name}：${player.stack}`).join('\n')}\n符合条件的玩家请点击卡片查看补充档位。`,
    });
  }

  removeDepartedPlayers() {
    this.players = this.players.filter((player) => !player.leaving);
  }

  startHand() {
    if (this.isActive()) throw new Error('本局尚未结束，不能重新开始');
    this.removeDepartedPlayers();
    const bankruptPlayers = this.players.filter((player) => player.stack <= 0);
    if (bankruptPlayers.length) {
      throw new Error(`${bankruptPlayers.map((player) => player.name).join('、')} 筹码为 0，暂时不能开始；请先发送“补充”领取筹码，或者离开牌桌`);
    }
    const participants = this.players.filter((player) => player.stack > 0 && !player.sittingOut);
    if (participants.length < 2 && !this.config.allowSoloGame) throw new Error('至少需要 2 名拥有筹码的玩家才能开始');
    if (participants.length < 1) throw new Error('至少需要 1 名拥有筹码的玩家才能开始');

    this.handNumber += 1;
    this.phase = PHASES.PREFLOP;
    this.board = [];
    this.burned = [];
    this.deck = shuffle(createDeck());
    this.currentBet = 0;
    this.minimumRaise = this.config.bigBlind;
    this.pending.clear();
    this.actedSinceFullRaise.clear();
    this.lastResult = null;
    this.actionLog = [];

    for (const player of this.players) {
      player.cards = [];
      player.inHand = participants.includes(player);
      player.folded = false;
      player.allIn = false;
      player.contributed = 0;
      player.streetContribution = 0;
      player.handStartStack = player.stack;
      player.handStats = { allIns: 0, folds: 0 };
    }

    // Every hand independently draws a dealer with secure randomness.
    // Blinds remain clockwise from that dealer so betting order stays valid.
    this.buttonSeat = participants[secureRandomIndex(participants.length)].seat;
    const handPlayers = this.inHandPlayers();
    const solo = handPlayers.length === 1;
    const headsUp = handPlayers.length === 2;
    this.smallBlindSeat = solo ? this.buttonSeat : headsUp ? this.buttonSeat : this.nextSeat(this.buttonSeat, (player) => player.inHand);
    this.bigBlindSeat = solo ? this.buttonSeat : this.nextSeat(this.smallBlindSeat, (player) => player.inHand);

    // Deal clockwise from the small blind. Cards are never put in group messages.
    const firstDealSeat = this.smallBlindSeat;
    for (let round = 0; round < 2; round += 1) {
      for (const player of this.cycleSeatsFrom(firstDealSeat, handPlayers)) player.cards.push(this.deck.pop());
    }

    const sb = this.playerAtSeat(this.smallBlindSeat);
    const bb = this.playerAtSeat(this.bigBlindSeat);
    let smallBlindAmount = 0;
    let bigBlindAmount = 0;
    if (solo) {
      this.commit(bb, Math.min(bb.stack, this.config.bigBlind));
      bigBlindAmount = bb.streetContribution;
    } else {
      this.commit(sb, Math.min(sb.stack, this.config.smallBlind));
      smallBlindAmount = sb.streetContribution;
      this.commit(bb, Math.min(bb.stack, this.config.bigBlind));
      bigBlindAmount = bb.streetContribution;
    }
    this.currentBet = Math.max(sb.streetContribution, bb.streetContribution);
    this.minimumRaise = this.config.bigBlind;
    this.pending = new Set(this.actionablePlayers().map((player) => player.openId));
    this.activeSeat = solo || headsUp ? this.buttonSeat : this.nextSeat(this.bigBlindSeat, (player) => this.pending.has(player.openId));
    if (this.activeSeat === null && this.pending.size > 0) this.activeSeat = this.nextSeat(this.bigBlindSeat, (player) => this.pending.has(player.openId));
    this.turnVersion += 1;

    this.events.push({
      type: 'start_card', chatId: this.chatId, handNumber: this.handNumber,
      dealer: this.playerAtSeat(this.buttonSeat), smallBlind: sb, bigBlind: bb,
      smallBlindAmount, bigBlindAmount,
      solo,
      turnCardMode: this.config.turnCardMode,
      turnVersion: this.turnVersion,
      fallbackText: `🎮 第 ${this.handNumber} 局开始\n庄家：${this.playerAtSeat(this.buttonSeat).name}\n小盲：${sb.name} ${smallBlindAmount}\n大盲：${bb.name} ${bigBlindAmount}\n🃏 每局开始私聊一次底牌，后续行动在群卡完成。`,
    });
    for (const player of handPlayers) {
      const willReceivePrivateTurnCard = this.config.turnCardMode === 'private' && this.pending.has(player.openId) && player.seat === this.activeSeat;
      if (!willReceivePrivateTurnCard) this.emitPrivate(player.openId, `🔒 第 ${this.handNumber} 局底牌\n${formatCards(player.cards)}\n当前筹码：${player.stack}\n后续行动请使用群里的最新牌桌卡片。`);
    }
    this.progress(this.bigBlindSeat);
  }

  commit(player, amount) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > player.stack) throw new Error('非法下注金额');
    player.stack -= amount;
    player.contributed += amount;
    player.streetContribution += amount;
    if (player.stack === 0) player.allIn = true;
  }

  ensureTurn(openId) {
    if (!this.isActive()) throw new Error('当前没有进行中的牌局');
    const player = this.playerById(openId);
    if (!player || !player.inHand || player.folded) throw new Error('你不在本局牌局中');
    if (this.activeSeat !== player.seat) throw new Error(`现在轮到 ${this.playerAtSeat(this.activeSeat).name} 行动`);
    return player;
  }

  toCall(player) { return Math.max(0, this.currentBet - player.streetContribution); }

  recordAction(player, description) {
    this.actionLog.push(`${player.name}：${description}`);
    if (this.actionLog.length > 20) this.actionLog.shift();
  }

  noteManualAction(openId) {
    const player = this.playerById(openId);
    if (player) player.timeoutStreak = 0;
  }

  check(openId) {
    const player = this.ensureTurn(openId);
    if (this.toCall(player) !== 0) throw new Error(`当前需要跟注 ${this.toCall(player)}，不能过牌`);
    this.recordAction(player, '过牌');
    const notice = this.emitActionGroup(`✅ ${mentionPlayer(player)}：过牌`);
    this.finishAction(player, { previousSeat: player.seat });
    this.appendNextActor(notice);
  }

  call(openId) {
    const player = this.ensureTurn(openId);
    const required = this.toCall(player);
    if (required === 0) throw new Error('当前无需跟注，请使用“过牌”');
    const amount = Math.min(required, player.stack);
    this.commit(player, amount);
    this.recordAction(player, `${amount < required ? '跟注全下' : '跟注'} ${amount}`);
    const notice = this.emitActionGroup(`💰 ${mentionPlayer(player)}：${amount < required ? '跟注全下' : '跟注'} ${amount}`);
    this.finishAction(player, { previousSeat: player.seat });
    this.appendNextActor(notice);
  }

  raiseTo(openId, rawTarget) {
    const player = this.ensureTurn(openId);
    const target = Number(rawTarget);
    if (!Number.isSafeInteger(target) || target <= 0) throw new Error('加注金额必须是正整数');
    if (this.actedSinceFullRaise.has(player.openId)) throw new Error('此前的短码全下未重新开放加注；你只能跟注、过牌或弃牌');
    if (target <= this.currentBet) throw new Error(`加注总额必须大于当前下注 ${this.currentBet}`);
    if (target > player.streetContribution + player.stack) throw new Error('筹码不足，请降低金额或使用 allin');
    const oldBet = this.currentBet;
    const increase = target - oldBet;
    const isAllIn = target === player.streetContribution + player.stack;
    if (increase < this.minimumRaise && !isAllIn) {
      throw new Error(`最小加注到 ${this.currentBet + this.minimumRaise}；短码全下除外`);
    }
    const opening = this.currentBet === 0;
    this.commit(player, target - player.streetContribution);
    this.recordAction(player, `${opening ? '下注' : '加注'}到 ${target}${player.allIn ? '（全下）' : ''}`);
    const notice = this.emitActionGroup(`💰 ${mentionPlayer(player)}：${opening ? '下注' : '加注'}到 ${target}${player.allIn ? '（全下）' : ''}`);
    this.finishAction(player, {
      previousSeat: player.seat,
      oldBet,
      raisedTo: target,
      fullRaise: increase >= this.minimumRaise,
    });
    this.appendNextActor(notice);
  }

  allIn(openId) {
    const player = this.ensureTurn(openId);
    if (player.stack <= 0) throw new Error('你已经全下');
    const target = player.streetContribution + player.stack;
    const oldBet = this.currentBet;
    const increase = Math.max(0, target - oldBet);
    const fullRaise = increase >= this.minimumRaise;
    this.commit(player, player.stack);
    player.handStats.allIns += 1;
    this.recordAction(player, `All-in 到 ${target}`);
    const notice = this.emitActionGroup(`🔥 ${mentionPlayer(player)}：全下到 ${target}`);
    this.finishAction(player, {
      previousSeat: player.seat,
      oldBet,
      raisedTo: target > oldBet ? target : null,
      fullRaise,
    });
    this.appendNextActor(notice);
  }

  fold(openId) {
    const player = this.ensureTurn(openId);
    this.foldPlayer(player, { forced: false, reason: '弃牌' });
  }

  foldPlayer(player, { forced, reason }) {
    player.folded = true;
    if (!forced) player.handStats.folds += 1;
    this.recordAction(player, `${reason}${forced ? '（自动）' : ''}`);
    this.pending.delete(player.openId);
    this.actedSinceFullRaise.add(player.openId);
    const notice = this.emitActionGroup(`${forced ? '⏱️' : '🗑️'} ${mentionPlayer(player)}：${reason}${forced ? '（自动）' : ''}`);
    this.progress(player.seat);
    this.appendNextActor(notice);
  }

  finishAction(player, { previousSeat, oldBet = this.currentBet, raisedTo = null, fullRaise = false }) {
    this.pending.delete(player.openId);
    this.actedSinceFullRaise.add(player.openId);
    if (raisedTo !== null && raisedTo > oldBet) {
      this.currentBet = raisedTo;
      if (fullRaise) {
        this.minimumRaise = raisedTo - oldBet;
        this.actedSinceFullRaise = new Set([player.openId]);
        this.pending = new Set(this.actionablePlayers().filter((candidate) => candidate.openId !== player.openId).map((candidate) => candidate.openId));
      } else {
        for (const candidate of this.actionablePlayers()) {
          if (candidate.openId !== player.openId && candidate.streetContribution < this.currentBet) this.pending.add(candidate.openId);
        }
      }
    }
    this.progress(previousSeat);
  }

  progress(previousSeat) {
    this.pending = new Set([...this.pending].filter((openId) => {
      const player = this.playerById(openId);
      return player && player.inHand && !player.folded && !player.allIn && player.stack > 0;
    }));
    const remaining = this.contenders();
    const soloTestHand = this.config.allowSoloGame && this.inHandPlayers().length === 1;
    if (remaining.length === 1 && !soloTestHand) {
      this.finishUncontested(remaining[0]);
      return;
    }
    const actionable = this.actionablePlayers();
    if (remaining.length > 1 && actionable.length <= 1 && (!actionable.length || this.toCall(actionable[0]) === 0)) {
      this.pending.clear();
      this.runoutToShowdown();
      return;
    }
    if (this.pending.size > 0) {
      this.activeSeat = this.nextSeat(previousSeat, (player) => this.pending.has(player.openId));
      this.turnVersion += 1;
      this.promptCurrent();
      return;
    }
    this.completeStreet();
  }

  runoutToShowdown() {
    this.emitGroup('⚡ 已无人需要继续决策，自动发完公共牌并结算。');
    while (this.phase !== PHASES.RIVER) {
      if (this.phase === PHASES.PREFLOP) {
        this.phase = PHASES.FLOP;
        this.dealBoard(3);
      } else if (this.phase === PHASES.FLOP) {
        this.phase = PHASES.TURN;
        this.dealBoard(1);
      } else if (this.phase === PHASES.TURN) {
        this.phase = PHASES.RIVER;
        this.dealBoard(1);
      }
    }
    this.showdown();
  }

  completeStreet() {
    if (this.phase === PHASES.RIVER) {
      this.showdown();
      return;
    }
    if (this.phase === PHASES.PREFLOP) {
      this.phase = PHASES.FLOP;
      this.dealBoard(3);
    } else if (this.phase === PHASES.FLOP) {
      this.phase = PHASES.TURN;
      this.dealBoard(1);
    } else if (this.phase === PHASES.TURN) {
      this.phase = PHASES.RIVER;
      this.dealBoard(1);
    }
    for (const player of this.inHandPlayers()) player.streetContribution = 0;
    this.currentBet = 0;
    this.minimumRaise = this.config.bigBlind;
    this.actedSinceFullRaise.clear();
    this.pending = new Set(this.actionablePlayers().map((player) => player.openId));
    this.progress(this.buttonSeat);
  }

  dealBoard(count) {
    this.burned.push(this.deck.pop());
    for (let index = 0; index < count; index += 1) this.board.push(this.deck.pop());
  }

  promptCurrent() {
    const player = this.playerAtSeat(this.activeSeat);
    if (!player) return;
    const call = this.toCall(player);
    const minimumTarget = this.currentBet === 0
      ? Math.max(this.config.bigBlind, this.minimumRaise)
      : this.currentBet + this.minimumRaise;
    const options = call === 0
      ? `请直接回复以下一个指令：\n• 过牌（不下注）\n• 加注 ${minimumTarget}（至少下注到 ${minimumTarget}）\n• allin（全部筹码）\n• 弃牌`
      : `你需要补 ${call} 筹码，请直接回复以下一个指令：\n• 跟注（补 ${call}）\n• 加注 ${minimumTarget}（至少加注到 ${minimumTarget}）\n• allin（全部筹码）\n• 弃牌`;
    this.emitTableCard(`${PHASE_LABELS[this.phase]} · 轮到玩家行动`, this.currentActionData());
    if (this.config.turnCardMode === 'private') this.emitPrivateTurnCard(player);
  }

  warnTurn(expectedVersion, remainingSeconds) {
    if (!this.isActive() || this.turnVersion !== expectedVersion || this.activeSeat === null) return false;
    const player = this.playerAtSeat(this.activeSeat);
    if (!player) return false;
    this.emitGroup(`⏳ ${mentionPlayer(player)} 还剩 ${remainingSeconds} 秒，请点击牌桌卡片按钮完成操作。`);
    if (this.config.turnCardMode === 'private') this.emitPrivate(player.openId, `⏳ 行动时间还剩 ${remainingSeconds} 秒，超时将自动弃牌。`);
    return true;
  }

  buildPots() {
    const levels = [...new Set(this.players.filter((player) => player.contributed > 0).map((player) => player.contributed))].sort((a, b) => a - b);
    let previous = 0;
    const pots = [];
    for (const level of levels) {
      const contributors = this.players.filter((player) => player.contributed >= level);
      const amount = (level - previous) * contributors.length;
      const eligible = contributors.filter((player) => player.inHand && !player.folded);
      if (amount > 0 && eligible.length > 0) pots.push({ amount, contributors, eligible });
      previous = level;
    }
    return pots;
  }

  showdown() {
    this.phase = PHASES.SHOWDOWN;
    this.activeSeat = null;
    const pots = this.buildPots();
    const handById = new Map();
    for (const player of this.contenders()) handById.set(player.openId, bestHand([...player.cards, ...this.board]));
    const payouts = new Map(this.players.map((player) => [player.openId, 0]));
    const resultLines = [`🏁 摊牌结算\n公共牌：${formatCards(this.board)}`];
    const potSummaries = [];
    for (const player of this.contenders()) {
      const hand = handById.get(player.openId);
      resultLines.push(`${player.name}：${formatCards(player.cards)}｜${hand.name}`);
    }
    const soloTestHand = this.config.allowSoloGame && this.inHandPlayers().length === 1;
    if (soloTestHand) {
      const player = this.inHandPlayers()[0];
      resultLines.push(`单人测试局：已扣除本局投入 ${player.contributed} 筹码。`);
      this.lastResult = {
        pots,
        payouts: Object.fromEntries(payouts),
        board: this.board.slice(),
        hands: Object.fromEntries([...handById].map(([openId, hand]) => [openId, hand.name])),
      };
      this.finishHand(resultLines);
      return;
    }
    pots.forEach((pot, index) => {
      let winners = [pot.eligible[0]];
      let winningHand = handById.get(winners[0].openId);
      for (const player of pot.eligible.slice(1)) {
        const hand = handById.get(player.openId);
        const comparison = compareScores(hand.score, winningHand.score);
        if (comparison > 0) { winners = [player]; winningHand = hand; }
        else if (comparison === 0) winners.push(player);
      }
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount % winners.length;
      const orderStart = (this.buttonSeat % MAX_PLAYERS) + 1;
      const ordered = this.cycleSeatsFrom(orderStart, winners);
      for (const winner of ordered) {
        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        const prize = share + extra;
        winner.stack += prize;
        payouts.set(winner.openId, payouts.get(winner.openId) + prize);
      }
      const label = index === 0 ? '主池' : `边池${index}`;
      potSummaries.push({ label, amount: pot.amount, winners: ordered.map((player) => ({ openId: player.openId, name: player.name })), handName: winningHand.name });
      resultLines.push(`${label} ${pot.amount}：${ordered.map((player) => player.name).join('、')} 获胜，各得 ${share}${pot.amount % winners.length ? '（含余码分配）' : ''}｜${winningHand.name}`);
    });
    this.lastResult = {
      pots,
      payouts: Object.fromEntries(payouts),
      board: this.board.slice(),
      hands: Object.fromEntries([...handById].map(([openId, hand]) => [openId, hand.name])),
      potSummaries,
    };
    this.finishHand(resultLines);
  }

  finishUncontested(winner) {
    const pot = this.totalPot();
    winner.stack += pot;
    this.lastResult = {
      pots: [{ amount: pot, eligible: [winner] }],
      payouts: { [winner.openId]: pot },
      board: this.board.slice(),
      hands: { [winner.openId]: '未摊牌' },
      potSummaries: [{ label: '底池', amount: pot, winners: [{ openId: winner.openId, name: winner.name }], handName: '未摊牌' }],
    };
    this.finishHand([`🏁 ${winner.name} 其余玩家均已弃牌，赢得底池 ${pot}。`]);
  }

  finishHand(lines) {
    this.phase = PHASES.FINISHED;
    this.activeSeat = null;
    this.pending.clear();
    this.turnVersion += 1;
    const players = this.seatedPlayers().map((player) => {
      const evaluation = player.inHand && player.cards.length === 2 && this.board.length === 5
        ? bestHand([...player.cards, ...this.board]) : null;
      const payout = Number(this.lastResult?.payouts?.[player.openId]) || 0;
      return {
        openId: player.openId, name: player.name, stack: player.stack,
        cards: player.cards.slice(), contributed: player.contributed,
        played: player.inHand, payout, folded: player.folded,
        handName: player.folded ? '已弃牌' : this.lastResult?.hands?.[player.openId] || evaluation?.name || '未摊牌',
        net: payout - player.contributed,
        allIns: Number(player.handStats?.allIns) || 0,
        folds: Number(player.handStats?.folds) || 0,
        canBailout: player.stack < 1000 && player.lastBailoutHand !== this.handNumber,
      };
    });
    this.events.push({
      type: 'result_card', chatId: this.chatId, handNumber: this.handNumber, board: this.board.slice(), lines, players,
      potSummaries: this.lastResult?.potSummaries || [],
      turnVersion: this.turnVersion,
      fallbackText: `${lines.join('\n')}\n\n💵 结算后筹码\n${players.map((player) => `${player.name}：${player.stack}`).join('\n')}`,
    });
    const playedPlayers = players.filter((player) => player.played);
    this.events.push({ type: 'hand_complete', chatId: this.chatId, handNumber: this.handNumber, potSize: players.reduce((sum, player) => sum + player.contributed, 0), players: playedPlayers, solo: playedPlayers.length === 1, turnVersion: this.turnVersion });
    this.removeDepartedPlayers();
  }

  timeout(expectedVersion) {
    if (!this.isActive() || this.turnVersion !== expectedVersion || this.activeSeat === null) return false;
    const player = this.playerAtSeat(this.activeSeat);
    if (!player) return false;
    player.timeoutStreak = (Number(player.timeoutStreak) || 0) + 1;
    if (player.timeoutStreak >= 2) {
      player.sittingOut = true;
      this.emitGroup(`💤 ${mentionPlayer(player)} 已连续两次超时，将从下一局起自动暂停参赛。`);
    }
    this.foldPlayer(player, { forced: true, reason: '行动超时，自动弃牌' });
    return true;
  }

  summary() {
    const playerLines = this.seatedPlayers().map((player) => {
      const flags = [player.seat === this.buttonSeat ? '庄' : '', player.seat === this.smallBlindSeat ? '小盲' : '', player.seat === this.bigBlindSeat ? '大盲' : '', player.leaving ? '离桌中' : ''].filter(Boolean);
      return `${player.seat}号 ${player.name}｜筹码 ${player.stack}${flags.length ? `｜${flags.join('/')}` : ''}`;
    });
    return `🃏 德州牌桌 ${this.roomId}\n状态：${PHASE_LABELS[this.phase] || this.phase}\n盲注：${this.config.smallBlind}/${this.config.bigBlind}\n底池：${this.totalPot()}\n公共牌：${this.board.length ? formatCards(this.board) : '—'}\n玩家（${this.players.length}/${MAX_PLAYERS}）：\n${playerLines.length ? playerLines.join('\n') : '暂无玩家'}${this.activeSeat ? `\n当前行动：${this.playerAtSeat(this.activeSeat).name}` : ''}`;
  }

  disband() {
    if (this.isActive()) throw new Error('游戏进行中，不能解散；请等待本局结束');
    this.phase = PHASES.DISBANDED;
    this.emitGroup(`🛑 牌桌 ${this.roomId} 已解散。`);
  }
}

module.exports = { PokerTable, PHASE_LABELS, ACTIVE_PHASES, mentionPlayer };
