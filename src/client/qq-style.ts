/**
 * QQ 界面样式：按界面设置生成一份 CSS，所有规则都在 `[data-qqbot]` 下（qqbot 会话的聊天区根节点，
 * 由 index.tsx 标记）。标准会话、侧边栏、弹窗不受影响（CLAUDE.md 隔离原则第 3 条）。
 *
 * 几何和结构迁移自 dsh-qq-skin（MIT，lispking）的 src/client/qq-layout.ts 和 segments/bubbles.ts，
 * 按本插件重写：
 * - 色板不改全局主题，写成 `[data-qqbot]` 下的 CSS 变量，DSH 组件里的 `var(--dsw-*)` 在这里取到 QQ 色值。
 * - 头像不往 DOM 里插按钮，由 segments.tsx 的外层节点给出图片或首字，每个气泡用 ::before 画出来。
 * - 不带腾讯的企鹅头像（原文件注明不得商业分发），没有头像图片时显示角色名首字。
 * - 侧边栏和会话标题栏不在 qqbot 会话的节点里，不改。
 * 选择器沿用原文件的做法：组件的 `data-*` 属性，或 CSS Modules 类名的本地名后缀 `[class$="_name"]`。
 */

import { IMAGE_PATH, type UiSettings } from '../ui-types.ts'
import { buildTokenOverrides } from './palettes.ts'

/** 标在 qqbot 会话聊天区根节点（`[data-conversation-session]`）上的属性。 */
export const MARK_ATTRIBUTE = 'data-qqbot'
/** segments.tsx 包在 DSH 助手消息渲染器外面的节点。 */
export const REPLY_ATTRIBUTE = 'data-qqbot-reply'
/** 这一轮回复有角色时 segments.tsx 加在 REPLY 节点上；没有角色不画头像。 */
export const ROLE_ATTRIBUTE = 'data-qqbot-role'

const Q = `[${MARK_ATTRIBUTE}]`
const DARK = `body[data-ds-dark-theme] ${Q}`
const REPLY = `${Q} [${REPLY_ATTRIBUTE}]`
/** DSH 助手消息里每个正文块的节点；推理过程（turn-process-inline）不算气泡。 */
const BUBBLE_PATH = '> div > div > div:not([data-turn-process-inline])'
const BUBBLE = `${REPLY} ${BUBBLE_PATH}`

/** 图片地址。相对路径：DSH 可能挂在子路径下（与提示词查看器一致）。 */
export function imageUrl(kind: 'avatar' | 'background', version: number, role?: string): string {
  const params = new URLSearchParams({ kind, ...role === undefined ? {} : { role }, v: String(version) })
  return `${IMAGE_PATH.slice(1)}?${params.toString()}`
}

/** 深色模式的气泡和聊天区底色，所有色板共用（用户指定，2026-10-30）。 */
const DARK_USER_BUBBLE = '#003E66'
const DARK_REPLY_BUBBLE = '#3B3B3B'
const DARK_CHAT_BACKGROUND = '#222222'

function tokenRules(settings: UiSettings): string {
  const tokens = Object.entries(buildTokenOverrides(settings.palette))
  return `${Q} {\n${tokens.map(([name, value]) => `  ${name}: ${value.light};`).join('\n')}\n}\n`
    + `${DARK} {\n${tokens.map(([name, value]) => `  ${name}: ${value.dark};`).join('\n')}\n  --dsw-specific-bubble: ${DARK_USER_BUBBLE};\n}\n`
}

function backgroundRule(settings: UiSettings, background: number | undefined): string {
  const image = background === undefined ? '' : `
  background-image: url("${imageUrl('background', background)}");
  background-size: ${settings.backgroundFit === 'fill' ? '100% 100%' : settings.backgroundFit};
  background-position: center;
  background-repeat: no-repeat;`
  // 主题变量在 body 上取值，body 的底色不会跟着变，所以聊天区自己铺一层底色。
  return `${Q} [data-conversation-scroll] {
  background-color: var(--dsw-alias-bg-base);${image}
}
${DARK} [data-conversation-scroll] { background-color: ${DARK_CHAT_BACKGROUND}; }
`
}

/** 隐藏已完成回合的工具过程和统计，只留消息和时间。迁移自 qq-layout.ts 的 QQ_IMMERSIVE_CSS。 */
const IMMERSIVE_CSS = `
${Q} [data-chat-flow] [data-chat-flow-kind='turn-process'],
${Q} [data-chat-flow] [data-turn-process],
${Q} [data-chat-flow] [data-chat-flow-kind='command']:has([data-state='ok']) {
  display: none !important;
}
${Q} [data-chat-flow] [data-turn-tail] [data-clock='end'] > :not([class$='_endInfo']),
${Q} [data-chat-flow] [data-turn-tail] [data-clock='end'] > [class$='_endInfo'] > :not([class$='_timeEnd']) {
  display: none !important;
}
${Q} [data-chat-flow] [data-turn-tail] [data-clock='end'] > [class$='_endInfo'] {
  margin-left: 0;
}
`

