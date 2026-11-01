import type { ToySnapshot } from './controller.ts'

/** 只解释本页状态；读取不能发包、续期或改变动作。 */
export function linkageStatus(toy: ToySnapshot, session: string): { label: string; detail: string } {
  const mine = toy.owner === session
  const notice = toy.noticeSession === undefined || toy.noticeSession === session ? toy.notice : ''
  const failure = toy.loadError || toy.transport.error
  const result = (label: string, detail = '') => ({ label, detail: failure || detail })
  if (!toy.enabled) return result('联动不可用', toy.conflict || notice || '联动已关闭')
  if (!toy.settings?.authorized) return result('尚未授权', '请先前往设置完成授权。')
  if (toy.transport.phase === 'connecting') return result('正在连接', toy.transport.message)
  if (toy.transport.phase === 'disconnected') return result('未连接', notice || '请连接设备服务。')
  if (toy.transport.phase === 'waiting') return result('等待位移设备', toy.transport.message)
  if (!mine) return result(toy.owner === undefined ? '未接入对话' : '其他会话正在联动', notice || '连接完成后，还需接入当前对话。')
  if (!toy.qqbot || !toy.segments) return result('联动服务暂不可用', !toy.qqbot ? '联动服务暂不可用' : '分段显示暂不可用')
  if (toy.paused) return result('已暂停', notice)
  if (toy.moving) return result('运行中', notice)
  switch (toy.activity) {
    case 'no-motion': return result('未收到动作', '本段没有动作，也没有可沿用的动作。可以明确要求角色开始；自主性在角色设置中调整。')
    case 'model-stop': return result('AI 已停止', notice || '本段要求停止，等待新的动作。')
    case 'invalid': return result('动作无效', notice)
    case 'timeout': return result('保护停止', notice)
    case 'error': return result('动作异常', notice)
    default: return result('等待动作', notice)
  }
}
