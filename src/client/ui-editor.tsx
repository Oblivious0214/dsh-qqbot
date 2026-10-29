/**
 * 编辑器里的"界面"页和角色头像栏。改动只影响 qqbot 会话的显示，不进提示词，不影响前缀缓存。
 */

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  BACKGROUND_FIT_LABELS, BACKGROUND_FITS, INTERVAL_METHODS, PALETTE_LABELS, PALETTES, UI_LIMITS,
  type UiAction, type UiSettings,
} from '../ui-types.ts'
import { avatarFromFile, backgroundFromFile } from './images.ts'
import { imageUrl } from './qq-style.ts'
import { requestUi, type UiState } from './ui-state.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 提交一个界面操作，成功后更新共享状态。返回错误信息，成功时为空。 */
function useUiAction(ui: UiState) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const run = async (action: () => Promise<UiAction>): Promise<boolean> => {
    setBusy(true)
    setError(undefined)
    try {
      ui.adopt(await requestUi(await action()))
      return true
    } catch (caught) {
      setError(messageOf(caught))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** 隐藏的文件选择框加一个按钮。 */
function FilePicker({ label, disabled, onFile }: { readonly label: string; readonly disabled: boolean; readonly onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden
      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) onFile(file) }} />
    <Button size="sm" variant="outline" disabled={disabled} onClick={() => { input.current?.click() }}>{label}</Button>
  </>
}

/** 角色表单里的头像栏。只对已保存的角色可用：头像按角色 id 存。 */
export function RoleAvatarField({ ui, role }: { readonly ui: UiState; readonly role: { readonly id: string; readonly name: string } | undefined }) {
  useSyncExternalStore(ui.subscribe, ui.getVersion)
  const { busy, error, run } = useUiAction(ui)
  const version = role === undefined ? undefined : ui.avatarVersion(role.id)
  return <div className="ql-field">
    <span>头像</span>
    {role === undefined
      ? <small>创建角色后可以上传头像。</small>
      : <div className="ql-actions">
        {version === undefined
          ? <span className="ql-avatar ql-avatar-initial">{Array.from(role.name.trim())[0] ?? ''}</span>
          : <img className="ql-avatar" alt="" src={imageUrl('avatar', version, role.id)} />}
        <FilePicker label={version === undefined ? '上传头像' : '更换头像'} disabled={busy}
          onFile={(file) => { void run(async () => ({ action: 'avatar.set', role: role.id, data: await avatarFromFile(file) })) }} />
        {version !== undefined && <Button size="sm" variant="ghost" disabled={busy}
          onClick={() => { void run(() => Promise.resolve({ action: 'avatar.remove', role: role.id })) }}>改回首字</Button>}
      </div>}
    {role !== undefined && <small>居中裁成正方形，存在 qqbot/images/avatars/。改了立即生效，只影响界面显示。</small>}
    {error !== undefined && <div className="ql-state ql-warn">{error}</div>}
  </div>
}

function Row({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return <label className="ql-field">
    <span>{label}</span>
    {children}
    {hint !== undefined && <small>{hint}</small>}
  </label>
}

function Toggle({ label, checked, disabled, onChange }: {
  readonly label: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (value: boolean) => void
}) {
  return <label className="ql-toggle">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => { onChange(event.target.checked) }} />
    <span>{label}</span>
  </label>
}

/** 数字输入：失焦或回车时才提交，输入过程中允许暂时不合法。 */
function NumberInput({ value, min, max, step, onCommit }: {
  readonly value: number; readonly min: number; readonly max: number; readonly step: number; readonly onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | undefined>()
  const commit = () => {
    if (draft === undefined) return
    const parsed = Number(draft)
    setDraft(undefined)
    if (draft.trim() !== '' && Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)))
  }
  return <input type="number" min={min} max={max} step={step} value={draft ?? String(value)}
    onChange={(event) => { setDraft(event.target.value) }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
}

