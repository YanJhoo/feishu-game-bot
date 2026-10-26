'use strict';

const { formatCardsVisual } = require('./cards');

function plain(content) { return { tag: 'plain_text', content }; }
function button(content, action, event, type = 'default', extra = {}) {
  return {
    tag: 'button',
    text: plain(content),
    type,
    value: {
      action,
      chatId: event.chatId,
      roomId: event.roomId || '',
      turnVersion: String(event.turnVersion),
      ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)])),
    },
  };
}

function mention(player) { return `<at id=${player.openId}></at>`; }

function displayName(player) {
  return String(player.name || '玩家')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

function playerLine(player) {
  const flags = [];
  if (player.folded) flags.push('已弃牌');
  else if (player.allIn) flags.push('All-in');
  if (player.stack === 0 && !player.allIn) flags.push('已破产');
  if (player.sittingOut) flags.push('暂停');
  const delta = Number(player.delta) || 0;
  return `**${displayName(player)}** ${player.stack}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}${flags.length ? ` _${flags.join('/')}_` : ''}`;
}

function pairedLines(lines) {
  const output = [];
  for (let index = 0; index < lines.length; index += 2) output.push(lines.slice(index, index + 2).join('　　'));
  return output.join('\n');
}

function decisionButtons(action, event) {
  const primary = action.toCall > 0
    ? button(`跟注 ${action.toCall}`, 'CALL', event, 'primary')
    : button('过牌', 'CHECK', event, 'primary');
  return [
    primary,
    button(`加注到 ${action.minimumTarget}`, 'RAISE_TO', event, 'default', { amount: action.minimumTarget }),
  ];
}

function riskButtons(event) {
  return [
    {
      ...button('All-in', 'ALL_IN', event),
      confirm: { title: plain('确认 All-in'), text: plain('确定要投入全部剩余筹码吗？') },
    },
    {
      ...button('弃牌', 'FOLD', event, 'danger'),
      confirm: { title: plain('确认弃牌'), text: plain('弃牌后本局不能继续参与，确定吗？') },
    },
  ];
}

function bettingButtons(action, event) { return [...decisionButtons(action, event), ...riskButtons(event)]; }

function raisePresetButtons(action, event) {
  return (action.raisePresets || []).map((preset) => button(`${preset.label} ${preset.amount}`, 'RAISE_TO', event, 'default', { amount: preset.amount }));
}

function createTableCard(event) {
  const board = formatCardsVisual(event.board);
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**公共牌**　${board}\n**底池 ${event.pot}**　当前下注 ${event.currentBet}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**筹码**\n${pairedLines(event.players.map(playerLine))}`,
      },
    },
  ];

  if (event.action) {
    const action = event.action;
    elements.push(
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**轮到** <at id=${action.openId}></at>　${action.toCall > 0 ? `跟注 **${action.toCall}**` : '可过牌'}　余 **${action.stack}**${event.timeoutSeconds ? `　⏱ ${event.timeoutSeconds} 秒` : ''}`,
        },
      },
    );
    elements.push({
      tag: 'action',
      layout: 'flow',
      actions: [
        button('查看我的底牌', 'SHOW_HOLE', event, 'primary', { handNumber: event.handNumber }),
        ...decisionButtons(action, event),
      ],
    });
    const presets = raisePresetButtons(action, event);
    elements.push({
      tag: 'action',
      layout: 'flow',
      actions: [...presets, ...riskButtons(event)],
    });
    const odds = action.toCall > 0 ? `跟后底池 ${action.potAfterCall}｜底池赔率 ${action.potOdds}%；` : '';
    elements.push({ tag: 'note', elements: [plain(`${odds}其他加注：加注 数字金额（最低 ${action.minimumTarget}）`)] });
  } else if (event.finished) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'action',
        layout: 'flow',
        actions: [button('开始下一局', 'NEXT_HAND', event, 'primary'), button('离开牌桌', 'LEAVE', event)],
      },
      { tag: 'note', elements: [plain('不会自动开局；任意已入座玩家点击后立即开始下一局。筹码低于 1000 的玩家请先按补充提醒操作。')] },
    );
  }

  if (event.actionLog?.length) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**最近行动**　${event.actionLog.map((line) => `• ${line}`).join('　')}` } });
  }

  return {
    config: { wide_screen_mode: true, update_multi: false, enable_forward: false },
    header: {
      template: event.finished ? 'green' : event.action ? 'blue' : 'wathet',
      title: plain(`🃏 第 ${event.handNumber} 局｜${event.title}`),
    },
    elements,
  };
}

function createExclusiveHoleCard(data) {
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `🔒 **仅你可见的底牌**\n${formatCardsVisual(data.player.cards)}\n\n阶段：**${data.phase}**　剩余筹码：**${data.player.stack}**` } },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: `**公共牌**\n${formatCardsVisual(data.board)}\n\n**底池：${data.pot}**　当前下注：${data.currentBet}` } },
  ];
  if (data.player.folded) {
    elements.push({ tag: 'note', elements: [plain('你已经弃牌，本局不能继续行动。')] });
  } else if (data.action) {
    elements.push(
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**现在轮到你行动**\n${data.action.toCall > 0 ? `需要跟注：**${data.action.toCall}**` : '当前可以过牌'}` } },
      { tag: 'action', layout: 'flow', actions: decisionButtons(data.action, data) },
      { tag: 'action', layout: 'flow', actions: [...raisePresetButtons(data.action, data), ...riskButtons(data)] },
      ...(data.action.toCall > 0 ? [{ tag: 'note', elements: [plain(`跟注后底池 ${data.action.potAfterCall}｜底池赔率约 ${data.action.potOdds}%`)] }] : []),
      { tag: 'note', elements: [plain(`其他加注金额可在群里发送“加注数字金额”；最低加注到 ${data.action.minimumTarget}。`)] },
    );
  } else {
    elements.push({ tag: 'note', elements: [plain('还没有轮到你；请等待群里的最新行动提示。')] });
  }
  return {
    config: { wide_screen_mode: true, update_multi: false, enable_forward: false },
    header: { template: data.action ? 'blue' : 'purple', title: plain(`🂠 第 ${data.handNumber} 局 · 我的底牌`) },
    elements,
  };
}

