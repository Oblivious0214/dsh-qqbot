/** 联动的会话操作，接入宿主原生右栏；设置和运动控制仍由原模块负责。 */
import { bluetoothUnavailable } from './bluetooth.ts'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { Button, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MotionFineControls, ROOT_CLASS, useToy, type ToyInjected } from './panel.tsx'
import { linkageStatus } from './status.ts'
import type { ToyController, ToySnapshot } from './controller.ts'
import { HARD_LIMITS, type MotionConfig } from '../core/config.ts'
import { mergeSettings } from './settings-merge.ts'
import { PacingSettings } from './pacing-settings.tsx'
import { ClimaxPreset } from './preset-library.tsx'

export const TOY_TAB = 'qqbot-toy'
const TAB_ID = 'dsh-qqbot/toy'
const ignoreEditorOpen = () => {}
interface SidebarInjected extends ToyInjected {
  readonly openSettings: () => void
  readonly openRoleProactivity?: (sessionId: string) => void
}

/** 连接方式始终可见，连接期间锁定编辑。 */
function ConnectionSettings({ toy, connection, controller }: { toy: ToySnapshot; connection: ToyInjected['connection']; controller: ToyController }) {
  const [address, setAddress] = useState(() => connection.get().address.replace(/^ws:\/\//i, ''))
  const phase = toy.transport.phase
  const locked = phase !== 'disconnected'
  return <div className="tb-sidebar-connection">
    <div className="tb-connection-fields">
      <label className="tb-field qq-settings-field"><span>连接方式</span><select aria-label="连接方式" value={toy.kind} disabled={locked} onChange={event => {
        const kind = event.target.value === 'bluetooth' ? 'bluetooth' : 'buttplug'
        controller.select(kind); connection.set({ kind, address })
      }}>
        <option value="buttplug">Buttplug</option>
        <option value="bluetooth">蓝牙</option>
      </select></label>
      {toy.kind === 'buttplug' && <label className="tb-field qq-settings-field"><span>服务地址</span><input aria-label="服务地址" value={address} disabled={locked} spellCheck={false}
        placeholder="127.0.0.1:12345" onChange={event => {
          const value = event.target.value.replace(/^ws:\/\//i, '')
          setAddress(value)
          connection.set({ kind: 'buttplug', address: value })
        }} /></label>}
      {toy.kind === 'bluetooth' && bluetoothUnavailable() && <p className="tb-error" role="status">{bluetoothUnavailable()}</p>}
    </div>
  </div>
}

/** 只渲染当前会话的实时状态，收起/换页不会改变设备的运行。 */
export function ToySidebar({ sessionId, controller, connection, openSettings, openRoleProactivity }: SidebarInjected & { sessionId: string }) {
  const toy = useToy(controller)
  const [error, setError] = useState('')
  const [manual, setManual] = useState(50)
  const [positioning, setPositioning] = useState(false)
  const [manualTarget, setManualTarget] = useState<number>()
  const [, tick] = useState(0)
  const mine = toy.owner === sessionId
  const phase = toy.transport.phase
  const connected = phase !== 'disconnected'
  const playback = controller.livePlayback(sessionId)
  const ticking = mine && toy.moving
  useEffect(() => {
    if (!mine || phase !== 'ready' || toy.paused || toy.mode !== 'manual') setManualTarget(undefined)
  }, [mine, phase, toy.paused, toy.mode, sessionId])
  useEffect(() => {
    if (!ticking) return
    let frame: number
    const refresh = () => { tick(value => value + 1); frame = requestAnimationFrame(refresh) }
    frame = requestAnimationFrame(refresh)
    return () => cancelAnimationFrame(frame)
  }, [ticking])
  if (!toy.enabled) return null
  const authorized = toy.settings?.authorized === true
  const canAttach = authorized && phase === 'ready' && toy.qqbot && toy.segments
  const live = mine && phase === 'ready' && toy.qqbot && toy.segments
  const control = live && !toy.paused
  const run = (task: () => Promise<void>) => { setError(''); void task().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }
  const status = linkageStatus(toy, sessionId)
  const message = error || status.detail
  const interruption = controller.lastInterruption(sessionId)
  const stage = toy.phase
  return <section className={`${ROOT_CLASS} qq-settings-scope tb-sidebar`} aria-label="设备联动">
    <div className="tb-sidebar-top"><strong>设备联动</strong></div>
    {(phase === 'disconnected' || phase === 'connecting') && <ConnectionSettings toy={toy} connection={connection} controller={controller} />}
    <div className="tb-connection-buttons">
    {authorized ? <>
        <Button variant="outline" className={phase === 'ready' ? 'tb-sidebar-active' : undefined} aria-pressed={phase === 'ready'} title={connected ? '点击断开设备' : undefined} onClick={() => {
          if (connected) controller.disconnect()
          else run(() => controller.connect(connection.get().address))
        }}>{phase === 'connecting' ? '连接中' : phase === 'waiting' ? '等待设备' : connected ? '已连接' : '连接设备'}</Button>
        <Button variant="outline" className={mine ? 'tb-sidebar-active' : undefined} aria-pressed={mine}
          disabled={toy.busy || (!mine && !canAttach)}
          title={mine ? '点击退出联动' : undefined}
          onClick={() => run(() => mine ? controller.detach() : controller.attach(sessionId))}>{mine ? toy.paused ? '已暂停' : '联动中' : '启用联动'}</Button>
    </> : <Button variant="outline" onClick={openSettings}>前往授权与设置</Button>}
        {stage === undefined && <Button variant="outline" className="tb-burst" disabled={!control || toy.busy}
          onClick={() => { run(() => controller.burst()) }}>高潮</Button>}
        {stage?.kind === 'burst' && <Button variant="outline" disabled={toy.busy} onClick={() => { run(() => controller.cancelPhase()) }}>取消高潮</Button>}
        {stage?.kind === 'aftercare' && <Button variant="outline" disabled={toy.busy} onClick={() => { run(() => controller.cancelPhase()) }}>结束温存</Button>}
    </div>
    <div className="tb-connection-buttons tb-sidebar-settings">
        <ClimaxPreset key={controller.settingsDraftGeneration} controller={controller} compact />
        <Button variant="outline" onClick={openSettings}>联动设置</Button>
        {openRoleProactivity && <Button variant="outline" onClick={() => { openRoleProactivity(sessionId) }}>AI主动性</Button>}
    </div>
    <div className="tb-sidebar-controls">
    <div className="tb-sidebar-buttons">
    <StatusCard toy={toy} controller={controller} mine={mine} playback={mine ? playback : undefined} />
    </div>
    {<div className="tb-stroke-control" role="group" aria-label="手动定位控制">
      <small aria-hidden="true">龟头</small>
      <div className="tb-stroke-rail">
        <input type="range" min={0} max={100} step="any" value={positioning ? manual : toy.mode === 'manual' && manualTarget !== undefined ? manualTarget : playback?.position ?? manual} aria-label="手动定位" aria-orientation="vertical"
          disabled={!control || stage !== undefined} title="拖动定位"
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setManual(Number(event.currentTarget.value)); setPositioning(true) }}
          onPointerUp={() => { setPositioning(false) }} onPointerCancel={() => { setPositioning(false) }}
          onLostPointerCapture={() => { setPositioning(false) }}
          onKeyDown={event => { if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return; if (!positioning) setManual(Number(event.currentTarget.value)); setPositioning(true) }} onKeyUp={() => { setPositioning(false) }}
          onBlur={() => { setPositioning(false) }}
          onChange={event => { const value = Number(event.target.value); setManual(value); setManualTarget(value); controller.manual(value) }} />
      </div>
      <small aria-hidden="true">根部</small>
    </div>}
    </div>
    {toy.settings !== undefined && <LiveMotionControls toy={toy} controller={controller} />}
    {message && <p className={error || toy.loadError || toy.transport.error || toy.activity === 'error' ? "tb-error" : "tb-hint"} role="status">{message}</p>}
    {mine && toy.syncWarning && <p className="tb-hint" role="status">{toy.syncWarning}</p>}
    {interruption && interruption !== message && <details className="tb-sidebar-readout"><summary>最近一次中断</summary><p className="tb-hint">{interruption}</p></details>}
  </section>
}

function LiveMotionControls({ toy, controller }: { toy: ToySnapshot; controller: ToyController }) {
  const config = toy.settings!.motion
  type Limits = MotionConfig
  const [patch, setPatch] = useState<Partial<Limits>>({})
  const pending = useRef<Partial<Limits>>({})
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const [error, setError] = useState('')
  const limits = { ...config, ...patch }
  const bounds: [number, number] = [limits.minPosition, limits.maxPosition]
  const speed = limits.maxSpeed
  const disabled = saving
  const edit = (next: Partial<Limits>) => {
    pending.current = { ...pending.current, ...next }; setPatch(pending.current)
  }
  const commit = () => {
    if (busy.current || Object.keys(pending.current).length === 0) return
    const update = pending.current
    busy.current = true; setSaving(true); setError('')
    void controller.updateSettings(latest => ({ ...latest, motion: mergeSettings(config, { ...config, ...update }, latest.motion) }))
      .then(() => { pending.current = {}; setPatch({}) })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { busy.current = false; setSaving(false) })
  }
  const commitEvents = { onPointerUp: commit, onPointerCancel: commit, onKeyUp: commit, onBlur: commit }
  const at = (value: number) => `${(value - HARD_LIMITS.minPosition) / (HARD_LIMITS.maxPosition - HARD_LIMITS.minPosition) * 100}%`
  const move = (index: 0 | 1, raw: number) => {
    if (index === 0) edit({ minPosition: Math.min(raw, bounds[1] - 1) })
    else edit({ maxPosition: Math.max(raw, bounds[0] + 1) })
  }
  return <div className="tb-sidebar-group" role="group" aria-label="行程与速度">
    <div className="tb-sidebar-group-title"><span>行程与速度</span>{saving && <small role="status">保存中</small>}</div>
    {error && <div role="alert"><span className="tb-error">{error}</span><Button size="sm" variant="ghost" onClick={commit}>重试</Button></div>}
    <div className="tb-live-slider" role="group" aria-label="行程">
      <div className="tb-live-label"><span>行程</span><output aria-label="行程范围">{bounds[0]}–{bounds[1]}</output></div>
      <div className="tb-live-range qq-settings-slider" style={{ '--tb-low': at(bounds[0]), '--tb-high': at(bounds[1]) } as CSSProperties}>
        <div className="tb-live-track" />
        {([0, 1] as const).map(index => <input key={index} type="range" min={HARD_LIMITS.minPosition} max={HARD_LIMITS.maxPosition} step={1}
          value={bounds[index]} aria-label={index === 0 ? '行程起点' : '行程终点'}
          aria-valuemin={index === 0 ? HARD_LIMITS.minPosition : bounds[0] + 1} aria-valuemax={index === 0 ? bounds[1] - 1 : HARD_LIMITS.maxPosition}
          disabled={disabled} style={{ zIndex: index === 0 && bounds[0] > (HARD_LIMITS.minPosition + HARD_LIMITS.maxPosition) / 2 ? 3 : index + 1 }}
          {...commitEvents} onChange={event => { move(index, Number(event.target.value)) }} />)}
      </div>
    </div>
    <label className="tb-live-slider">
      <span className="tb-live-label"><span>速度上限</span><output aria-label="速度上限值">{speed} unit/s</output></span>
      <input type="range" min={HARD_LIMITS.minSpeed} max={HARD_LIMITS.maxSpeed} step={1} value={speed} disabled={disabled}
        style={{ '--tb-speed': `${(speed - HARD_LIMITS.minSpeed) / Math.max(1, HARD_LIMITS.maxSpeed - HARD_LIMITS.minSpeed) * 100}%` } as CSSProperties}
        className="qq-settings-slider" aria-label="速度上限" aria-valuetext={`${speed} unit/s`} title="速度上限"
        {...commitEvents} onChange={event => { edit({ maxSpeed: Number(event.target.value) }) }} />
    </label>
    <fieldset className="tb-sidebar-fine" disabled={disabled}>
      <MotionFineControls motion={limits} actionLibrary={toy.actionLibrary} controller={controller} disabled={disabled}
        onEditorOpen={ignoreEditorOpen} set={next => { edit(next); commit() }} />
    </fieldset>
  </div>
}