/** "界面"页：每改一项立即保存。 */
export function UiForm({ ui }: { readonly ui: UiState }) {
  useSyncExternalStore(ui.subscribe, ui.getVersion)
  const { busy, error, run } = useUiAction(ui)
  const settings = ui.settings
  const save = (patch: Partial<UiSettings>) => {
    void run(() => Promise.resolve({ action: 'settings.save', settings: { ...ui.settings, ...patch } }))
  }
  const background = ui.background

  return <div className="ql-form">
    {error !== undefined && <div className="ql-state ql-warn">{error}</div>}
    <Row label="色板" hint="只用于 QQ Bot 会话的聊天区，标准会话和侧边栏不变。跟随 DSH 的浅色或深色主题。">
      <select value={settings.palette} disabled={busy}
        onChange={(event) => { const palette = PALETTES.find(p => p === event.target.value); if (palette !== undefined) save({ palette }) }}>
        {PALETTES.map(p => <option key={p} value={p}>{PALETTE_LABELS[p]}</option>)}
      </select>
    </Row>
    <div className="ql-grid">
      <Toggle label="角色头像" checked={settings.avatars} disabled={busy} onChange={(avatars) => { save({ avatars }) }} />
      <Toggle label="用户气泡尾巴" checked={settings.bubbleTail} disabled={busy} onChange={(bubbleTail) => { save({ bubbleTail }) }} />
      <Toggle label="沉浸模式（隐藏工具过程和回合统计）" checked={settings.immersive} disabled={busy} onChange={(immersive) => { save({ immersive }) }} />
    </div>
    <Row label="聊天区宽度（px）">
      <NumberInput value={settings.chatMaxWidth} min={UI_LIMITS.chatMaxWidth.min} max={UI_LIMITS.chatMaxWidth.max} step={10}
        onCommit={(chatMaxWidth) => { save({ chatMaxWidth: Math.round(chatMaxWidth) }) }} />
    </Row>

    <div className="ql-field">
      <span>聊天背景</span>
      <div className="ql-actions">
        {background !== undefined && <img className="ql-background" alt="" src={imageUrl('background', background)} />}
        <FilePicker label={background === undefined ? '选择图片' : '更换'} disabled={busy}
          onFile={(file) => { void run(async () => ({ action: 'background.set', data: await backgroundFromFile(file) })) }} />
        {background !== undefined && <Button size="sm" variant="ghost" disabled={busy}
          onClick={() => { void run(() => Promise.resolve({ action: 'background.remove' })) }}>去掉背景</Button>}
        <select value={settings.backgroundFit} disabled={busy} aria-label="背景显示方式"
          onChange={(event) => { const fit = BACKGROUND_FITS.find(f => f === event.target.value); if (fit !== undefined) save({ backgroundFit: fit }) }}>
          {BACKGROUND_FITS.map(f => <option key={f} value={f}>{BACKGROUND_FIT_LABELS[f]}</option>)}
        </select>
      </div>
      <small>所有 QQ Bot 会话共用一张。最长边缩到 1920px，存在 qqbot/images/。</small>
    </div>

    <Row label="分段间隔" hint="AI 没给某一段写停顿时间时用这个设置。AI 写了的段落按 AI 写的显示。">
      <select value={settings.intervalMethod} disabled={busy}
        onChange={(event) => { const method = INTERVAL_METHODS.find(m => m === event.target.value); if (method !== undefined) save({ intervalMethod: method }) }}>
        <option value="random">随机间隔</option>
        <option value="log">按字数（字越多停得越久，最多 10 秒）</option>
      </select>
    </Row>
    {settings.intervalMethod === 'random'
      ? <div className="ql-grid">
        <Row label="最短（秒）">
          <NumberInput value={settings.intervalMin} min={UI_LIMITS.interval.min} max={UI_LIMITS.interval.max} step={0.1}
            onCommit={(intervalMin) => { save({ intervalMin }) }} />
        </Row>
        <Row label="最长（秒）">
          <NumberInput value={settings.intervalMax} min={UI_LIMITS.interval.min} max={UI_LIMITS.interval.max} step={0.1}
            onCommit={(intervalMax) => { save({ intervalMax }) }} />
        </Row>
      </div>
      : <Row label="对数底数" hint="越小，长段落停得越久。默认 2.6。">
        <NumberInput value={settings.logBase} min={UI_LIMITS.logBase.min} max={UI_LIMITS.logBase.max} step={0.1}
          onCommit={(logBase) => { save({ logBase }) }} />
      </Row>}
    <div className="ql-note">改了立即生效，存在 qqbot/ui.json。只影响显示，不进提示词，不影响前缀缓存。</div>
  </div>
}