function createExclusiveHoleResponse(data) {
  return {
    card: {
      type: 'raw',
      data: createExclusiveHoleCard(data),
    },
  };
}

function createLobbyCard(event) {
  const playerText = event.players.length
    ? event.players.map((player) => `• ${mention(player)}　筹码 **${player.stack}**`).join('\n')
    : '暂时没有玩家，点击下方按钮加入。';
  return {
    config: { wide_screen_mode: true, update_multi: true, enable_forward: false },
    header: { template: 'turquoise', title: plain(`🃏 ${event.title}`) },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `房间：**${event.roomId}**　盲注：**${event.smallBlind}/${event.bigBlind}**\n初始筹码：**${event.startingStack}**　人数：**${event.players.length}/9**`,
        },
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**已入座玩家**\n${playerText}` } },
      { tag: 'hr' },
      {
        tag: 'action',
        layout: 'flow',
        actions: [
          button('加入牌桌', 'JOIN', event, 'primary'),
          button('开始游戏', 'START', event, 'default'),
          button('暂停/恢复', 'TOGGLE_SIT_OUT', event, 'default'),
          button('离开牌桌', 'LEAVE', event, 'default'),
          {
            ...button('解散牌桌', 'DISBAND', event, 'danger'),
            confirm: { title: plain('确认解散'), text: plain('所有人都可以解散牌桌，确定继续吗？') },
          },
        ],
      },
      { tag: 'note', elements: [plain('至少 2 人即可开始；所有人权限相同，都可以开始或解散牌桌。')] },
    ],
  };
}

function createStartCard(event) {
  const positions = event.solo
    ? `🎲 **随机庄家 / 单人测试**　${mention(event.dealer)}\n**测试盲注**　${event.bigBlindAmount}`
    : `🎲 **随机庄家**　${mention(event.dealer)}\n**小盲**　${mention(event.smallBlind)}　${event.smallBlindAmount}\n**大盲**　${mention(event.bigBlind)}　${event.bigBlindAmount}`;
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'purple', title: plain(`🎮 第 ${event.handNumber} 局开始`) },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: positions } },
      { tag: 'note', elements: [plain(event.turnCardMode === 'group' ? '每局开始私聊一次底牌；后续行动全部在群卡完成。' : '底牌和行动卡会自动私聊，也可使用群里的最新牌桌卡片。')] },
    ],
  };
}

function createResultCard(event) {
  const board = formatCardsVisual(event.board);
  const results = event.players
    .filter((player) => player.played)
    .map((player) => {
      const amount = player.payout - player.contributed;
      const icon = amount > 0 ? '👑 ' : amount < 0 ? '💀 ' : '➖ ';
      return `${icon}**${displayName(player)}**　${formatCardsVisual(player.cards)}　${player.handName}　**${amount >= 0 ? '+' : ''}${amount}**`;
    });
  const stacks = event.players
    .map((player) => `**${displayName(player)}**　**${player.stack}**${player.canBailout ? '　🆘 **可补充**' : ''}`);
  const pots = (event.potSummaries || []).map((pot) => `**${pot.label} ${pot.amount}** → ${pot.winners.map(displayName).join('、')}（${pot.handName}）`).join('\n');
  const canBailout = event.players.some((player) => player.canBailout);
  const resultActions = [button('开始下一局', 'NEXT_HAND', event, 'primary')];
  if (canBailout) resultActions.push(button('补充筹码', 'SHOW_BAILOUT', event, 'default', { handNumber: event.handNumber }));
  resultActions.push(button('离开牌桌', 'LEAVE', event));
  resultActions.push(button('暂停/恢复', 'TOGGLE_SIT_OUT', event));
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**公共牌**　${board}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**玩家结果**\n${results.length ? results.join('\n') : '暂无结算玩家'}` } },
    ...(pots ? [{ tag: 'div', text: { tag: 'lark_md', content: `**底池归属**\n${pots}` } }] : []),
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: `**当前筹码**\n${stacks.length ? pairedLines(stacks) : '暂无玩家'}` } },
    { tag: 'action', layout: 'flow', actions: resultActions },
  ];
  if (canBailout) {
    elements.push({ tag: 'note', elements: [plain('仅符合条件的玩家可以打开；规则会以仅本人可见的方式显示。')] });
  }
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'green', title: plain('🏁 本局结算') },
    elements,
  };
}

