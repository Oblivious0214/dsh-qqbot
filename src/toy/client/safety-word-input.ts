interface UserInput { id: string; seq: number; rpcId?: string; text: string }
interface Reply { turn: number; step: number; seq?: number }
interface ChatActivity { users: UserInput[]; replies: Reply[]; partial: Reply | null }

/** 与原生发送回显共用 requestId；首次只建基线，翻历史和回显落盘不重复触发。 */
export class SafetyWordInput {
  private initialized = false
  private seq = -1
  private readonly requests = new Set<string>()
  private previous: ChatActivity | undefined

  observe(chat: string, submissions: string, send: (text: string, replies: readonly string[]) => void): void {
    const activity = JSON.parse(chat) as ChatActivity
    const pending = JSON.parse(submissions) as { requestId: string; text: string }[]
    const old = [...this.previous?.replies ?? [], ...this.previous?.partial ? [this.previous.partial] : []]
    const replies = old.map(reply => `${reply.turn}:${reply.step}`)
    for (const entry of pending) {
      if (this.initialized && !this.requests.has(entry.requestId)) send(entry.text, replies)
      this.requests.add(entry.requestId)
    }
    for (const user of activity.users) {
      if (this.initialized && user.seq > this.seq && (!user.rpcId || !this.requests.has(user.rpcId))) {
        send(user.text, [...replies, ...activity.replies.filter(reply => (reply.seq ?? Infinity) < user.seq).map(reply => `${reply.turn}:${reply.step}`)])
      }
      this.seq = Math.max(this.seq, user.seq)
      if (user.rpcId) this.requests.add(user.rpcId)
    }
    this.initialized = true
    this.previous = activity
  }
}
