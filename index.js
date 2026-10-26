'use strict';

const lark = require('@larksuiteoapi/node-sdk');
require('dotenv').config();

const { parseCommand, normalizeText } = require('./src/commands');
const { TableManager } = require('./src/table-manager');
const { createFeishuTransport } = require('./src/feishu-transport');
const { RecentMessageDeduper, ChatQueue } = require('./src/deduper');
const { cardActionToCommand } = require('./src/interaction-adapter');
const { BailoutScheduler } = require('./src/bailout-scheduler');
const { createTableCard, createExclusiveHoleResponse, createExclusiveBailoutResponse } = require('./src/card-ui');
const { createExclusiveWordResponse, createExclusiveSpeechResponse } = require('./src/game-ui');
const { DailyTitleScheduler } = require('./src/daily-title-scheduler');
const path = require('node:path');

function eventText(message) {
  try {
    const content = JSON.parse(message.content);
    return typeof content.text === 'string' ? normalizeText(content.text) : '';
  } catch {
    return '';
  }
}

function messageMentionsBot(message, botIdentity = {}) {
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  const botOpenId = String(botIdentity.openId || '').trim();
  const botName = String(botIdentity.name || '运营助手').trim();
  return mentions.some((mention) => {
    const mentionedOpenId = mention?.id?.open_id || mention?.id?.openId || mention?.open_id;
    if (botOpenId && mentionedOpenId === botOpenId) return true;
    return !botOpenId && botName && String(mention?.name || '').trim() === botName;
  });
}

function stalePokerCardResponse(table, openId) {
  const current = table?.currentActionData();
  if (!current) return { toast: { type: 'warning', content: '牌桌已经更新，请使用最新卡片。' } };
  if (current.openId !== openId) return { toast: { type: 'warning', content: `牌桌已更新，现在轮到 ${current.name}。` } };
  return { card: { type: 'raw', data: createTableCard(table.currentTableCardData()) } };
}