function createChipsCard(event) {
  const lines = event.players.map((player) => `**${displayName(player)}**　**${player.stack}**${player.seated === false ? '　_已离桌_' : player.allIn ? '　_All-in_' : player.folded && player.inHand ? '　_已弃牌_' : ''}`);
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'yellow', title: plain('💰 当前筹码（长期保留）') },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') || '当前还没有筹码记录' } },
      { tag: 'note', elements: [plain('离开牌桌、解散房间或机器人重启都不会清空筹码；重新加入会恢复原余额。')] },
    ],
  };
}

function createStatsCard(event) {
  const lines = event.stats.map((stats, index) => `${index + 1}. ${mention(stats)}　${stats.hands} 局 / ${stats.wins} 胜　净胜负 **${stats.totalNet >= 0 ? '+' : ''}${stats.totalNet}**　最高单局 +${stats.biggestWin}`);
  const shame = event.stats
    .filter((stats) => Number(stats.bailoutCount) > 0)
    .sort((a, b) => b.bailoutCount - a.bailoutCount || b.bailoutTotal - a.bailoutTotal)
    .map((stats, index) => {
      const phrases = Object.entries(stats.bailoutPhrases || {})
        .sort((a, b) => b[1] - a[1])
        .map(([phrase, count]) => `×${count}「${phrase}」`)
        .join('\n　');
      return `${index + 1}. ${mention(stats)}　补充 **${stats.bailoutCount} 次**，累计领取 **${stats.bailoutTotal}**\n　${phrases}`;
    });
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'indigo', title: plain('📊 永久战绩') },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**🏆 战绩榜**' } },
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') || '暂无战绩' } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**🙈 补充筹码耻辱榜**' } },
      { tag: 'div', text: { tag: 'lark_md', content: shame.join('\n\n') || '暂时无人上榜' } },
      { tag: 'note', elements: [plain('战绩会保存到本地文件，机器人重启后仍会保留。')] },
    ],
  };
}

function createDailyTitleCard(event) {
  const lines = event.titles.map((item) => `${item.icon} **${item.title}**　${displayName(item.player)}\n　${item.detail}`).join('\n\n');
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: { template: 'carmine', title: plain(`🏅 ${event.dateKey} 每日牌桌称号`) },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines } },
      { tag: 'note', elements: [plain('仅统计本群昨日已结算牌局；每天上午 9:00 发布。')] },
    ],
  };
}