/** 动作、行程、速度分行常驻；停止时保留占位。读取不续期、不发包。 */
function StatusCard({ toy, controller, mine, playback }: {
  toy: ToySnapshot; controller: ToyController; mine: boolean; playback: ReturnType<ToyController['livePlayback']>
}) {
  const stage = toy.phase
  const seconds = playback?.remainingMs === undefined ? undefined : Number.isFinite(playback.remainingMs) ? `${(Math.ceil(playback.remainingMs / 100) / 10).toFixed(1)} 秒` : '不自动停止'
  const active = mine && playback !== undefined
  const rows: [string, ReactNode][] = [
    ['当前动作', active ? playback.name : linkageStatus(toy, toy.owner ?? '').label],
    ['行程', active ? playback.range ?? '—' : '—'],
    ['速度', active ? playback.speed ?? '—' : '—'],
    ['阶段', active && stage !== undefined ? stage.kind === 'burst' ? '刺激' : '温存' : '—'],
    [!active || seconds === undefined || stage !== undefined ? '剩余时间' : toy.paused ? '暂停时剩余' : playback.tail ? toy.settings?.motion.standby !== undefined && toy.mode !== 'standby' ? '转入待机' : '自动停止' : '保护停止',
      <output aria-label="剩余时间">{active ? seconds ?? '—' : '—'}</output>],
  ]
  return <div className="tb-status-card" role="status" aria-label="联动状态">
    <dl>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    {toy.settings !== undefined && <PacingSettings controller={controller} label="段落间隔" />}
  </div>
}

type BodyProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<SidebarInjected>
function ToyTab(props: BodyProps) {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  const toy = useToy(props.controller)
  const { tab } = props.useTabInfo()
  useEffect(() => { if (preset !== 'qqbot' || !toy.enabled) tab.actions.close() }, [preset, toy.enabled, tab.actions])
  if (preset !== 'qqbot' || !toy.enabled) return null
  return <ToySidebar key={props.sessionId} {...props} />
}

type LauncherProps = PropsRuntime<'conversation.input.left'> & InjectFace<SidebarInjected & { open: () => void }>
function ToyLauncher(props: LauncherProps) {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  const toy = useToy(props.controller)
  if (preset !== 'qqbot' || !toy.enabled) return null
  return <span className={ROOT_CLASS}><Button size="sm" variant="ghost" icon={<IconLinkOutlineRegular size={16} />}
    onClick={props.open} title="打开右侧设备联动面板">设备联动</Button></span>
}

export function installToySidebar(ctx: Context, injected: SidebarInjected): void {
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], inner => {
    // 宿主指南的类型列表是全局的，只在前台为 QQbot 会话时贡献原生卡片。
    inner.effect(() => {
      let unregister: (() => void) | undefined
      const sync = () => {
        const sessionId = inner.sidebarRight.mounted.getSnapshot()
        const enabled = injected.controller.getSnapshot().enabled && sessionId !== undefined
          && inner.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset === 'qqbot'
        if (enabled && unregister === undefined) {
          unregister = inner.sidebarRightTabs.register({
            id: TAB_ID, kind: TOY_TAB, title: () => '设备联动',
            guide: [{ id: 'open', order: 40, title: () => '设备联动',
              description: () => '连接设备与联动当前对话', icon: IconLinkOutlineRegular }],
          })
        } else if (!enabled && unregister !== undefined) {
          unregister(); unregister = undefined
        }
      }
      const stopMounted = inner.sidebarRight.mounted.subscribe(sync)
      const stopSessions = inner.sessions.list.subscribe(sync)
      const stopToy = injected.controller.subscribe(sync)
      sync()
      return () => { stopMounted(); stopSessions(); stopToy(); unregister?.() }
    }, 'qqbot: toy tab type and guide')
    inner.slots.inject('sidebar.right.pane.tab', () => inner.slots.register({
      name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => injected,
    }, ToyTab))
    inner.slots.inject('conversation.input.left', () => inner.slots.register({
      name: 'conversation.input.left', id: TAB_ID, order: 14,
      inject: sessionId => ({ ...injected, open: () => {
        const row = inner.sessions.list.getSnapshot().byId[sessionId]
        if (injected.controller.getSnapshot().enabled && row?.projectionValues?.agentPreset === 'qqbot'
          && inner.sidebarRight.mounted.getSnapshot() === sessionId) inner.sidebarRight.openTab(TOY_TAB)
      } }),
    }, ToyLauncher))
    inner.effect(() => {
      const closeOwned = () => {
        for (const tab of inner.sidebarRight.openTabs.getSnapshot()) {
          if (tab.kind === TOY_TAB) inner.sidebarRight.closeIn(tab.sessionId, tab.tabId)
        }
      }
      const sync = () => { if (!injected.controller.getSnapshot().enabled) closeOwned() }
      const unsubscribe = injected.controller.subscribe(sync)
      sync()
      return () => { unsubscribe(); closeOwned() }
    }, 'qqbot: release toy tabs')
  })
}

