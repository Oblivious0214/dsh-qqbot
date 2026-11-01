/**
 * 编辑器里的"界面"页和角色头像栏。改动只影响 qqbot 会话的显示，不进提示词，不影响前缀缓存。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { SwitchRow } from './switch.tsx'
import { TYPING_SPEEDS } from '../pacing.ts'
import {
  BACKGROUND_FIT_LABELS, BACKGROUND_FITS, PALETTE_LABELS, PALETTES, UI_LIMITS,
  type Palette, type UiAction, type UiSettings,
} from '../ui-types.ts'
import { ImageCropper } from './image-cropper.tsx'
import type { ImageKind } from './images.ts'
import { buildQqCss, imageUrl } from './qq-style.ts'
import { requestUi, type UiState } from './ui-state.ts'
import { ActionDialog } from './action-dialog.tsx'
import { UiExtensionFields, type UiExtensions } from './ui-extensions.tsx'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 提交一个界面操作，成功后更新共享状态。返回错误信息，成功时为空。 */
function useUiAction(ui: UiState, onBusy: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const failed = useRef<() => Promise<UiAction>>()
  useEffect(() => () => { onBusy(false) }, [onBusy])
  const run = async (action: () => Promise<UiAction>): Promise<boolean> => {
    pending.current++
    onBusy(true)
    setBusy(true)
    setError(undefined)
    const before = queue.current
    let finish!: () => void
    queue.current = new Promise<void>(resolve => { finish = resolve })
    await before
    try {
      ui.adopt(await requestUi(await action()))
      failed.current = undefined
      setError(undefined)
      return true
    } catch (caught) {
      failed.current = action
      setError(messageOf(caught))
      return false
    } finally {
      pending.current--
      setBusy(pending.current > 0)
      onBusy(pending.current > 0)
      finish()
    }
  }
  return { busy, error, run, retry: () => failed.current ? run(failed.current) : Promise.resolve(false), clearError: () => { setError(undefined) } }
}

/** 隐藏的文件选择框加一个按钮。 */
function FilePicker({ label, disabled, onFile, renderButton }: {
  readonly label: string; readonly disabled: boolean; readonly onFile: (file: File) => void
  readonly renderButton?: ((choose: () => void) => ReactNode) | undefined
}) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden
      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) onFile(file) }} />
    {renderButton === undefined
      ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => { input.current?.click() }}>{label}</Button>
      : renderButton(() => { input.current?.click() })}
  </>
}

/** 选图按钮：选好后打开裁剪弹窗，裁好再提交；保存成功才关弹窗。 */
function CroppedImagePicker({ kind, label, busy, error, onSave, onOpenChange, renderButton }: {
  readonly kind: ImageKind
  readonly label: string
  readonly busy: boolean
  readonly error: string | undefined
  readonly onSave: (data: string) => Promise<boolean>
  readonly onOpenChange: (open: boolean) => void
  readonly renderButton?: (choose: () => void) => ReactNode
}) {
  const [file, setFile] = useState<File | undefined>()
  // 弹窗里只显示这次保存的错误，不显示打开前表单上的旧错误。
  const [tried, setTried] = useState(false)
  const choose = (next: File | undefined) => { setFile(next); setTried(false); onOpenChange(next !== undefined) }
  return <>
    <FilePicker label={label} disabled={busy} onFile={choose} renderButton={renderButton} />
    {file !== undefined && <ImageCropper kind={kind} file={file} busy={busy} error={tried ? error : undefined}
      onChangeFile={choose} onCancel={() => { choose(undefined) }}
      onSave={(data) => { setTried(true); void onSave(data).then((ok) => { if (ok) choose(undefined) }) }} />}
  </>
}

