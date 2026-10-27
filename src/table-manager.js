'use strict';

const { PokerTable } = require('./table');
const { PHASES } = require('./constants');
const { helpText, parseCommand } = require('./commands');
const path = require('node:path');
const { StatsStore } = require('./stats-store');
const { TableStateStore } = require('./table-state-store');
const { GameManager } = require('./game-manager');

const POKER_FOCUS_COMMANDS = new Set([
  'OPEN', 'JOIN', 'RENAME', 'SIT_OUT', 'TOGGLE_SIT_OUT', 'LEAVE', 'VIEW', 'BAILOUT_MENU', 'START', 'NEXT_HAND',
  'BAILOUT', 'DISBAND', 'CHECK', 'CALL', 'FOLD', 'ALL_IN', 'RAISE_TO',
]);

class TableManager {
  constructor(config = {}) {
    this.config = config;
    this.tables = new Map();
    this.focus = new Map();
    this.bankrolls = {};
    this.sequence = 0;
    this.timers = new Map();
    this.gameTimers = new Map();
    this.eventSink = null;
    this.taskRunner = null;
    this.stats = config.statsStore || new StatsStore(config.statsFile || path.join(__dirname, '..', 'data', 'stats.json'));
    this.games = config.gameManager || new GameManager({ allowSoloGame: config.allowSoloGame, scoreStore: this.stats });
    this.undercoverSpeakTimeoutMs = Math.max(0, Number(config.undercoverSpeakTimeoutMs ?? 60000) || 0);
    this.tableStateStore = config.tableStateStore || (config.tablesFile ? new TableStateStore(config.tablesFile) : null);
    this.restoreTables();
  }

  setEventSink(sink) {
    this.eventSink = sink;
    for (const table of this.tables.values()) this.syncTimer(table);
    for (const chatId of this.games.chatIds?.() || []) this.syncGameTimer(chatId);
  }
  get(chatId) { return this.tables.get(chatId); }

  // Timers must wait their turn behind messages and card clicks of the same
  // group, otherwise their messages can interleave with a reply being sent.
  setTaskRunner(runner) { this.taskRunner = runner; }
  runInChat(chatId, task) {
    return this.taskRunner ? this.taskRunner(chatId, task) : task();
  }

  hasLiveTable(chatId) {
    const table = this.get(chatId);
    return Boolean(table && table.phase !== PHASES.DISBANDED);
  }

  // Which game plain words such as “加入 / 开始 / 解散” belong to in this group.
  // It follows the game the group touched most recently.
  focusOf(chatId) {
    const hasTable = this.hasLiveTable(chatId);
    const hasRoom = Boolean(this.games.get(chatId));
    const focus = this.focus.get(chatId);
    if (focus === 'undercover' && hasRoom) return 'undercover';
    if (focus === 'poker' && hasTable) return 'poker';
    return hasRoom && !hasTable ? 'undercover' : 'poker';
  }

  parseText(chatId, text, openId = null) {
    const allowGeneric = this.focusOf(chatId) === 'undercover';
    return this.games.parseText(chatId, text, openId, { allowGeneric }) || parseCommand(text);
  }

  restoreTables() {
    if (!this.tableStateStore) return;
    const state = this.tableStateStore.load();
    this.sequence = state.sequence;
    this.bankrolls = state.bankrolls || {};
    if (typeof this.games.restore === 'function') this.games.restore(state.games);
    for (const saved of state.tables) {
      try {
        const table = PokerTable.fromState(saved, this.config);
        if (table.phase !== PHASES.DISBANDED) {
          this.tables.set(table.chatId, table);
          this.syncBankrolls(table);
        }
      } catch (error) {
        console.error('跳过损坏的牌桌恢复记录：', error.message || error);
      }
    }
    if (this.tables.size) console.log(`已恢复 ${this.tables.size} 张牌桌。`);
    const roomCount = this.games.chatIds?.().length || 0;
    if (roomCount) console.log(`已恢复 ${roomCount} 个谁是卧底房间。`);
  }

