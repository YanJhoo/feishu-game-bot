'use strict';

const {
  createTableCard, createLobbyCard, createHomeCard, createStartCard, createResultCard, createChipsCard, createStatsCard, createDailyTitleCard, createBailoutCard, createBailoutNoticeCard, createRulesCard, createExclusiveHoleCard,
} = require('./card-ui');
const { createGameCard } = require('./game-ui');

// Feishu answers HTTP 400 + code 99991400 (or HTTP 429) when the app sends
// messages too fast. Such requests are safe to retry after a short wait.
const RATE_LIMIT_CODE = 99991400;

function isRateLimited(errorOrResponse) {
  const status = errorOrResponse?.response?.status;
  const code = errorOrResponse?.response?.data?.code ?? errorOrResponse?.code;
  return status === 429 || code === RATE_LIMIT_CODE;
}

function retryDelayMs(error, attempt) {
  const reset = Number(error?.response?.headers?.['x-ogw-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1000, 5000);
  return 500 * 2 ** attempt;
}

async function withRateLimitRetry(request, { retries = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await request();
      // Some API errors arrive as a normal response with a non-zero code.
      if (isRateLimited(response)) {
        const error = new Error(response.msg || '飞书接口限流');
        error.code = RATE_LIMIT_CODE;
        throw error;
      }
      return response;
    } catch (error) {
      if (!isRateLimited(error) || attempt >= retries) throw error;
      await sleep(retryDelayMs(error, attempt));
    }
  }
}

const CARD_BUILDERS = Object.freeze({
  home_card: createHomeCard,
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
});

function createFeishuTransport(client, retryOptions = {}) {
  function createMessage(receiveIdType, receiveId, msgType, content) {
    return withRateLimitRetry(() => client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) },
    }), retryOptions);
  }

  async function send(receiveIdType, receiveId, text) {
    return createMessage(receiveIdType, receiveId, 'text', { text });
  }

  async function createCard(receiveIdType, receiveId, card) {
    return createMessage(receiveIdType, receiveId, 'interactive', card);
  }

  async function sendTableCard(event) {
    const card = CARD_BUILDERS[event.type](event);
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
          else if (Object.hasOwn(CARD_BUILDERS, event.type)) {
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

module.exports = { createFeishuTransport, withRateLimitRetry, isRateLimited };