/** 角色表单里的头像栏。只对已保存的角色可用：头像按角色 id 存。 */
export function RoleAvatarField({ ui, role, name, onBusy, children }: {
  readonly ui: UiState; readonly role: { readonly id: string } | undefined; readonly name: string
  readonly onBusy: (busy: boolean) => void
  readonly children?: ReactNode
}) {
  useSyncExternalStore(ui.subscribe, ui.getVersion)
  const { busy, error, run, clearError } = useUiAction(ui, onBusy)
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | undefined>()
  const [tried, setTried] = useState(false)
  const choose = (next: File | undefined) => { clearError(); setFile(next); setTried(false) }
  const version = role === undefined ? undefined : ui.avatarVersion(role.id)
  const label = version === undefined ? '设置头像' : '更换头像'
  const hint = role === undefined ? '创建角色后可设置头像' : label
  return <>
    <div className="ql-field qq-settings-field">
      <span>头像</span>
      <div className="ql-actions qq-settings-actions">
        <div className="ql-avatar-control">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden
            onChange={(event) => { const next = event.target.files?.[0]; event.target.value = ''; if (next !== undefined) choose(next) }} />
          <button type="button" className="ql-avatar-button" aria-label={label} title={hint} disabled={busy || role === undefined}
            onClick={() => { input.current?.click() }}>
            {version === undefined || role === undefined
              ? <span className="ql-avatar ql-avatar-initial">{Array.from(name.trim())[0] ?? '+'}</span>
              : <img className="ql-avatar" alt="" src={imageUrl('avatar', version, role.id)} />}
          </button>
        </div>
        <Button size="sm" variant="outline" disabled={busy || role === undefined} title={hint}
          onClick={() => { input.current?.click() }}>{label}</Button>
        {role !== undefined && version !== undefined && <Button size="sm" variant="outline" disabled={busy} title="改回首字"
          aria-label="移除头像" onClick={() => { void run(() => Promise.resolve({ action: 'avatar.remove', role: role.id })) }}>×</Button>}
        {children}
        {busy && <span className="ql-note" role="status">头像保存中…</span>}
      </div>
    </div>
    {error !== undefined && file === undefined && <ActionDialog title="头像未更新" cancelLabel="知道了" onCancel={clearError}>{error}</ActionDialog>}
    {role !== undefined && file !== undefined && <ImageCropper kind="avatar" file={file} busy={busy} error={tried ? error : undefined}
      onChangeFile={choose} onCancel={() => { choose(undefined) }} onSave={(data) => {
        setTried(true)
        void run(() => Promise.resolve({ action: 'avatar.set', role: role.id, data })).then(ok => { if (ok) choose(undefined) })
      }} />}
  </>
}

/** hint 是悬停在标签上时的提示。 */
function Row({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return <label className="ql-field qq-settings-field">
    <span title={hint}>{label}</span>
    {children}
  </label>
}


/** 数字输入：失焦或回车时才提交，输入过程中允许暂时不合法。 */
function NumberInput({ value, min, max, step, disabled, onCommit, onEditing }: {
  readonly value: number; readonly min: number; readonly max: number; readonly step: number; readonly onCommit: (value: number) => void
  readonly disabled: boolean; readonly onEditing: (editing: boolean) => void
}) {
  const [draft, setDraft] = useState<string | undefined>()
  const draftRef = useRef<string>()
  const parsed = Number(draft)
  const invalid = draft !== undefined && (draft.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max)
  const commit = () => {
    const text = draftRef.current
    if (text === undefined) return
    const number = Number(text)
    if (text.trim() === '' || !Number.isFinite(number) || number < min || number > max) return
    draftRef.current = undefined
    setDraft(undefined)
    onEditing(false)
    if (number !== value) onCommit(number)
  }
  return <input type="number" min={min} max={max} step={step} disabled={disabled} value={draft ?? String(value)}
    aria-invalid={invalid || undefined} title={invalid ? `请输入 ${min}–${max} 之间的数值` : undefined}
    onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); onEditing(true) }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit() }} />
}

/**
 * 双句柄滑条，用于成对的上下限（迁移自 dsh-serveu 的 DualRange）。拖动时只改本地值，松手才提交，
 * 避免每一格都保存一次。两个句柄至少隔 gap。
 */
