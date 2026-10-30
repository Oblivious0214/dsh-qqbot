/** 语音页独立样式，不改变角色、预设或宿主设置的布局。 */
export const VOICE_EDITOR_CSS = `
.dsh-qqbot-library .qv-page { height: 64vh; min-height: 320px; overflow: auto; padding: 2px 8px 8px 0; display: flex; flex-direction: column; gap: 20px; }
.dsh-qqbot-library .qv-page h3 { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-qqbot-library .qv-heading, .dsh-qqbot-library .qv-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-qqbot-library .qv-section { display: flex; flex-direction: column; gap: 12px; padding-bottom: 20px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-qqbot-library .qv-section:last-child { border-bottom: 0; padding-bottom: 4px; }
.dsh-qqbot-library .qv-services { flex: none; display: block; }
.dsh-qqbot-library .qv-services > summary { cursor: pointer; font-size: 13px; overflow-wrap: anywhere; }
.dsh-qqbot-library .qv-services[open] > summary { margin-bottom: 14px; }
.dsh-qqbot-library .qv-services .qv-heading { margin-bottom: 12px; }
.dsh-qqbot-library .qv-page > * { flex-shrink: 0; }
.dsh-qqbot-library .qv-cards { display: flex; flex-direction: column; gap: 8px; }
.dsh-qqbot-library .qv-card { padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
.dsh-qqbot-library .qv-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; overflow-wrap: anywhere; }
.dsh-qqbot-library .qv-info strong { font-size: 13px; font-weight: 500; }
.dsh-qqbot-library .qv-meta { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-qqbot-library .qv-row > .ql-actions { flex-shrink: 0; }
.dsh-qqbot-library .qv-fields { display: flex; flex-direction: column; gap: 18px; border: 0; padding: 0; margin: 0; min-width: 0; }
.dsh-qqbot-library .qv-setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 13px; }
.dsh-qqbot-library .qv-setting > span:first-child { flex-shrink: 0; }
.dsh-qqbot-library .qv-setting select { max-width: 70%; min-width: 0; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-qqbot-library .qv-fields:disabled .qv-setting { opacity: 0.55; }
.dsh-qqbot-library .qv-volume { display: flex; align-items: center; gap: 10px; width: min(280px, 70%); }
.dsh-qqbot-library .qv-volume input { flex: 1; min-width: 0; margin: 0; }
.dsh-qqbot-library .qv-volume output { width: 4ch; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-qqbot-library .qv-form-head { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; width: 100%; max-width: 600px; align-self: center; }
.dsh-qqbot-library .qv-editor { width: 100%; max-width: 600px; align-self: center; }
.dsh-qqbot-library .qv-proxy { display: flex; flex-direction: column; gap: 12px; padding: 14px; background: var(--dsw-alias-bg-layer-1); border-radius: var(--dsw-radius-md); }
.dsh-qqbot-library .qv-more { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 14px; }
.dsh-qqbot-library .qv-more summary { cursor: pointer; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsh-qqbot-library .qv-more > .qv-fields { padding-top: 14px; }
.dsh-qqbot-library .qv-preview { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-qqbot-library .qv-card .qv-preview { margin-top: 12px; }
.dsh-qqbot-library .qv-footer { position: sticky; bottom: -8px; display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0 8px; background: var(--dsw-alias-bg-layer-3); border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-qqbot-library .qv-notice { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px; font-size: 13px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
@media (max-width: 580px) {
  .dsh-qqbot-library .qv-row { flex-wrap: wrap; }
  .dsh-qqbot-library .qv-info { flex-basis: 100%; }
  .dsh-qqbot-library .qv-row > .ql-actions { margin-left: auto; }
  .dsh-qqbot-library .qv-page { padding-right: 2px; }
}
`
