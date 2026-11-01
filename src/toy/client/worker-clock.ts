import type { Clock } from './player.ts'

/** 独立函数会原样放进 Blob；不得引用模块变量或导入。 */
function timerWorker(): void {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<{ id: number; ms?: number }>) => void
    postMessage: (id: number) => void
  }
  scope.onmessage = ({ data: { id, ms } }) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    if (ms === undefined) return
    timers.set(id, setTimeout(() => {
      timers.delete(id)
      scope.postMessage(id)
    }, ms))
  }
}

export type TimerWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>

function createTimerWorker(): TimerWorker {
  const url = URL.createObjectURL(new Blob([`(${timerWorker.toString()})()`], { type: 'text/javascript' }))
  try { return new Worker(url, { name: 'qqbot-motion-clock' }) }
  finally { URL.revokeObjectURL(url) }
}

/**
 * 设备模块独占的单次计时器。窗口后台的 timer 对齐不再拉长每一包运动。
 * 消息只唤醒当前有效回调，不补发积压动作；暂停/停止可撤销已在消息队列中的唤醒。
 * 闲置不轮询，首次运动才创建 Worker，卸载时释放。页面冻结或系统休眠仍不能继续运行。
 */
export class WorkerClock implements Clock {
  private worker: TimerWorker | undefined
  private readonly callbacks = new Map<number, () => void>()
  private nextId = 0
  private disposed = false

  constructor(
    private readonly onError: () => void,
    private readonly createWorker: () => TimerWorker = createTimerWorker,
  ) {}

  now(): number { return performance.now() }

  set(callback: () => void, ms: number): number {
    if (this.disposed) throw new Error('设备计时器已关闭')
    const id = ++this.nextId
    try {
      if (this.worker === undefined) {
        const worker = this.createWorker()
        this.worker = worker
        worker.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (this.worker !== worker || typeof data !== 'number') return
          const run = this.callbacks.get(data)
          this.callbacks.delete(data)
          run?.()
        }
        worker.onerror = (event) => { event.preventDefault(); this.fail(worker) }
        worker.onmessageerror = () => { this.fail(worker) }
      }
      this.callbacks.set(id, callback)
      this.worker.postMessage({ id, ms })
    } catch {
      // 让当前播放器调用先返回，再统一停止和断开，避免同步重入 reveal()/pump()。
      this.release()
      queueMicrotask(() => { if (!this.disposed) this.onError() })
    }
    return id
  }

  clear(handle: unknown): void {
    if (typeof handle !== 'number' || !this.callbacks.delete(handle)) return
    try { this.worker?.postMessage({ id: handle }) }
    catch { this.fail(this.worker) }
  }

  private fail(worker: TimerWorker | undefined): void {
    if (worker !== this.worker || this.disposed) return
    this.release()
    this.onError()
  }

  private release(): void {
    const worker = this.worker
    this.worker = undefined
    this.callbacks.clear()
    if (worker !== undefined) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      worker.terminate()
    }
  }

  dispose(): void {
    this.disposed = true
    this.release()
  }
}