export function DualRange({ labels, value, min, max, step, gap = step, format, disabled, onCommit }: {
  readonly labels: readonly [string, string]; readonly value: readonly [number, number]
  readonly min: number; readonly max: number; readonly step: number; readonly gap?: number
  readonly format: (value: number) => string; readonly disabled?: boolean
  readonly onCommit: (value: readonly [number, number]) => void
}) {
  const [draft, setDraft] = useState<readonly [number, number] | undefined>()
  const shown = draft ?? value
  const at = (n: number) => `${(n - min) / (max - min) * 100}%`
  const move = (index: 0 | 1, raw: number) => {
    const next: [number, number] = [shown[0], shown[1]]
    next[index] = index === 0 ? Math.min(raw, shown[1] - gap) : Math.max(raw, shown[0] + gap)
    // 除以 1/step 而不是乘 step：0.1 步进时 3 * 0.1 是 0.30000000000000004，3 / 10 是 0.3。
    next[index] = Math.round(next[index] / step) / (1 / step)
    setDraft(next)
  }
  const commit = () => {
    if (draft === undefined) return
    setDraft(undefined)
    if (draft[0] !== value[0] || draft[1] !== value[1]) onCommit(draft)
  }
  return <div className="ql-dual">
    <div className="ql-dual-rail" style={{ '--ql-a': at(shown[0]), '--ql-b': at(shown[1]) } as CSSProperties}>
      <div className="ql-dual-track" />
      {([0, 1] as const).map(index => <input key={index} type="range" min={min} max={max} step={step} value={shown[index]}
      disabled={disabled} aria-label={labels[index]} aria-valuetext={format(shown[index])}
      // 两个句柄重合在最右边时，下限要在上面，才拖得回来。
      style={{ zIndex: index === 0 && shown[0] > (min + max) / 2 ? 3 : index + 1 }}
      onChange={(event) => { move(index, Number(event.target.value)) }}
      onPointerUp={commit} onKeyUp={commit} onBlur={commit} />)}
    </div>
    <output>{format(shown[0])} – {format(shown[1])}</output>
  </div>
}

/** 渐变代表色迁移自 dsh-qq-skin（MIT，lispking）的 settings-row.tsx。 */
const PALETTE_PREVIEWS: Record<Palette, string> = {
  classic: 'linear-gradient(135deg, #12B7F5, #A8E3FF)',
  vivid: 'linear-gradient(135deg, #8A5CF5, #E3D9FF)',
  clean: 'linear-gradient(135deg, #12B7F5, #EAF4FB)',
  green: 'linear-gradient(135deg, #95EC69, #E4F7D6)',
  black: 'linear-gradient(135deg, #0B0F16, #1D2937)',
}

function PaletteCard({ label, preview, selected, disabled, custom = false, onSelect }: {
  readonly label: string; readonly preview: string; readonly selected: boolean; readonly disabled: boolean
  readonly custom?: boolean; readonly onSelect: () => void
}) {
  return <button type="button" className="ql-palette" aria-pressed={selected} disabled={disabled} onClick={onSelect}>
    <span className="ql-palette-preview" style={{ backgroundImage: preview }} aria-hidden="true">
      {custom && <span className="ql-palette-plus">＋</span>}
      {selected && <span className="ql-palette-check">✓</span>}
    </span>
    <span>{label}</span>
  </button>
}

