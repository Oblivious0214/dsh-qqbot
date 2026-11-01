/**
 * 头像和背景的裁剪弹窗：拖动取景、滚轮或滑条缩放（0.1–4 倍）、键盘方向键移动取景框和 +/- 缩放、重置取景。
 * 头像固定 1:1；背景的比例可选当前对话比例、16:9、4:3、9:16、原图比例。
 *
 * 迁移自 dsh-qq-skin（MIT，lispking）的 src/client/image-editor.ts，按本插件重写：
 * - 界面用 DSH 的 Modal 和 Button，叠在设置窗口上面时 Esc 只关裁剪弹窗。
 * - 选图在打开弹窗之前（用户点"上传头像"等按钮时选），弹窗里可以"换一张"。
 * - "恢复默认"不在弹窗里，留在原来的表单按钮（改回首字、去掉背景）。
 * - 输出尺寸和格式见 images.ts。cropper.css 在构建时加上 CROPPER_CLASS 前缀（tsdown.config.ts）。
 *
 * 用到 Cropper.js 1.6.2（MIT，Chen Fengyuan），打包进 client.js，不从 CDN 加载。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Cropper from 'cropperjs'
import cropperCss from 'virtual:cropper-css'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { checkImageFile, encodeImage, outputSize, SOURCE_PIXEL_LIMIT, type ImageKind } from './images.ts'

/** 与 tsdown.config.ts 的 CROPPER_CLASS 一致。 */
export const CROPPER_CLASS = 'dsh-qqbot-cropper'

const RATIOS = [
  { value: 'current', label: '当前对话比例' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '9:16', label: '9:16' },
  { value: 'original', label: '原图比例' },
] as const
type RatioChoice = typeof RATIOS[number]['value']

const ZOOM_MIN = 0.1
const ZOOM_MAX = 4

/** 聊天区的宽高比；设置窗口后面没有打开的对话时按 16:9。 */
function conversationRatio(): number {
  const rect = document.querySelector('[data-conversation-scroll]')?.getBoundingClientRect()
  return rect !== undefined && rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 16 / 9
}

function ratioOf(kind: ImageKind, choice: RatioChoice, imageRatio: number, current: number): number {
  if (kind === 'avatar') return 1
  if (choice === 'original') return imageRatio
  if (choice === 'current') return current
  const [w, h] = choice.split(':').map(Number)
  return w! / h!
}

export interface ImageCropperProps {
  readonly kind: ImageKind
  readonly file: File
  readonly busy: boolean
  /** 保存失败时的错误，由调用方给出。 */
  readonly error: string | undefined
  readonly onChangeFile: (file: File) => void
  readonly onCancel: () => void
  /** 收到裁好的 data URL。 */
  readonly onSave: (data: string) => void
}