/**
 * 每个气泡左边一个 33px 圆形头像，图片或首字二选一（变量由 segments.tsx 设在 REPLY 节点上）。
 * 没有角色的回复不画头像，左边距照留：角色还在读取时版面不跳。
 */
const AVATAR_CSS = `
${REPLY} { margin-left: 47px; }
${REPLY}[${ROLE_ATTRIBUTE}] ${BUBBLE_PATH}::before {
  position: absolute; top: 2px; left: -47px;
  width: 33px; height: 33px; border-radius: 50%;
  /* DSH 给所有元素设了 corner-shape: superellipse（ui-theme 的 corner-shape.css），圆形要写回 round。 */
  corner-shape: round;
  display: flex; align-items: center; justify-content: center;
  content: var(--qqbot-initial, "");
  background: var(--dsw-alias-brand-primary) var(--qqbot-avatar, none) center / cover no-repeat;
  color: #fff; font-size: 15px; font-weight: 600; line-height: 1;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
`

const BUBBLE_TAIL_CSS = `
${Q} [class*='_bubble_']::after {
  content: '';
  position: absolute; right: -5px; bottom: 8px;
  width: 10px; height: 10px; border-radius: 2px;
  background: var(--dsw-specific-bubble);
  transform: rotate(45deg);
}
`

export function buildQqCss(settings: UiSettings, background: number | undefined): string {
  return `${tokenRules(settings)}${backgroundRule(settings, background)}
${Q} [data-chat-flow] {
  max-width: ${settings.chatMaxWidth}px;
  margin: 0 auto;
  padding: 16px 24px 8px;
}

/* 角色消息：一个正文块一个气泡，像对方一条条发的消息。 */
${REPLY} { position: relative; min-width: 0; }
${REPLY} > div > div { gap: 10px; align-items: flex-start; }
${BUBBLE} {
  box-sizing: border-box;
  position: relative;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  padding: 9px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 16px 16px 16px 6px;
  background: var(--dsw-alias-bg-layer-1);
  overflow-wrap: anywhere;
}
${BUBBLE} > :last-child { margin-bottom: 0; }
@media (prefers-reduced-motion: no-preference) {
  ${BUBBLE} { animation: qqbot-bubble-arrive 160ms ease-out; }
}
@keyframes qqbot-bubble-arrive { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
${settings.avatars ? AVATAR_CSS : ''}
/* 用户气泡：QQ 蓝底，右上小圆角。 */
${Q} [class*='_bubble_'] {
  position: relative;
  border-radius: 16px 6px 16px 16px;
  box-shadow: 0 1px 2px rgba(18, 122, 175, 0.12);
}
${settings.bubbleTail ? BUBBLE_TAIL_CSS : ''}
/* 消息时间：灰色小圆片。 */
${Q} [data-time-hover-root] [class$='_timeStart'],
${Q} [data-time-hover-root] [class$='_timeEnd'] {
  border-radius: 8px;
  padding: 0 8px;
  color: var(--dsw-alias-label-caption);
  background: var(--dsw-alias-bg-module-platform);
}

/* 输入区：胶囊浮层。 */
${Q} [data-composer-card] {
  border-radius: 18px;
  box-shadow: 0 2px 10px rgba(14, 22, 32, 0.08);
}
${Q} [data-composer-card] [class$='_tools'] button { border-radius: 8px; }
${Q} [data-composer-card] [class$='_tools'] button:hover { background: var(--dsw-alias-interactive-bg-hover); }

${Q} [data-conversation-scroll]::-webkit-scrollbar { width: 10px; }
${Q} [data-conversation-scroll]::-webkit-scrollbar-thumb { border-radius: 6px; background: var(--dsw-alias-scrollbar-bg-l1); }
${Q} [data-conversation-scroll]::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
${settings.immersive ? IMMERSIVE_CSS : ''}
/* 深色：阴影在深底上去掉，角色气泡用固定灰色。 */
${DARK} [class*='_bubble_'], ${DARK} [class*='_bubble_']::after { box-shadow: none; }
${DARK} [data-composer-card] { box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); }
${DARK} [${REPLY_ATTRIBUTE}] > div > div > div:not([data-turn-process-inline]) { background: ${DARK_REPLY_BUBBLE}; }
${DARK} [data-time-hover-root] [class$='_timeStart'],
${DARK} [data-time-hover-root] [class$='_timeEnd'] { background: var(--dsw-alias-bg-layer-3); }
`
}