  persist() {
    if (!this.tableStateStore) return;
    for (const table of this.tables.values()) this.syncBankrolls(table);
    this.tableStateStore.save(
      this.sequence,
      [...this.tables.values()].filter((table) => table.phase !== PHASES.DISBANDED).map((table) => table.toState()),
      this.bankrolls,
      typeof this.games.toState === 'function' ? this.games.toState() : null,
    );
  }

  bankrollFor(chatId, openId) {
    return this.bankrolls[chatId]?.[openId] || null;
  }

  rememberBankroll(chatId, player) {
    if (!player?.openId || !Number.isFinite(player.stack)) return;
    if (!this.bankrolls[chatId]) this.bankrolls[chatId] = {};
    this.bankrolls[chatId][player.openId] = {
      openId: player.openId,
      name: player.name || this.bankrolls[chatId][player.openId]?.name || '玩家',
      stack: Math.max(0, Math.trunc(player.stack)),
    };
  }

  syncBankrolls(table) {
    if (!table) return;
    for (const player of table.players) this.rememberBankroll(table.chatId, player);
  }

  chipEvent(chatId, table = null) {
    if (table && table.phase !== PHASES.DISBANDED) this.syncBankrolls(table);
    const seated = new Map((table?.players || []).map((player) => [player.openId, player]));
    const records = Object.values(this.bankrolls[chatId] || {});
    const players = records
      .map((record) => {
        const current = seated.get(record.openId);
        return {
          openId: record.openId,
          name: current?.name || record.name,
          stack: current?.stack ?? record.stack,
          seated: Boolean(current),
          inHand: Boolean(current?.inHand),
          folded: Boolean(current?.folded),
          allIn: Boolean(current?.allIn),
        };
      })
      .sort((a, b) => Number(b.seated) - Number(a.seated) || b.stack - a.stack || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      type: 'chips_card', chatId, players,
      turnVersion: table?.turnVersion || 0,
      fallbackText: `💰 长期筹码\n${players.map((player) => `${player.name}：${player.stack}${player.seated ? '' : '（已离桌）'}`).join('\n') || '当前还没有筹码记录'}`,
    };
  }

  create(chatId, ownerOpenId) {
    const existing = this.get(chatId);
    if (existing && existing.phase !== PHASES.DISBANDED) throw new Error('本群已有牌桌，请先使用“查看”或发送“解散”');
    this.sequence += 1;
    const roomId = `TX${String(this.sequence).padStart(4, '0')}`;
    const table = new PokerTable({ chatId, roomId, ownerOpenId, config: this.config });
    this.tables.set(chatId, table);
    return table;
  }

  seatedOnly(table, openId) {
    if (!table.playerById(openId)) throw new Error('只有已入座玩家可以执行这个命令');
  }

