/**
 * QQ NT 风格圆角开关，全插件的开／关设置共用。多选仍用复选框。
 * 样式迁移自 dsh-qq-skin（MIT，lispking）的 settings-ui.tsx SettingsToggle；内联读取 `--dsw-*`，
 * 放在编辑器、联动弹窗或接话弹窗里都一致，不依赖各自根 class。
 */
import type { CSSProperties, ReactNode } from 'react'

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 12, minWidth: 0,
  fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)',
}

export function Switch({ label, checked, disabled = false, onChange }: {
  readonly label: string; readonly checked: boolean; readonly disabled?: boolean | undefined
  readonly onChange: (value: boolean) => void
}) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked}
    disabled={disabled} onClick={() => { onChange(!checked) }}
    style={{
      boxSizing: 'border-box', flex: 'none', width: 36, height: 20, minHeight: 0,
      padding: 0, border: 'none', borderRadius: 999, position: 'relative', font: 'inherit',
      background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-module-platform)',
      boxShadow: checked ? 'none' : 'inset 0 0 0 1px var(--dsw-alias-border-l3)',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      transition: 'background 0.15s ease',
    }}>
    <span style={{
      position: 'absolute', top: 2, left: checked ? 18 : 2,
      width: 16, height: 16, borderRadius: '50%', background: '#fff',
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)', transition: 'left 0.15s ease',
    }} />
  </button>
}

/** 标签在左、开关在右；title 是悬停说明，extra 放在开关左边（例如“怎么做”）。 */
export function SwitchRow({ label, title, checked, disabled, onChange, extra }: {
  readonly label: string; readonly title?: string | undefined; readonly checked: boolean
  readonly disabled?: boolean | undefined; readonly onChange: (value: boolean) => void; readonly extra?: ReactNode
}) {
  return <div className="qq-switch-row" style={ROW}>
    <span title={title} style={{ minWidth: 0, overflowWrap: 'anywhere', ...title === undefined ? {} : { cursor: 'help' } }}>{label}</span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
      {extra}
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </span>
  </div>
}