export function ImageCropper({ kind, file, busy, error, onChangeFile, onCancel, onSave }: ImageCropperProps) {
  const host = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const cropper = useRef<Cropper | undefined>(undefined)
  const initialZoom = useRef(1)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [choice, setChoice] = useState<RatioChoice>('current')
  const [imageRatio, setImageRatio] = useState(1)
  const [problem, setProblem] = useState<string | undefined>()
  const current = useMemo(conversationRatio, [])
  const aspectRatio = ratioOf(kind, choice, imageRatio, current)
  // 建 Cropper 时按当时的比例；之后改比例由下面单独的 effect 处理，不重建。
  const aspectRef = useRef(aspectRatio)
  aspectRef.current = aspectRatio
  const choiceRef = useRef(choice)
  choiceRef.current = choice

  // 每换一张图重建一次 Cropper。图片节点由这里创建，不归 React 管：Cropper 会改它的样式并在旁边插入自己的节点。
  useEffect(() => {
    const target = host.current
    if (target === null) return
    setReady(false)
    setProblem(undefined)
    try { checkImageFile(file) } catch (caught) { setProblem(caught instanceof Error ? caught.message : String(caught)); return }
    const url = URL.createObjectURL(file)
    const image = document.createElement('img')
    image.alt = kind === 'avatar' ? '头像原图' : '背景原图'
    let disposed = false
    image.onerror = () => { if (!disposed) setProblem('读不了这张图片') }
    image.onload = () => {
      if (disposed) return
      if (image.naturalWidth * image.naturalHeight > SOURCE_PIXEL_LIMIT) { setProblem('图片像素太多，请换一张'); return }
      const ratio = image.naturalWidth / image.naturalHeight
      setImageRatio(ratio)
      const instance = new Cropper(image, {
        aspectRatio: kind === 'background' && choiceRef.current === 'original' ? ratio : aspectRef.current,
        viewMode: 1, dragMode: 'move', autoCropArea: 0.75,
        background: true, modal: true, guides: true, center: true,
        cropBoxMovable: true, cropBoxResizable: true, toggleDragModeOnDblclick: false,
        rotatable: false, scalable: false,
        minContainerWidth: 100, minContainerHeight: 100,
        ready() {
          if (disposed) return
          const canvas = instance.getCanvasData()
          initialZoom.current = canvas.width / canvas.naturalWidth
          setZoom(1)
          setReady(true)
        },
        zoom(event) {
          const next = event.detail.ratio / initialZoom.current
          // 超出滑条范围时拦下，和滑条的上下限一致。
          if (next < ZOOM_MIN || next > ZOOM_MAX) { event.preventDefault(); return }
          setZoom(next)
        },
      })
      cropper.current = instance
    }
    target.replaceChildren(image)
    image.src = url
    return () => {
      disposed = true
      cropper.current?.destroy()
      cropper.current = undefined
      target.replaceChildren()
      URL.revokeObjectURL(url)
    }
  }, [file, kind])

  useEffect(() => { if (ready) cropper.current?.setAspectRatio(aspectRatio) }, [ready, aspectRatio])

  const reset = () => { cropper.current?.reset(); setZoom(1) }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const instance = cropper.current
    if (instance === undefined || !ready || busy || event.target !== event.currentTarget) return
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const delta = arrows[event.key]
    if (delta !== undefined) {
      event.preventDefault()
      const box = instance.getCropBoxData()
      const step = event.shiftKey ? 10 : 1
      instance.setCropBoxData({ left: box.left + delta[0] * step, top: box.top + delta[1] * step })
    } else if (['+', '=', '-', '−'].includes(event.key)) {
      event.preventDefault()
      instance.zoom(event.key === '-' || event.key === '−' ? -0.1 : 0.1)
    }
  }

  const save = () => {
    const instance = cropper.current
    if (instance === undefined || !ready || busy) return
    try {
      const rect = instance.getData(true)
      if (!(rect.width > 0 && rect.height > 0)) throw new Error('取景范围是空的')
      const size = outputSize(kind, rect.width, rect.height)
      const canvas = instance.getCroppedCanvas({
        ...size,
        // JPEG 没有透明，背景超出原图的部分填白；头像是 PNG，留透明。
        fillColor: kind === 'avatar' ? 'transparent' : '#fff',
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      })
      setProblem(undefined)
      onSave(encodeImage(kind, canvas))
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const message = problem ?? error
  const title = kind === 'avatar' ? '裁剪头像' : '裁剪背景'
  return <Modal open onClose={() => { if (!busy) onCancel() }} title={title} closeLabel="关闭" className={CROPPER_CLASS}
    description={kind === 'avatar'
      ? '拖动图片取景，滚轮或滑条缩放。头像固定为正方形，显示时裁成圆形。'
      : '拖动图片或取景框取景，滚轮或滑条缩放，拖动取景框边角调整范围。'}
    footer={<div className="qc-footer">
      <Button size="sm" variant="outline" className="qc-reset" disabled={!ready || busy} onClick={reset}>重置取景</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
      <Button size="sm" variant="primary" disabled={!ready || busy} onClick={save}>{busy ? '正在保存…' : '裁剪并保存'}</Button>
    </div>}>
    <div className="qc-toolbar">
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden
        onChange={(event) => { const next = event.target.files?.[0]; event.target.value = ''; if (next !== undefined) onChangeFile(next) }} />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { picker.current?.click() }}>换一张</Button>
      <span className="qc-name">{file.name}</span>
      {kind === 'background' && <label className="qc-ratio">
        <span>裁剪比例</span>
        <select value={choice} disabled={busy}
          onChange={(event) => { const next = RATIOS.find(r => r.value === event.target.value); if (next !== undefined) setChoice(next.value) }}>
          {RATIOS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>}
    </div>
    <div ref={host} className="qc-stage" tabIndex={0} role="region" aria-label={kind === 'avatar' ? '头像取景' : '背景取景'}
      data-modal-autofocus="" onKeyDown={onKeyDown} />
    <label className="qc-zoom">
      <span>缩放</span>
      <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.01} value={zoom} disabled={!ready || busy}
        onChange={(event) => { cropper.current?.zoomTo(Number(event.target.value) * initialZoom.current) }} />
    </label>
    {message !== undefined && <div className="qc-error" role="status">{message}</div>}
  </Modal>
}

/** 弹窗样式，全部在 CROPPER_CLASS 下；Cropper.js 自带的样式也在这个前缀下。 */
export const CROPPER_CSS = `${cropperCss}
[role="dialog"].${CROPPER_CLASS} { width: min(720px, 100%); max-height: 100%; font-size: 14px; line-height: 22px; }
.${CROPPER_CLASS} .qc-footer { width: 100%; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.${CROPPER_CLASS} .qc-footer button, .${CROPPER_CLASS} .qc-toolbar button { font-size: 14px; line-height: 22px; min-height: 36px; }
.${CROPPER_CLASS} .qc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.${CROPPER_CLASS} .qc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${CROPPER_CLASS} .qc-ratio { display: flex; align-items: center; gap: 6px; font-size: 14px; }
.${CROPPER_CLASS} .qc-ratio select { font: inherit; padding: 4px 8px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: inherit; }
.${CROPPER_CLASS} .qc-stage { position: relative; height: clamp(160px, 42vh, 380px); overflow: hidden; border-radius: 12px; background: #151b24; touch-action: none; }
.${CROPPER_CLASS} .qc-stage > img { display: block; max-width: 100%; max-height: 100%; }
.${CROPPER_CLASS} .qc-stage:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
.${CROPPER_CLASS} .cropper-modal { opacity: .68; }
.${CROPPER_CLASS} .cropper-view-box { outline: 2px solid var(--dsw-alias-brand-primary); outline-color: var(--dsw-alias-brand-primary); }
.${CROPPER_CLASS} .cropper-line, .${CROPPER_CLASS} .cropper-point { background-color: var(--dsw-alias-brand-primary); }
.${CROPPER_CLASS} .cropper-point { width: 7px; height: 7px; opacity: 1; }
.${CROPPER_CLASS} .qc-zoom { display: flex; align-items: center; gap: 10px; margin-top: 14px; font-size: 14px; }
.${CROPPER_CLASS} .qc-zoom input { flex: 1; accent-color: var(--dsw-alias-brand-primary); }
.${CROPPER_CLASS} .qc-error { margin-top: 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-warn-label); }
.${CROPPER_CLASS} .qc-reset { margin-right: auto; }
`