  dispatch({ chatId, user, command }) {
    let table = this.get(chatId);
    if (command.type === 'SELECT_GAME' || command.type === 'GAME_ACTION') this.focus.set(chatId, 'undercover');
    else if (POKER_FOCUS_COMMANDS.has(command.type)) this.focus.set(chatId, 'poker');

    if (command.type === 'INTERFACE') {
      if (this.hasLiveTable(chatId)) {
        return [{ type: 'home_card', chatId, title: '群游戏大厅', pokerAction: 'VIEW', turnVersion: table.turnVersion, fallbackText: '🎮 群游戏大厅\n请选择要玩的游戏。' }];
      }
      return [{ type: 'home_card', chatId, title: '顶尖运营', turnVersion: 0, fallbackText: '🏆 顶尖运营\n请选择要学的运营技能。' }];
    }
    if (command.type === 'HELP') return [{ type: 'group', chatId, text: helpText() }];
    if (command.type === 'SELECT_GAME' || command.type === 'GAME_ACTION') {
      const events = this.games.dispatch(chatId, user, command);
      this.syncGameTimer(chatId);
      this.persist();
      return events;
    }
    if (command.type === 'RULES') return [{ type: 'rules_card', chatId, fallbackText: '发送“规则”可查看德州扑克新手教程。' }];
    if (command.type === 'VERIFY_CARDS') return [{ type: 'group', chatId, text: '牌没有问题，给我擦皮鞋' }];
    if (command.type === 'STATS') {
      const stats = typeof this.stats.snapshotChat === 'function' ? this.stats.snapshotChat(chatId) : this.stats.snapshotAll();
      return [{
        type: 'stats_card', chatId, stats, turnVersion: table?.turnVersion || 0,
        fallbackText: stats.length
          ? `📊 永久战绩\n${stats.map((item) => `${item.name}：${item.hands}局 / ${item.wins}胜 / 净胜负 ${item.totalNet >= 0 ? '+' : ''}${item.totalNet}`).join('\n')}`
          : '📊 永久战绩\n当前还没有已结算的历史战绩。',
      }];
    }
    if (command.type === 'CHIPS') {
      const event = this.chipEvent(chatId, table);
      this.persist();
      return [event];
    }
    if (command.type === 'OPEN') {
      table = this.create(chatId, user.openId);
      table.emitLobbyCard('德州牌桌创建成功');
      return this.collect(table);
    }
    if (!table || table.phase === PHASES.DISBANDED) throw new Error('当前没有牌桌，请先发送“开桌”');

    const existingPlayer = table.playerById(user.openId);
    // The Feishu group nickname is authoritative. Refresh it on every
    // command/card action so cards never mix account names and group names.
    if (existingPlayer && user.name) existingPlayer.name = user.name;

    switch (command.type) {
      case 'JOIN': {
        const resolvedName = command.name || user.name;
        if (!resolvedName) throw new Error('暂时无法自动读取飞书昵称，请在群里发送：加入 你的昵称');
        const saved = this.bankrollFor(chatId, user.openId);
        const player = table.join({ openId: user.openId, name: resolvedName, stack: saved?.stack });
        this.rememberBankroll(chatId, player);
        table.emitLobbyCard(`${player.name} 加入成功${saved ? `，恢复长期筹码 ${player.stack}` : ''}`);
        break;
      }
      case 'RENAME':
        table.rename(user.openId, command.name);
        break;
      case 'SIT_OUT':
        table.setSittingOut(user.openId, command.enabled);
        break;
      case 'TOGGLE_SIT_OUT':
        table.toggleSittingOut(user.openId);
        break;
      case 'LEAVE':
        this.rememberBankroll(chatId, table.playerById(user.openId));
        table.leave(user.openId);
        if (!table.isActive()) table.emitLobbyCard('玩家已离开');
        break;
      case 'VIEW':
        table.emitCurrentInterface();
        break;
      case 'BAILOUT_MENU':
        table.emitBailoutCard();
        break;
      case 'START': this.seatedOnly(table, user.openId); this.syncBankrolls(table); table.startHand(); break;
      case 'NEXT_HAND':
        this.seatedOnly(table, user.openId);
        if (table.isActive()) throw new Error('本局尚未结束，不能开始下一局');
        this.syncBankrolls(table);
        table.startHand();
        break;
      case 'BAILOUT': {
        if (Number.isSafeInteger(command.handNumber)) table.bailoutCardData(user.openId, command.handNumber);
        const receipt = table.grantBailout(user.openId, command.level);
        if (typeof this.stats.recordBailout === 'function') this.stats.recordBailout(receipt.player, receipt.tier, receipt.grant, table.chatId);
        break;
      }
      case 'DISBAND':
        this.syncBankrolls(table);
        table.disband();
        this.clearTimer(chatId);
        break;
      case 'CHECK': table.noteManualAction(user.openId); table.check(user.openId); break;
      case 'CALL': table.noteManualAction(user.openId); table.call(user.openId); break;
      case 'FOLD': table.noteManualAction(user.openId); table.fold(user.openId); break;
      case 'ALL_IN': table.noteManualAction(user.openId); table.allIn(user.openId); break;
      case 'RAISE_TO': table.noteManualAction(user.openId); table.raiseTo(user.openId, command.amount); break;
      default: throw new Error('无法识别命令。发送“帮助”查看可用命令');
    }
    return this.collect(table);
  }