function createBot(environment = process.env) {
  const appId = environment.FEISHU_APP_ID;
  const appSecret = environment.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET；请复制 .env.example 为 .env 后填写。');
  }
  const client = new lark.Client({ appId, appSecret });
  const wsClient = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
  const manager = new TableManager({
    startingStack: environment.STARTING_STACK,
    smallBlind: environment.SMALL_BLIND,
    bigBlind: environment.BIG_BLIND,
    turnTimeoutMs: environment.TURN_TIMEOUT_MS,
    turnWarningMs: environment.TURN_WARNING_MS,
    allowSoloGame: environment.ALLOW_SOLO_GAME,
    turnCardMode: environment.TURN_CARD_MODE,
    statsFile: environment.STATS_FILE || path.join(__dirname, 'data', 'stats.json'),
    tablesFile: environment.TABLES_FILE || path.join(__dirname, 'data', 'tables.json'),
    undercoverSpeakTimeoutMs: environment.UNDERCOVER_SPEAK_TIMEOUT_MS || 60000,
  });
  const transport = createFeishuTransport(client);
  const dailyTitleScheduler = new DailyTitleScheduler({
    statsStore: manager.stats,
    targetChatId: environment.DAILY_TITLE_CHAT_ID || '',
    onPublish: (event) => transport.deliver([event]),
  });
  const memberNameCache = new Map();
  const memberLookupDisabledChats = new Set();
  let botIdentity = {
    openId: String(environment.FEISHU_BOT_OPEN_ID || '').trim(),
    name: String(environment.FEISHU_BOT_NAME || '运营助手').trim(),
  };
  let botIdentityPromise = null;
  const deduper = new RecentMessageDeduper();
  const chatQueue = new ChatQueue();
  manager.setEventSink((events) => transport.deliver(events));
  const bailoutDelayMs = Math.max(1000, Number(environment.BAILOUT_DELAY_MS) || 10000);
  const bailoutScheduler = new BailoutScheduler({
    delayMs: bailoutDelayMs,
    onCommit: (pending) => chatQueue.enqueue(pending.chatId, async () => {
      const events = manager.dispatch({
        chatId: pending.chatId,
        user: { openId: pending.openId, name: pending.name },
        command: pending.command,
      });
      await transport.deliver(events);
    }),
    onError: async (error, pending) => {
      console.error('延迟发放补充筹码失败：', error);
      try { await transport.sendGroup(pending.chatId, `❌ ${error.message || '补充筹码发放失败'}`); } catch (sendError) { console.error(sendError); }
    },
  });

  async function resolveMemberName(chatId, openId, suggestedName = null) {
    const cacheKey = `${chatId}:${openId}`;
    // Card callbacks carry the name Feishu is currently showing in this chat.
    // Prefer it over the tenant-wide account name returned by chatMembers.get.
    if (suggestedName) {
      memberNameCache.set(cacheKey, suggestedName);
      return suggestedName;
    }
    if (memberNameCache.has(cacheKey)) return memberNameCache.get(cacheKey);
    if (memberLookupDisabledChats.has(chatId)) return suggestedName || null;
    try {
      let pageToken;
      do {
        const response = await client.im.v1.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        });
        const items = response?.data?.items || [];
        for (const member of items) {
          if (member.member_id && member.name) memberNameCache.set(`${chatId}:${member.member_id}`, member.name);
        }
        pageToken = response?.data?.has_more ? response.data.page_token : null;
      } while (pageToken && !memberNameCache.has(cacheKey));
    } catch (error) {
      memberLookupDisabledChats.add(chatId);
      console.warn(`获取群成员昵称失败（${openId}），暂用牌桌昵称：`, error.message || error);
    }
    return memberNameCache.get(cacheKey) || suggestedName || null;
  }

  async function ensureBotIdentity() {
    if (botIdentity.openId) return botIdentity;
    if (!botIdentityPromise) {
      botIdentityPromise = client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
        .then((response) => {
          const bot = response?.bot || response?.data?.bot || {};
          botIdentity = {
            openId: bot.open_id || botIdentity.openId,
            name: bot.app_name || bot.name || botIdentity.name,
          };
          return botIdentity;
        })
        .catch((error) => {
          console.warn('获取机器人身份失败，将按机器人名称识别艾特：', error.message || error);
          return botIdentity;
        });
    }
    return botIdentityPromise;
  }

  async function handleMessage(data) {
    const message = data.message;
    const sender = data.sender;
    if (!message || !sender || !message.content) return;
    if (sender.sender_type === 'app') return; // Ignore bot echoes and app-originated messages.
    const chatType = message.chat_type || 'group';
    if (!['group', 'p2p'].includes(chatType)) return;
    if (message.message_type && message.message_type !== 'text') return;
    const incomingChatId = message.chat_id;
    const openId = sender.sender_id && sender.sender_id.open_id;
    if (!incomingChatId || !openId || deduper.seen(message.message_id)) return;

    const text = eventText(message);
    if (chatType === 'p2p') {
      const privateSpeech = manager.games.parsePrivateSpeech(openId, text);
      if (!privateSpeech) return;
      console.log(`收到谁是卧底匿名描述：group=${privateSpeech.chatId} user=${openId}`);
      await chatQueue.enqueue(privateSpeech.chatId, async () => {
        try {
          const events = manager.dispatch({
            chatId: privateSpeech.chatId,
            user: { openId, name: privateSpeech.player.name },
            command: privateSpeech.command,
          });
          await transport.deliver(events);
          await transport.sendPrivate(openId, '✅ 已由机器人匿名代发到群里。');
        } catch (error) {
          console.error('处理匿名描述失败：', error);
          await transport.sendPrivate(openId, `❌ ${error.message || '匿名描述发送失败，请重试'}`);
        }
      });
      return;
    }
    const chatId = incomingChatId;
    if (!text) {
      const identity = await ensureBotIdentity();
      if (!messageMentionsBot(message, identity)) return;
    }
    console.log(`收到群消息 [${chatId}]：${text}`);
    await chatQueue.enqueue(chatId, async () => {
      try {
        const memberName = await resolveMemberName(chatId, openId);
        // Parse inside the per-chat queue. A card click may arm the next
        // Undercover message immediately before this event arrives.
        const command = text
          ? (manager.games.parseText(chatId, text, openId) || parseCommand(text))
          : { type: 'INTERFACE' };
        if (!command) return;
        if (command.type === 'BAILOUT') {
          const table = manager.get(chatId);
          if (!table) throw new Error('当前没有牌桌，请先发送“开桌”');
          table.canReceiveBailout(openId);
          bailoutScheduler.schedule({ messageId: message.message_id, chatId, openId, name: memberName, command });
          await transport.sendGroup(chatId, `⏳ <at user_id="${openId}">玩家</at> 补充口令已登记，${Math.ceil(bailoutDelayMs / 1000)} 秒后到账；期间撤回消息将自动取消。`);
          return;
        }
        const events = manager.dispatch({ chatId, user: { openId, name: memberName }, command });
        if (command.type === 'DISBAND') bailoutScheduler.cancelChat(chatId);
        await transport.deliver(events);
      } catch (error) {
        console.error('处理游戏命令失败：', error);
        await transport.sendGroup(chatId, `❌ ${error.message || '命令处理失败，请稍后重试'}`);
      }
    });
  }

  async function handleMessageRecalled(data) {
    const messageId = data?.message_id || data?.event?.message_id;
    if (!messageId) return;
    const pending = bailoutScheduler.cancel(messageId);
    if (!pending) return;
    await chatQueue.enqueue(pending.chatId, () => transport.sendGroup(
      pending.chatId,
      `🚫 <at user_id="${pending.openId}">玩家</at> 撤回了补充口令，本次筹码已取消。`,
    ));
  }

  async function handleCardAction(data) {
    const value = data && data.action && data.action.value;
    const normalized = typeof lark.normalizeCardAction === 'function'
      ? lark.normalizeCardAction(data)
      : null;
    const sourceChatId = (normalized && normalized.chatId)
      || (data.context && data.context.open_chat_id)
      || data.open_chat_id;
    // Private action cards carry their originating group in the button value.
    const chatId = (value && value.chatId) || sourceChatId;
    const openId = (normalized && normalized.operator && normalized.operator.openId)
      || (data.operator && data.operator.open_id)
      || data.open_id;
    const action = {
      ...(normalized ? normalized.action : data.action),
      name: normalized?.action?.name || data?.action?.name || '',
      formValue: data?.action?.form_value || data?.action?.formValue || normalized?.action?.formValue || {},
    };
    const command = cardActionToCommand(action);
    if (!chatId || !openId || !command) {
      return { toast: { type: 'warning', content: '无法识别这次操作，请使用文字指令。' } };
    }
    const table = manager.get(chatId);
    if (!table && !['OPEN', 'SELECT_GAME', 'GAME_ACTION', 'SHOW_GAME_WORD'].includes(command.type)) return { toast: { type: 'warning', content: '牌桌已经不存在。' } };
    if (table && command.type === 'DISBAND' && (!value?.roomId || String(value.roomId) !== String(table.roomId) || String(value.turnVersion) !== String(table.turnVersion))) {
      return { toast: { type: 'warning', content: '这是旧牌桌卡片，不能用来解散当前牌桌。' } };
    }
    const turnSensitiveActions = new Set(['CHECK', 'CALL', 'RAISE_TO', 'ALL_IN', 'FOLD']);
    if (table && value && turnSensitiveActions.has(command.type) && String(table.turnVersion) !== String(value.turnVersion)) {
      return stalePokerCardResponse(table, openId);
    }
    if (command.type === 'SHOW_GAME_WORD') {
      try {
        return createExclusiveWordResponse(manager.games.wordData(chatId, openId));
      } catch (error) {
        return { toast: { type: 'warning', content: error.message || '无法查看词语' } };
      }
    }
    if (command.type === 'GAME_ACTION' && command.action === 'ARM_SPEECH') {
      try {
        const response = createExclusiveSpeechResponse(manager.games.speechData(chatId, openId));
        manager.syncGameTimer(chatId);
        return response;
      } catch (error) {
        return { toast: { type: 'warning', content: error.message || '暂时不能匿名描述' } };
      }
    }

    const dedupeVersion = command.type === 'GAME_ACTION' && command.action === 'ARM_SPEECH'
      ? manager.games.get(chatId)?.turnVersion
      : value && value.turnVersion;
    const actionKey = `card:${chatId}:${openId}:${action.name || ''}:${value && value.action}:${value && value.game}:${value && value.targetOpenId}:${value && value.answer}:${dedupeVersion ?? manager.games.get(chatId)?.turnVersion}:${JSON.stringify(action.formValue)}`;
    if (deduper.seen(actionKey)) return { toast: { type: 'success', content: '已收到，请查看群里的最新卡片。' } };

    if (command.type === 'SHOW_HOLE') {
      try {
        const holeData = table.holeCardData(openId, value && value.handNumber, value && value.turnVersion);
        console.log(`独享底牌已返回：chat=${chatId} user=${openId} hand=${holeData.handNumber}`);
        return createExclusiveHoleResponse(holeData);
      } catch (error) {
        console.error('查看独享底牌失败：', error);
        return { toast: { type: 'warning', content: error.message || '无法查看底牌' } };
      }
    }

    if (command.type === 'SHOW_BAILOUT') {
      try {
        const bailoutData = table.bailoutCardData(openId, value && value.handNumber);
        return createExclusiveBailoutResponse(bailoutData);
      } catch (error) {
        return { toast: { type: 'warning', content: error.message || '无法查看补充规则' } };
      }
    }

    return chatQueue.enqueue(chatId, async () => {
      try {
        const operatorName = await resolveMemberName(chatId, openId, normalized && normalized.operator.name);
        if (command.type === 'GAME_ACTION' && command.action === 'SPEAK' && !String(command.text || '').trim()) {
          throw new Error('描述内容不能为空');
        }
        const events = manager.dispatch({ chatId, user: { openId, name: operatorName }, command });
        if (command.type === 'DISBAND') bailoutScheduler.cancelChat(chatId);
        await transport.deliver(events);
        return { toast: { type: 'success', content: command.type === 'GAME_ACTION' && command.action === 'ARM_SPEECH' ? '已私信提醒，请在机器人私聊中回复描述。' : '操作成功' } };
      } catch (error) {
        console.error('处理卡片操作失败：', error);
        return { toast: { type: 'warning', content: error.message || '操作失败，请重试' } };
      }
    });
  }

  // This object-registration form is verified against @larksuiteoapi/node-sdk 1.73.0.
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': handleMessage,
    'im.message.recalled_v1': handleMessageRecalled,
    'card.action.trigger': handleCardAction,
  });
  return {
    manager,
    start() { wsClient.start({ eventDispatcher }); dailyTitleScheduler.start(); },
    stop() { dailyTitleScheduler.stop(); bailoutScheduler.shutdown(); manager.shutdown(); },
  };
}

if (require.main === module) {
  const bot = createBot();
  bot.start();
  console.log('🃏 飞书德州扑克机器人启动成功（文字命令版）');
  const shutdown = () => { bot.stop(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { createBot, eventText, messageMentionsBot, stalePokerCardResponse };