function createBailoutCard(event) {
  const players = event.players.map((player) => `• ${mention(player)}　当前 **${player.stack}**`).join('\n');
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'orange', title: plain('🆘 低筹码玩家补充筹码') },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**以下玩家可以补充**\n${players}\n\n当前筹码王：**${event.highestStack}**` } },
      { tag: 'action', layout: 'flow', actions: [button('查看我的补充档位', 'SHOW_BAILOUT', event, 'primary', { handNumber: event.handNumber })] },
      { tag: 'note', elements: [plain('仅上方符合条件的玩家点击有效；补充规则和六档选择会以仅本人可见的卡片显示。')] },
    ],
  };
}

function createBailoutNoticeCard(event) {
  return {
    config: { wide_screen_mode: true, update_multi: false, enable_forward: false },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `🆘 ${mention(event.player)} 可补充筹码` } },
      { tag: 'action', layout: 'bisected', actions: [button('查看补充规则', 'SHOW_BAILOUT', event, 'primary', { handNumber: event.handNumber })] },
    ],
  };
}

function createExclusiveBailoutCard(data) {
  const choiceButtons = data.options.map((option) => button(
    `${option.level}级 最多+${option.amount}`,
    'BAILOUT_AUTO',
    data,
    option.level >= 5 ? 'danger' : option.level >= 3 ? 'primary' : 'default',
    { level: option.level, handNumber: data.handNumber },
  ));
  for (let index = 0; index < choiceButtons.length; index += 1) {
    choiceButtons[index].confirm = {
      title: plain(`确认选择 ${data.options[index].level} 级补充`),
      text: plain(`将公开发送：${data.options[index].phrase}`),
    };
  }
  return {
    config: { wide_screen_mode: true, update_multi: false, enable_forward: false },
    header: { template: 'orange', title: plain('🔒 仅你可见 · 补充规则') },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `你当前有 **${data.player.stack}** 筹码，筹码王为 **${data.highestStack}**。\n选择档位并确认后立即补充；确认框会显示将公开发送的完整语录。` } },
      { tag: 'action', layout: 'flow', actions: choiceButtons },
      { tag: 'note', elements: [plain('每局最多补充一次；最终不超过 1000，并为筹码王保留至少 200 筹码优势。')] },
    ],
  };
}

function createExclusiveBailoutResponse(data) {
  return { card: { type: 'raw', data: createExclusiveBailoutCard(data) } };
}

function createRulesCard() {
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: { template: 'blue', title: plain('📖 德州扑克新手规则') },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**目标**\n每人有 2 张只有自己能看到的底牌，桌面最多发出 5 张公共牌。用这 7 张牌任选五张，组成最大的牌型；也可以通过下注让其他玩家全部弃牌。' } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**一局的流程**\n1. **翻牌前 Preflop**：每人收到两张底牌，小盲和大盲先放入强制盲注。\n2. **翻牌 Flop**：发出 3 张公共牌。\n3. **转牌 Turn**：再发 1 张公共牌。\n4. **河牌 River**：最后发 1 张公共牌。\n5. **摊牌 Showdown**：仍未弃牌的玩家比较最佳五张牌。\n每个阶段都会依次行动；一轮下注全部跟齐后才进入下一阶段。' } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**轮到你时可以做什么**\n• **过牌**：当前不需要跟注时，不下注并把行动交给下一位。\n• **跟注**：补齐到当前最高下注。\n• **加注**：提高本轮总下注额，不能低于卡片显示的最小加注。\n• **All-in**：投入自己的全部剩余筹码。\n• **弃牌**：放弃本局，已经投入的筹码不会退回。' } },
      { tag: 'note', elements: [plain('加注数字表示“本轮总下注额”，不是额外增加。例如当前下注10，发送“加注20”表示把自己的本轮下注提高到20。空格可加可不加。')] },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**牌型大小（从强到弱）**\n1. 皇家同花顺 / 同花顺\n2. 四条\n3. 葫芦（三条 + 一对）\n4. 同花\n5. 顺子\n6. 三条\n7. 两对\n8. 一对\n9. 高牌\n牌型相同时依次比较组成牌型的点数和踢脚；完全相同则平分底池。A 通常最大，也能在 A-2-3-4-5 顺子中当作 1。' } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**新手建议**\n• 底牌差时尽早弃牌，不必每一局都跟。\n• 加注前先看清“需要跟注”和“最小加注”。\n• 公共牌属于所有玩家，不只属于自己。\n• 牌桌卡片只对当前行动玩家的按钮操作生效。' } },
    ],
  };
}

function createHomeCard(event) {
  const pokerAction = event.pokerAction || 'OPEN';
  const pokerLabel = '德州扑克';
  return {
    config: { wide_screen_mode: true, update_multi: true, enable_forward: false },
    header: { template: 'blue', title: plain('🏆 顶尖运营') },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**欢迎来到运营大厅**\n请选择要学的运营技能。' } },
      {
        tag: 'action',
        layout: 'bisected',
        actions: [
          button(pokerLabel, pokerAction, event, 'default', { game: 'poker' }),
          button('谁是卧底', 'SELECT_GAME', event, 'default', { game: 'undercover' }),
        ],
      },
      { tag: 'note', elements: [plain('三种群活动都可以从卡片进入；机器人会在对应房间内提示下一步。')] },
    ],
  };
}

module.exports = { createTableCard, createLobbyCard, createHomeCard, createStartCard, createResultCard, createChipsCard, createStatsCard, createDailyTitleCard, createBailoutCard, createBailoutNoticeCard, createExclusiveBailoutCard, createExclusiveBailoutResponse, createRulesCard, createExclusiveHoleCard, createExclusiveHoleResponse };