  collect(table) {
    this.syncTimer(table);
    const output = [];
    for (const event of table.drainEvents()) {
      if (event.type !== 'hand_complete') {
        output.push(event);
        continue;
      }
      const stats = event.solo ? [] : this.stats.recordHand(event.players, { chatId: event.chatId, handNumber: event.handNumber, potSize: event.potSize });
      // Settlement stays compact. Permanent stats remain available via “战绩”.
      void stats;
    }
    this.persist();
    return output;
  }

  clearTimer(chatId) {
    const timers = this.timers.get(chatId);
    if (timers) {
      if (timers.warning) clearTimeout(timers.warning);
      if (timers.timeout) clearTimeout(timers.timeout);
    }
    this.timers.delete(chatId);
  }

  clearGameTimer(chatId) {
    const timer = this.gameTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.gameTimers.delete(chatId);
  }

  syncGameTimer(chatId) {
    this.clearGameTimer(chatId);
    const room = this.games.get(chatId);
    if (!room || room.game !== 'undercover' || room.phase !== 'speaking' || !this.undercoverSpeakTimeoutMs) return;
    const expectedOpenId = this.games.currentSpeaker(room)?.openId;
    if (!expectedOpenId) return;
    const timer = setTimeout(() => {
      if (this.gameTimers.get(chatId) === timer) this.gameTimers.delete(chatId);
      this.runInChat(chatId, async () => {
        const events = this.games.timeoutSpeaker(chatId, expectedOpenId);
        if (!events.length) return;
        this.syncGameTimer(chatId);
        this.persist();
        if (this.eventSink) {
          try { await this.eventSink(events); } catch (error) { console.error('发送卧底超时推进卡失败：', error); }
        }
      });
    }, this.undercoverSpeakTimeoutMs);
    this.gameTimers.set(chatId, timer);
  }

  syncTimer(table) {
    this.clearTimer(table.chatId);
    const timeout = table.config.turnTimeoutMs;
    if (!timeout || !table.isActive() || table.activeSeat === null) return;
    const version = table.turnVersion;
    const timers = {};
    const warningMs = Math.min(table.config.turnWarningMs, timeout);
    if (warningMs > 0 && timeout > warningMs) {
      timers.warning = setTimeout(() => this.runInChat(table.chatId, async () => {
        if (!table.warnTurn(version, Math.ceil(warningMs / 1000))) return;
        const events = table.drainEvents();
        if (this.eventSink && events.length) {
          try { await this.eventSink(events); } catch (error) { console.error('发送行动提醒失败：', error); }
        }
      }), timeout - warningMs);
    }
    timers.timeout = setTimeout(() => this.runInChat(table.chatId, async () => {
      // A newer turn may have started while this task waited in the queue;
      // table.timeout() then refuses the stale version.
      if (!table.timeout(version)) return;
      const events = this.collect(table);
      if (this.eventSink && events.length) {
        try { await this.eventSink(events); } catch (error) { console.error('发送超时处理消息失败：', error); }
      }
    }), timeout);
    this.timers.set(table.chatId, timers);
  }

  shutdown() {
    for (const chatId of this.timers.keys()) this.clearTimer(chatId);
    for (const chatId of this.gameTimers.keys()) this.clearGameTimer(chatId);
    this.persist();
  }
}

module.exports = { TableManager };
