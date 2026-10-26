'use strict';

const { bailoutTierForPhrase } = require('./bailout');

function normalizeText(value) {
  return String(value || '')
    .replace(/@_user_\d+/g, '')
    .replace(/[\u3000]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseCommand(input) {
  const text = normalizeText(input);
  if (!text) return null;
  const bailoutTier = bailoutTierForPhrase(text);
  if (bailoutTier) return { type: 'BAILOUT', level: bailoutTier.level };
  if (/^战绩$/.test(text)) return { type: 'STATS' };
  if (/^筹码$/.test(text)) return { type: 'CHIPS' };
  if (/^(补充|补充筹码|买入|重新买入)$/.test(text)) return { type: 'BAILOUT_MENU' };
  if (/^规则$/.test(text)) return { type: 'RULES' };
  if (/^(我要验牌|窝腰验牌)$/.test(text)) return { type: 'VERIFY_CARDS' };
  if (/^(开桌|大厅|运营大厅|技能大厅)$/.test(text)) return { type: 'INTERFACE' };
  if (/^(开德州|德州扑克)$/.test(text)) return { type: 'OPEN' };
  const join = text.match(/^加入(?:\s+(.{1,20}))?$/);
  if (join) return { type: 'JOIN', name: join[1] ? join[1].trim() : null };
  const rename = text.match(/^改名\s+(.{1,20})$/);
  if (rename) return { type: 'RENAME', name: rename[1].trim() };
  if (/^离开$/.test(text)) return { type: 'LEAVE' };
  if (/^(暂停|暂停参赛)$/.test(text)) return { type: 'SIT_OUT', enabled: true };
  if (/^(恢复|恢复参赛)$/.test(text)) return { type: 'SIT_OUT', enabled: false };
  if (/^查看$/.test(text)) return { type: 'VIEW' };
  if (/^开始$/.test(text)) return { type: 'START' };
  if (/^(过牌|check)$/i.test(text)) return { type: 'CHECK' };
  // “跟注100” is a common natural input. The number is informational only:
  // a call always pays exactly the amount required by the current bet.
  if (/^(?:跟注|call)(?:\s*\d+)?$/i.test(text)) return { type: 'CALL' };
  if (/^(弃牌|fold)$/i.test(text)) return { type: 'FOLD' };
  if (/^(allin|all-in|全下)$/i.test(text)) return { type: 'ALL_IN' };
  const raise = text.match(/^(?:加注到|加注|raise)\s*(\d+)$/i);
  if (raise) return { type: 'RAISE_TO', amount: Number(raise[1]) };
  if (/^下一局$/.test(text)) return { type: 'NEXT_HAND' };
  if (/^解散$/.test(text)) return { type: 'DISBAND' };
  if (/^(帮助|命令|help)$/i.test(text)) return { type: 'HELP' };
  // 普通聊天不是游戏命令：静默忽略，避免机器人打断群聊。
  return null;
}

function helpText() {
  return `🏆 顶尖运营帮助\n\n大厅与选项\n开桌｜大厅｜运营大厅：打开技能大厅\n开德州｜德州扑克：创建德州扑克牌桌\n谁是卧底：创建谁是卧底房间\n通用房间\n加入｜开始｜查看｜离开｜解散（所有人权限相同）\n\n德州扑克准备\n加入 昵称｜改名 昵称｜暂停｜恢复｜查看｜开始｜解散｜战绩｜筹码｜补充｜规则\n\n德州扑克行动\n优先点击牌桌卡片，也可以发送：过牌｜跟注｜加注数额｜弃牌｜allin\n“加注数额”中的数额是本轮总下注额；空格可加可不加，例如“加注20”或“加注 20”。\n\n谁是卧底\n进入房间后点击加入和开始；开局会随机分配趣味代号，并打乱每轮发言顺序。轮到自己时点击群卡“匿名描述”，在仅本人可见的输入卡中填写并提交，由机器人代发到群里；机器人私聊回复可作为备用。投票点击代号，也可点击“弃票”或发送“弃权”；结算时才揭晓代号与真实玩家。\n\n机器人只回复明确的技能指令，普通聊天会自动忽略。`;
}

module.exports = { normalizeText, parseCommand, helpText };