/** "界面"页：每改一项立即保存。 */
export function UiForm({ ui, onBusy, onDirty, exampleRole, extensions }: { readonly ui: UiState; readonly onBusy: (busy: boolean) => void; readonly onDirty?: (dirty: boolean) => void; readonly exampleRole?: { id: string; name: string } | undefined; readonly extensions?: UiExtensions | undefined }) {
  useSyncExternalStore(ui.subscribe, ui.getVersion)
  const [nativeBusy, setNativeBusy] = useState(false)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [extensionDirty, setExtensionDirty] = useState(false)
  const [pacingBusy, setPacingBusy] = useState(false)
  const [pacingDirty, setPacingDirty] = useState(false)
  const { error, run, retry, clearError } = useUiAction(ui, setNativeBusy)
  const busy = nativeBusy || extensionBusy || pacingBusy
  useEffect(() => { onBusy(busy) }, [onBusy, busy])
  useEffect(() => () => { onBusy(false) }, [onBusy])
  const [cropping, setCropping] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(() => !window.matchMedia('(max-width: 600px)').matches)
  const [patch, setPatch] = useState<Partial<UiSettings>>({})
  const pendingPatch = useRef<Partial<UiSettings>>({})
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const markEditing = (key: string) => (value: boolean) => { setEditing(previous => ({ ...previous, [key]: value })) }
  useEffect(() => { onDirty?.(extensionDirty || pacingDirty || Object.keys(patch).length > 0 || Object.values(editing).some(Boolean)) }, [patch, editing, extensionDirty, pacingDirty, onDirty])
  const settings = { ...ui.settings, ...patch }
  const save = (change: Partial<UiSettings>) => {
    const submitted = { ...pendingPatch.current, ...change }
    pendingPatch.current = submitted
    setPatch(submitted)
    void run(() => Promise.resolve({ action: 'settings.save', settings: { ...ui.settings, ...submitted } })).then(ok => {
      if (!ok) return
      const remaining = { ...pendingPatch.current }
      for (const key of Object.keys(submitted) as (keyof UiSettings)[]) {
        if (remaining[key] === submitted[key]) delete remaining[key]
      }
      pendingPatch.current = remaining
      setPatch(remaining)
    })
  }
  const background = ui.background
  const customActive = background !== undefined && settings.backgroundEnabled
  const status = busy ? '保存中…' : error !== undefined ? error : Object.values(editing).some(Boolean) ? '有未保存的修改' : ''

  return <div className="ql-form ql-appearance">
    {status && <div className="qq-settings-actions">
      <span className="qq-settings-status" role={error !== undefined ? 'alert' : 'status'}>{status}</span>
      {error !== undefined && !cropping && <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (Object.keys(pendingPatch.current).length) save({}); else void retry() }}>重试</Button>}
    </div>}
    <div className="ql-field qq-settings-field">
      <span title="跟随 DSH 的浅色或深色主题">聊天背景</span>
      <div className="ql-palettes" role="group" aria-label="聊天背景">
        {PALETTES.map(palette => <PaletteCard key={palette} label={PALETTE_LABELS[palette]} preview={PALETTE_PREVIEWS[palette]}
          selected={!customActive && settings.palette === palette} disabled={busy}
          onSelect={() => { save({ palette, backgroundEnabled: false }) }} />)}
        <CroppedImagePicker kind="background" label="自定义背景" busy={busy} error={error}
          onOpenChange={open => { clearError(); setCropping(open) }}
          onSave={data => run(() => Promise.resolve({ action: 'background.set', data }))}
          renderButton={choose => <PaletteCard label="自定义背景" disabled={busy} selected={customActive} custom={background === undefined}
            preview={background === undefined ? 'linear-gradient(135deg, #d7e3ed, #f5f7fa)' : `url("${imageUrl('background', background)}")`}
            onSelect={() => { if (background === undefined) choose(); else save({ backgroundEnabled: true }) }} />} />
      </div>
    </div>
    {customActive && <div className="ql-background-options">
      <label className="ql-field ql-inline qq-settings-row"><span>背景显示</span>
        <select value={settings.backgroundFit} disabled={busy} aria-label="背景显示方式"
          onChange={(event) => { const fit = BACKGROUND_FITS.find(f => f === event.target.value); if (fit !== undefined) save({ backgroundFit: fit }) }}>
          {BACKGROUND_FITS.map(f => <option key={f} value={f}>{BACKGROUND_FIT_LABELS[f]}</option>)}
        </select>
      </label>
      <div className="ql-actions qq-settings-actions">
        <CroppedImagePicker kind="background" label="更换图片" busy={busy} error={error}
          onOpenChange={open => { clearError(); setCropping(open) }}
          onSave={data => run(() => Promise.resolve({ action: 'background.set', data }))} />
        <Button size="sm" variant="outline" disabled={busy}
          onClick={() => { void run(() => Promise.resolve({ action: 'background.remove' })) }}>移除图片</Button>
      </div>
    </div>}
    <div className="ql-compact-fields">
      <SwitchRow label="角色头像" checked={settings.avatars} disabled={busy} onChange={(avatars) => { save({ avatars }) }} />
      <SwitchRow label="用户气泡尾巴" checked={settings.bubbleTail} disabled={busy} onChange={(bubbleTail) => { save({ bubbleTail }) }} />
      <Row label="聊天区宽度（px）">
        <NumberInput onEditing={markEditing('chatMaxWidth')} value={settings.chatMaxWidth} min={UI_LIMITS.chatMaxWidth.min} max={UI_LIMITS.chatMaxWidth.max} step={10} disabled={busy}
          onCommit={(chatMaxWidth) => { save({ chatMaxWidth: Math.round(chatMaxWidth) }) }} />
      </Row>
    </div>
    <section aria-label="段落间隔" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={{ margin: 0 }}>段落间隔</h3>
      <label className="ql-field ql-inline qq-settings-row"><span title="根据下一段字数计算等待时间">普通聊天</span>
        <select value={settings.typingSpeed} disabled={busy} aria-label="普通聊天段落间隔"
          onChange={(event) => { const typingSpeed = TYPING_SPEEDS.find(speed => speed === event.target.value); if (typingSpeed !== undefined) save({ typingSpeed }) }}>
          {TYPING_SPEEDS.map(speed => <option key={speed} value={speed}>{{ fast: '短', normal: '中', slow: '长' }[speed]}</option>)}
        </select>
      </label>
      {extensions !== undefined && <UiExtensionFields extensions={extensions} page="pacing" onBusy={setPacingBusy} onDirty={setPacingDirty} />}
    </section><section aria-label="QQ 沉浸模式" style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '16px 0' }}>
      <h3 style={{ margin: '0 0 12px' }}>QQ 沉浸模式</h3>
      <div className="ql-grid">
        <SwitchRow label="隐藏工具过程" checked={settings.hideTools} disabled={busy} onChange={hideTools => { save({ hideTools }) }} />
        <SwitchRow label="隐藏成功命令" checked={settings.hideCommands} disabled={busy} onChange={hideCommands => { save({ hideCommands }) }} />
        <SwitchRow label="隐藏回合统计" checked={settings.hideStats} disabled={busy} onChange={hideStats => { save({ hideStats }) }} />
        <SwitchRow label="隐藏思考过程" checked={settings.hideThinking} disabled={busy} onChange={hideThinking => { save({ hideThinking }) }} />
      </div>
      {extensions !== undefined && <UiExtensionFields extensions={extensions} onBusy={setExtensionBusy} onDirty={setExtensionDirty} />}
    </section>
    <details className="ql-example-fold qq-settings-fold" open={previewOpen} onToggle={event => { setPreviewOpen(event.currentTarget.open) }}><summary>示例聊天</summary>
      <div className="ql-example" aria-label="外观预览">
        <style>{buildQqCss(settings, background).replaceAll('[data-qqbot]', '.dsh-qqbot-library .ql-example')}</style>
        <div data-conversation-scroll=""><div data-chat-flow="">
          <div className="ql-example-user-row"><div className="example_bubble_preview ql-example-user">今天过得怎么样？</div></div>
          <div className="ql-note" data-chat-flow-kind="command" aria-label="示例成功命令"><span data-state="ok">✓ 命令执行成功</span></div>
          <div data-step-process=""><div><button type="button" className="ql-note" data-process-activity="tools" aria-label="示例工具标题">已调用工具</button></div>
            <div data-step-process-body=""><div className="ql-note" data-chat-flow-kind="tool-call" aria-label="示例工具过程">工具过程 · 已读取角色记忆</div></div></div>
          <div className="ql-note" data-variant="think" data-state="ok" aria-label="示例思考过程"><span>思考过程 · 想想今天有什么趣事可以分享。</span></div>
          <div data-step-process=""><div><button type="button" className="ql-note" data-process-activity="thinking" aria-label="示例分析请求">正在分析请求 · 想想怎么回复。</button></div></div>
          <div data-qqbot-reply="" data-qqbot-role="" style={{
            '--qqbot-initial': JSON.stringify(Array.from(exampleRole?.name ?? '小雨')[0]),
            '--qqbot-avatar': exampleRole === undefined || ui.avatarVersion(exampleRole.id) === undefined ? 'none'
              : `url("${imageUrl('avatar', ui.avatarVersion(exampleRole.id)!, exampleRole.id)}")`,
          } as CSSProperties}><div><div><div>刚好想和你聊聊，今天遇到一件有趣的事。</div></div></div></div>
          {extensions !== undefined && <UiExtensionFields extensions={extensions} preview onBusy={setExtensionBusy} />}
          <div className="ql-note" data-turn-tail=""><div data-clock="end"><small aria-label="示例回合统计">本轮用时 2.3 秒 · 128 tokens</small></div></div>
          <div className="ql-note" data-chat-running="" aria-label="示例输入状态"><span>深度求索中，用时 1 秒 ···</span></div>
        </div></div>
      </div>
    </details>
  </div>
}
