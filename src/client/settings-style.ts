/** QQbot 设置、所属弹窗及设备右栏共用；不匹配宿主或其他插件。 */
const ROOT = ':is(.dsh-qqbot-library, .dsh-toy-buttplug, .dsh-qqbot-action-dialog)'

export const SETTINGS_CSS = `
${ROOT} { color: var(--dsw-alias-label-primary); }
${ROOT} :is(.qq-settings-row, .qq-settings-actions) { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
${ROOT} .qq-settings-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
${ROOT} .qq-settings-row > :is(input, select) { min-width: 0; max-width: 100%; }
${ROOT} .qq-settings-actions > button:not([role="switch"]) { min-height: 36px; font-size: 14px; line-height: 22px; }
${ROOT} :is(input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea) {
  box-sizing: border-box; max-width: 100%; min-height: 36px; padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
}
${ROOT} textarea { width: 100%; resize: vertical; }
${ROOT} input[type="checkbox"] { width: 16px; height: 16px; padding: 0; flex: none; accent-color: var(--dsw-alias-brand-primary); }
${ROOT} input[type="range"] { accent-color: var(--dsw-alias-brand-primary); }
${ROOT} :is(input, select, textarea):disabled { opacity: .5; cursor: default; }
${ROOT} :is(input, select, textarea, button:not([role="switch"]), summary):focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
${ROOT} [aria-invalid="true"] { border-color: var(--dsw-alias-state-warn-label); }
${ROOT} .qq-settings-status { min-height: 20px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
${ROOT} .qq-settings-status[role="alert"] { color: var(--dsw-alias-state-warn-label); }
${ROOT} .qq-settings-fold { border-top: 1px solid var(--dsw-alias-border-l2); }
${ROOT} .qq-settings-fold > summary { display: flex; align-items: center; gap: 8px; list-style: none; padding: 12px 0; cursor: pointer; }
${ROOT} .qq-settings-fold > summary::-webkit-details-marker { display: none; }
${ROOT} .qq-settings-fold > summary::before { content: '›'; flex: none; font-size: 18px; line-height: 1; transition: transform .12s; }
${ROOT} .qq-settings-fold[open] > summary::before { transform: rotate(90deg); }
${ROOT} .qq-settings-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px; min-width: 0; }
.dsh-qqbot-library .ql-tabs { flex-wrap: nowrap; overflow-x: auto; min-width: 0; padding: 2px 2px 6px; scrollbar-width: thin; }
.dsh-qqbot-library .ql-tabs > button { flex: none; white-space: nowrap; }
.dsh-qqbot-library .ql-role-nav { display: flex; flex: none; gap: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 8px; }
.dsh-qqbot-library .ql-maintenance { display: flex; align-items: center; flex: none; gap: 6px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-qqbot-library .ql-maintenance > button { white-space: nowrap; }
.dsh-qqbot-library .ql-proactivity { align-items: stretch; flex-direction: column; }
.dsh-qqbot-library .ql-proactivity-select { flex: none; width: 100%; }
.dsh-qqbot-library .ql-grid { grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); }
.dsh-qqbot-library .ql-inline.qq-settings-row { flex-direction: row; }
.dsh-qqbot-library .ql-toy-prompts-inline { width: 100%; }
.dsh-qqbot-library .ql-page > .ql-main { min-width: 0; }
@media (max-width: 600px) {
  .dsh-qqbot-library .ql-maintenance { gap: 2px; }
  .dsh-qqbot-library .ql-maintenance > button { padding-inline: 8px; }
  .dsh-qqbot-library .ql-dual { grid-template-columns: minmax(0, 1fr); }
}

/* 紧凑设置布局：不改变手机页、设备行程与速度区域。 */
.dsh-qqbot-library .ql-field textarea { font-family: inherit; }
.dsh-qqbot-library .ql-role-identity { display: flex; flex-wrap: wrap; align-items: end; gap: 12px 24px; }
.dsh-qqbot-library .ql-role-identity .ql-identity { width: min(240px, 100%); }
.dsh-qqbot-library .ql-role-identity .ql-actions { min-height: 40px; }
.dsh-qqbot-library .ql-fields > .ql-field:has(> textarea) > textarea { min-height: 240px; }
.dsh-qqbot-library .ql-row[aria-current="true"] { box-shadow: inset 3px 0 var(--dsw-alias-brand-primary); }
.dsh-qqbot-library .ql-group > summary { padding: 8px 0; }
.dsh-qqbot-library .ql-grid { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 12px 28px; }
.dsh-qqbot-library .ql-grid > .qq-switch-row { flex: none; }
.dsh-qqbot-library .ql-compact-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; }
.dsh-qqbot-library .ql-compact-fields > .ql-field { flex-direction: row; align-items: center; gap: 8px; }
.dsh-qqbot-library :is(.ql-appearance, .ql-chat-assist) .ql-field > input[type="number"] { width: 76px; }
.dsh-qqbot-library :is(.ql-appearance, .ql-chat-assist) .qq-section { padding: 10px 0; gap: 10px; }
/* 聊天辅助沿用公共卡片、折叠入口与控件，限制阅读宽度。 */
.dsh-qqbot-library .ql-chat-assist { width: 100%; max-width: 720px; align-self: flex-start; gap: 16px; }
.dsh-qqbot-library .ql-chat-assist .qq-section { display: flex; flex-direction: column; align-items: stretch; gap: 14px; padding: 18px 20px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.dsh-qqbot-library .ql-chat-assist .qq-section > .qq-switch-row { font-weight: 600; }
.dsh-qqbot-library .ql-chat-assist .qq-switch-row > span:last-child { margin-left: 0; }
.dsh-qqbot-library .ql-chat-assist .qq-settings-row { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 8px 12px; margin: 0; }
.dsh-qqbot-library .ql-chat-assist .qq-settings-row > input[type="number"] { width: 88px; flex: none; text-align: center; }
.dsh-qqbot-library .ql-chat-assist .qq-section > p { margin: 0; font-size: 13px; }
.dsh-qqbot-library .ql-chat-assist .qq-settings-fold { margin: 0; padding-top: 2px; }
.dsh-qqbot-library .ql-chat-assist .qq-settings-fold > summary { font-size: 13px; color: var(--dsw-alias-label-secondary); padding: 10px 0 0; }
.dsh-qqbot-library .ql-chat-assist .qq-settings-fold > summary strong { font-weight: 400; }
.dsh-qqbot-library .ql-chat-assist .qq-settings-fold[open] > summary { padding-bottom: 12px; }
@media (max-width: 600px) {
  .dsh-qqbot-library .ql-chat-assist .qq-section { padding: 14px; }
}
.dsh-qqbot-library .ql-appearance .ql-palettes { grid-template-columns: repeat(6, minmax(0, 110px)); }
.dsh-qqbot-library .qv-page { gap: 12px; }
.dsh-qqbot-library .qv-section { gap: 10px; padding-bottom: 12px; }
.dsh-qqbot-library .qv-fields { gap: 12px; }
.dsh-qqbot-library .qv-section > .qv-fields { flex-direction: row; flex-wrap: wrap; gap: 12px 24px; }
.dsh-qqbot-library .qv-setting { gap: 8px; }
.dsh-qqbot-library .qv-setting > span:first-child { width: auto; }
.dsh-qqbot-library .dsh-toy-buttplug.tb-embedded details.tb-card { padding-block: 4px; }
.dsh-qqbot-library .dsh-toy-buttplug.tb-embedded .tb-fold > summary { padding-block: 8px; }
@media (max-width: 600px) {
  .dsh-qqbot-library .ql-appearance .ql-palettes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dsh-qqbot-library .ql-compact-fields > .ql-field { flex-wrap: wrap; }
  .dsh-qqbot-library .ql-role-identity { align-items: start; gap: 10px; }
  .dsh-qqbot-library .ql-fields > .ql-field:has(> textarea) > textarea { min-height: 180px; }
}

/* 独立文本编辑沿用聊天辅助的折叠、字号和按钮，不作用于角色正文或预设。 */
${ROOT} .qq-text-editor { min-width: 0; margin: 0; }
${ROOT} .qq-text-editor.qq-settings-fold { padding: 2px 0 0; }
.dsh-qqbot-library .ql-meme-group .qq-text-editor.qq-settings-fold { border-top: 0; }
${ROOT} .qq-text-editor.qq-settings-fold > summary { padding: 10px 0 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
${ROOT} .qq-text-editor.qq-settings-fold > summary strong { font-weight: 400; }
${ROOT} .qq-text-editor.qq-settings-fold[open] > summary { padding-bottom: 12px; }
${ROOT} .qq-text-editor-body { display: flex; flex-direction: column; gap: 12px; padding: 0 0 6px; min-width: 0; }
${ROOT} .qq-text-editor textarea, ${ROOT} textarea.qq-text-input { width: 100%; min-height: 144px; font-family: inherit; line-height: 22px; }
${ROOT} .qq-text-editor .qq-settings-actions { justify-content: flex-start; }
${ROOT} .tb-library-description { align-items: stretch; flex-direction: column; gap: 6px; }
${ROOT} .tb-library-description > textarea.qq-text-input { flex: none; min-width: 0; min-height: 100px; }
`
