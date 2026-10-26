'use strict';

const {
  createTableCard, createLobbyCard, createHomeCard, createStartCard, createResultCard, createChipsCard, createStatsCard, createDailyTitleCard, createBailoutCard, createBailoutNoticeCard, createRulesCard, createExclusiveHoleCard,
} = require('./card-ui');
const { createGameCard } = require('./game-ui');

function createFeishuTransport(client) {
  async function send(receiveIdType, receiveId, text) {
    return client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  async function createCard(receiveIdType, receiveId, card) {
    return client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  }

  async function sendTableCard(event) {
  const builders = {
    home_card: createHomeCard,
    game_notice_card: (event) => ({
      config: { wide_screen_mode: true, enable_forward: false },
      header: { template: 'wathet', title: { tag: 'plain_text', content: `🎮 ${event.title}` } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**${event.title}**\n这个游戏入口已经加入大厅，规则和房间逻辑正在单独开发。` } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '当前德州扑克可以直接开始；@机器人可重新打开游戏大厅。' }] },
      ],
    }),
    game_card: createGameCard,
      lobby_card: createLobbyCard,
      table_card: createTableCard,
      start_card: createStartCard,
      result_card: createResultCard,
      chips_card: createChipsCard,
      stats_card: createStatsCard,
      daily_title_card: createDailyTitleCard,
      bailout_card: createBailoutCard,
      bailout_notice_card: createBailoutNoticeCard,
      rules_card: createRulesCard,
    };
    const card = builders[event.type](event);
    // Every turn must appear at the bottom of the chat. Patching an earlier
    // street card makes the new controls look as if they were never sent.
    await createCard('chat_id', event.chatId, card);
  }

  return {
    sendGroup(chatId, text) { return send('chat_id', chatId, text); },
    sendPrivate(openId, text) { return send('open_id', openId, text); },
    async deliver(events) {
      for (const event of events) {
        try {
          if (event.type === 'group') await send('chat_id', event.chatId, event.text);
          else if (event.type === 'private') await send('open_id', event.openId, event.text);
          else if (event.type === 'private_turn_card') {
            try { await createCard('open_id', event.openId, createExclusiveHoleCard(event)); }
            catch (error) {
              console.error(`发送私聊行动卡失败（${event.openId}），已降级为文字消息：`, error.message || error);
              await send('open_id', event.openId, event.fallbackText);
            }
          }
          else if (['table_card', 'lobby_card', 'home_card', 'game_notice_card', 'game_card', 'start_card', 'result_card', 'chips_card', 'stats_card', 'daily_title_card', 'bailout_card', 'bailout_notice_card', 'rules_card'].includes(event.type)) {
            try { await sendTableCard(event); }
            catch (error) {
              console.error('发送牌桌卡片失败，已降级为文字消息：', error);
              await send('chat_id', event.chatId, event.fallbackText);
            }
          }
        } catch (error) {
          if (!['private', 'private_turn_card'].includes(event.type)) throw error;
          console.error(`私聊消息发送失败（${event.openId}），继续发送群牌桌：`, error.message || error);
        }
      }
    },
  };
}

module.exports = { createFeishuTransport };