export const SIDEBAR_CSS = `
.dsh-toy-buttplug.tb-sidebar { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-text-primary); container: qqbot-toy-sidebar / inline-size; }
.dsh-toy-buttplug .tb-sidebar-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-toy-buttplug .tb-status-card { display: grid; gap: 10px; flex-shrink: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l3, #8883); border-radius: 8px; font-size: 13px; }
.dsh-toy-buttplug .tb-status-card dl { display: grid; gap: 6px; margin: 0; }
.dsh-toy-buttplug .tb-status-card dl > div { display: grid; grid-template-columns: 5em minmax(0, 1fr); gap: 8px; }
.dsh-toy-buttplug .tb-status-card dt { color: var(--dsw-alias-text-secondary); }
.dsh-toy-buttplug .tb-status-card dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dsh-toy-buttplug .tb-status-card dl > div:first-child { min-height: 1lh; margin-bottom: 4px; }
@container qqbot-toy-sidebar (max-width: 280px) {
  .dsh-toy-buttplug .tb-status-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .dsh-toy-buttplug .tb-status-card dl > div:first-child { min-height: 2lh; }
  .dsh-toy-buttplug .tb-status-card dl > div:not(:first-child) { min-height: 2lh; }
}
.dsh-toy-buttplug .tb-sidebar-group { display: grid; gap: 8px; flex-shrink: 0; font-size: 13px; }
.dsh-toy-buttplug .tb-sidebar-group-title { display: flex; justify-content: space-between; gap: 8px; color: var(--dsw-alias-text-secondary); }
.dsh-toy-buttplug .tb-sidebar-group-title small { font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-toy-buttplug .tb-sidebar-group input[type=range] { width: 100%; }
.dsh-toy-buttplug .tb-sidebar-fine { display: grid; gap: 12px; min-width: 0; margin: 4px 0 0; padding: 0; border: 0; }
.dsh-toy-buttplug.tb-sidebar .tb-sidebar-fine .tb-definition { grid-template-columns: minmax(0, 1fr); gap: 4px; }
.dsh-toy-buttplug.tb-sidebar .tb-sidebar-fine .tb-definition-label small { display: inline; margin-left: 8px; }
.dsh-toy-buttplug.tb-sidebar .tb-sidebar-fine .tb-preset-tier-buttons { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dsh-toy-buttplug .tb-live-slider { display: grid; gap: 6px; min-width: 0; }
.dsh-toy-buttplug .tb-live-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-toy-buttplug .tb-live-label output { font-variant-numeric: tabular-nums; }
.dsh-toy-buttplug .tb-live-slider > input { min-width: 0; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.dsh-toy-buttplug .tb-live-slider > input[type=range] { height:24px; appearance:none; -webkit-appearance:none; background:transparent; cursor:pointer; }
.dsh-toy-buttplug .tb-live-slider > input::-webkit-slider-runnable-track { height:4px; border-radius:4px; background:linear-gradient(to right,var(--dsw-alias-brand-primary) var(--tb-speed),var(--dsw-alias-border-l4) var(--tb-speed)); }
.dsh-toy-buttplug .tb-live-slider > input::-moz-range-track { height:4px; border-radius:4px; background:var(--dsw-alias-border-l4); }
.dsh-toy-buttplug .tb-live-slider > input::-moz-range-progress { height:4px; background:var(--dsw-alias-brand-primary); }
.dsh-toy-buttplug .tb-live-slider > input::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; box-sizing:border-box; width:16px; height:16px; margin-top:-6px; border-radius:50%; border:2px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-3); }
.dsh-toy-buttplug .tb-live-slider > input::-moz-range-thumb { box-sizing:border-box; width:16px; height:16px; border-radius:50%; border:2px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-3); }
.dsh-toy-buttplug .tb-live-range { position: relative; height: 24px; margin: 0 8px; }
.dsh-toy-buttplug .tb-live-track { position: absolute; top: 10px; left: 0; right: 0; height: 4px; border-radius: 4px; pointer-events: none;
  background: linear-gradient(to right, var(--dsw-alias-border-l4, #ccc) var(--tb-low), var(--dsw-alias-brand-primary, #477be3) var(--tb-low),
    var(--dsw-alias-brand-primary, #477be3) var(--tb-high), var(--dsw-alias-border-l4, #ccc) var(--tb-high)); }
.dsh-toy-buttplug .tb-live-range input[type=range] { position: absolute; top: 0; left: -8px; width: calc(100% + 16px); height: 24px; margin: 0; padding: 0;
  border: 0; background: none; appearance: none; -webkit-appearance: none; pointer-events: none; touch-action: none; }
.dsh-toy-buttplug .tb-live-range input::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-brand-primary, #477be3); background: var(--dsw-alias-bg-layer-3, #fff); cursor: grab; pointer-events: auto; }
.dsh-toy-buttplug .tb-live-range input::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-brand-primary, #477be3); background: var(--dsw-alias-bg-layer-3, #fff); cursor: grab; pointer-events: auto; }
.dsh-toy-buttplug .tb-live-range input:focus-visible { outline: none; }
.dsh-toy-buttplug .tb-live-range input:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--dsw-alias-brand-primary, #477be3); outline-offset: 2px; }
.dsh-toy-buttplug .tb-live-range input:focus-visible::-moz-range-thumb { outline: 2px solid var(--dsw-alias-brand-primary, #477be3); outline-offset: 2px; }
.dsh-toy-buttplug .tb-live-range input:disabled::-webkit-slider-thumb { cursor: default; opacity: .5; }
.dsh-toy-buttplug .tb-live-range input:disabled::-moz-range-thumb { cursor: default; opacity: .5; }
.dsh-toy-buttplug .tb-sidebar-connection { flex-shrink: 0; font-size: 14px; }
.dsh-toy-buttplug .tb-sidebar-connection > summary { font-size: 13px; }
.dsh-toy-buttplug .tb-sidebar-connection .tb-connection-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-top: 12px; }
.dsh-toy-buttplug .tb-sidebar-connection .tb-field { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.dsh-toy-buttplug .tb-sidebar-connection .tb-field > span { flex: none; }
.dsh-toy-buttplug.tb-sidebar .tb-sidebar-connection .tb-field.qq-settings-field > :is(input, select)[aria-label] { box-sizing: border-box; flex: 0 1 auto; min-width: 0; max-width: 100%; height: 28px; min-height: 28px; padding: 0 8px; font-size: 13px; border-radius: 6px; }
.dsh-toy-buttplug .tb-sidebar-connection .tb-field select { width: 100px; }
.dsh-toy-buttplug .tb-sidebar-connection .tb-field input { width: 152px; }

.dsh-toy-buttplug .tb-sidebar-controls { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 16px; flex-shrink: 0; }
.dsh-toy-buttplug .tb-sidebar-buttons { display: flex; flex: 1 1 180px; flex-wrap: wrap; align-items: flex-start; align-content: flex-start; gap: 8px; min-width: 0; }
.dsh-toy-buttplug.tb-sidebar > .tb-connection-buttons > button { box-sizing: border-box; flex: 0 0 auto; width: auto; min-width: 80px; height: 32px; min-height: 32px; padding: 0 12px; border-radius: 6px; font-size: 13px; line-height: 1; white-space: nowrap; }
.dsh-toy-buttplug .tb-connection-buttons > button.tb-sidebar-active { color: #16a34a; border-color: #16a34a40; background: #16a34a0c; }
.dsh-toy-buttplug .tb-connection-buttons > button.tb-sidebar-active::before { content: ''; width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
.dsh-toy-buttplug .tb-sidebar-buttons .tb-live-actions { display: contents; }
.dsh-toy-buttplug .tb-stroke-control { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-text-secondary); }
.dsh-toy-buttplug .tb-stroke-rail { position: relative; height: 160px; width: 40px; }
.dsh-toy-buttplug .tb-stroke-rail input { writing-mode: vertical-lr; direction: rtl; width: 24px; height: 100%; margin: 0; position: absolute; left: 8px; touch-action: none; }
.dsh-toy-buttplug .tb-stroke-control small { font-size: 11px; font-variant-numeric: tabular-nums; }

.dsh-toy-buttplug .tb-sidebar-readout { display: grid; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l3, #8883); padding-top: 16px; overflow-wrap: anywhere; }
.dsh-toy-buttplug .tb-sidebar-readout > span { color: var(--dsw-alias-text-secondary); font-size: 12px; }
.dsh-toy-buttplug .tb-sidebar-readout > strong { font-size: 14px; font-weight: 500; }
.dsh-toy-buttplug .tb-sidebar-readout > output { font-variant-numeric: tabular-nums; font-size: 22px; }

.dsh-toy-buttplug .tb-sidebar-controls, .dsh-toy-buttplug .tb-sidebar-buttons { display: grid; width: 100%; gap: 12px; flex: none; }
.dsh-toy-buttplug .tb-connection-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-toy-buttplug .tb-sidebar-buttons .tb-live-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-toy-buttplug .tb-sidebar-controls { display: grid; grid-template-columns: minmax(0, 1fr) 44px; align-items: start; gap: 12px; }
.dsh-toy-buttplug .tb-sidebar-buttons { min-width: 0; }
.dsh-toy-buttplug .tb-stroke-control { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-top: -8px; }
.dsh-toy-buttplug .tb-stroke-rail { height: 180px; width: 32px; }
.dsh-toy-buttplug .tb-stroke-rail input { position: static; writing-mode: vertical-lr; direction: rtl; width: 32px; height: 100%; }
.dsh-toy-buttplug .tb-sidebar-connection .tb-connection-fields { margin-top: 0; }

`
