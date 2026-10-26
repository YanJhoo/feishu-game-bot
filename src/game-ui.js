'use strict';

function plain(content) { return { tag: 'plain_text', content: String(content) }; }
function button(label, action, event, extra = {}, type = 'default') {
  return { tag: 'button', text: plain(label), type, value: { action, chatId: event.chatId, game: event.game, turnVersion: String(event.turnVersion ?? ''), ...extra } };
}
function mention(player) { return `<at id=${player.openId}></at>`; }
function displayName(player) {
  return String(player?.name || '玩家')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

function createGameCard(event) {
  const elements = [];
  if (event.scoreOnly) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: event.scores?.length
      ? event.scores.map((item, index) => `**${index + 1}. ${displayName(item)}**　${item.points} 分　${item.wins}/${item.games} 胜`).join('\n')
      : '当前还没有已结算的比分。' } });
    return { config: { wide_screen_mode: true, update_multi: false, enable_forward: false }, header: { template: 'indigo', title: plain('🏆 谁是卧底比分') }, elements };
  }
  if (event.game === 'undercover' && event.phase === 'finished' && event.result) {
    elements.push(
      { tag: 'div', text: { tag: 'lark_md', content: `${event.result.winner === '平民' ? '🧑‍🤝‍🧑' : '🕵️'} **${event.result.winner}获胜**　卧底：**${event.result.undercovers.map((name) => displayName({ name })).join('、')}**` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**词语**　平民「${event.result.civilianWord}」｜卧底「${event.result.undercoverWord}」` } },
    );
    if (event.result.reveals?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**身份揭晓**\n${event.result.reveals.map((item) => `• ${displayName({ name: item.anonymousName })} → ${displayName(item)}${item.isUndercover ? '　🕵️卧底' : '　平民'}`).join('\n')}` } });
    if (event.descriptions?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**本轮描述**\n${event.descriptions.map((item) => `${displayName(item)}：${item.text}`).join('\n')}` } });
    if (event.voteSummary?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**票数**　${event.voteSummary.map((item) => `${displayName(item)} ${item.votes}`).join('　｜　')}` } });
    if (event.actions?.length) elements.push({ tag: 'action', layout: 'flow', actions: event.actions.map((item) => button(item.label, item.action, event, item.extra || {}, item.type || 'default')) });
    elements.push({ tag: 'note', elements: [plain(`房间内 ${event.players?.length || 0} 人；任意房间成员都可以再开一局。`)] });
    return { config: { wide_screen_mode: true, update_multi: false, enable_forward: false }, header: { template: event.template || 'green', title: plain(event.title || '谁是卧底结算') }, elements };
  }
  if (event.body) elements.push({ tag: 'div', text: { tag: 'lark_md', content: event.body } });
  if (event.phase === 'lobby') {
    elements.push(
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**已加入玩家（${event.players?.length || 0}/${event.playerLimit || 12}）**\n${event.players?.length ? event.players.map((player) => `• ${mention(player)}`).join('\n') : '暂时没有玩家，点击下方按钮加入。'}` } },
    );
  }
  if (event.phase !== 'lobby' && event.descriptions) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**本轮描述**\n${event.descriptions.length ? event.descriptions.map((item) => `• ${displayName(item)}${item.alive ? '' : '（已出局）'}：${item.text}`).join('\n') : '暂时还没有人完成描述。'}` } });
  if (event.voteSummary?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**投票统计**\n${event.voteSummary.map((item) => `• ${item.name}：**${item.votes}** 票`).join('\n')}` } });
  if (event.anonymousTurn) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `📣 **下一位：${displayName({ name: event.currentAnonymousName || '匿名玩家' })}**\n请该代号玩家点击“匿名描述”；机器人也已经私信提醒。` } });
  if (event.question) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**当前问题**\n${event.question}` } });
  if (event.voteActions?.length) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**请选择要淘汰的玩家**' } });
    elements.push({ tag: 'action', layout: 'flow', actions: event.voteActions.map((item) => button(item.label, item.action, event, item.extra || {}, item.type || 'default')) });
  }
  if (event.abstainAction) {
    const item = event.abstainAction;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**不想投任何人？**' } });
    elements.push({ tag: 'action', layout: 'flow', actions: [button(item.label, item.action, event, item.extra || {}, item.type || 'primary')] });
  }
  if (event.utilityActions?.length) elements.push({ tag: 'action', layout: 'flow', actions: event.utilityActions.map((item) => button(item.label, item.action, event, item.extra || {}, item.type || 'default')) });
  if (event.actions?.length) elements.push({ tag: 'action', layout: 'flow', actions: event.actions.map((item) => button(item.label, item.action, event, item.extra || {}, item.type || 'default')) });
  if (event.note) elements.push({ tag: 'note', elements: [plain(event.note)] });
  return { config: { wide_screen_mode: true, update_multi: false, enable_forward: false }, header: { template: event.template || 'blue', title: plain(event.title || '群游戏') }, elements };
}

function createExclusiveWordCard(data) {
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `你的编号：**${data.anonymousName || '匿名玩家'}**\n\n你的词语是：\n\n**${data.word}**` } },
  ];
  if (data.canSpeak) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: plain('开始描述'), type: 'primary', value: { action: 'GAME_SPEAK_READY', chatId: data.chatId, game: 'undercover' } }],
    });
    elements.push({ tag: 'note', elements: [plain('现在轮到你；请在机器人私聊中直接回复描述，机器人会匿名代发到群里。')] });
  } else {
    elements.push({ tag: 'note', elements: [plain(data.currentSpeakerName ? `当前轮到 ${data.currentSpeakerName}，轮到你时请在最新群卡操作。` : '请等待最新群卡提示。')] });
  }
  return {
    config: { wide_screen_mode: true, update_multi: false, enable_forward: false },
    header: { template: 'indigo', title: plain('🔒 仅你可见 · 我的词语') },
    elements,
  };
}

function createExclusiveWordResponse(data) {
  return { card: { type: 'raw', data: createExclusiveWordCard(data) } };
}

function createExclusiveSpeechCard(data) {
  return {
    config: { wide_screen_mode: true, update_multi: false, enable_forward: false },
    header: { template: 'purple', title: plain(`🎭 ${data.anonymousName} · 匿名描述`) },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `现在轮到 **${data.anonymousName}**。输入内容后，机器人会代你发送到群里，不会显示真实昵称。` } },
      {
        tag: 'form', name: 'anonymous_speech_form', elements: [
          {
            tag: 'input', name: 'anonymous_speech', required: true, max_length: 80,
            placeholder: plain('输入你的描述，注意不要直接说出词语'),
            label: plain('描述内容'), label_position: 'top',
          },
          {
            tag: 'button', name: 'anonymous_speech_submit', action_type: 'form_submit', type: 'primary',
            text: plain('匿名发送'),
            value: {
              action: 'GAME_SPEAK_SUBMIT', chatId: data.chatId, game: 'undercover',
              turnVersion: String(data.turnVersion), round: String(data.round),
            },
          },
        ],
      },
      { tag: 'note', elements: [plain('最多 80 个字。提交后，群里只会看到你的随机代号和描述。')] },
    ],
  };
}

function createExclusiveSpeechResponse(data) {
  return { card: { type: 'raw', data: createExclusiveSpeechCard(data) } };
}

module.exports = { createGameCard, createExclusiveWordCard, createExclusiveWordResponse, createExclusiveSpeechCard, createExclusiveSpeechResponse };



