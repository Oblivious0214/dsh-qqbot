// DSH rc.3: pendingSubmissions begins at send, legacy user/steering nodes at admission.
// Draft edits are deliberately absent. rpcId joins the echo to its durable message.
export function chatActivity(snapshot) {
  const nodes = snapshot?.legacy?.nodes || [];
  return JSON.stringify({ users: nodes.filter(n => n.kind === 'user' || n.kind === 'steering')
    .map(n => ({ id: n.messageId, kind: n.kind, seq: n.seq, rpcId: n.source?.rpcId, text: n.text ?? (n.blocks || []).filter(b => b.kind === 'text').map(b => b.text).join('') })),
    replies: nodes.filter(n => n.kind === 'assistant').map(n => ({ turn: n.turn, step: n.step, seq: n.seq })),
    partial: snapshot?.legacy?.partial ? { turn: snapshot.legacy.partial.turn, step: snapshot.legacy.partial.step } : null });
}
export function submissionActivity(snapshot) {
  return JSON.stringify((snapshot?.pendingSubmissions || []).map(n => ({ requestId: n.requestId, placement: n.placement, text: n.text })));
}
const later = (a, b) => a.turn > b.turn || a.turn === b.turn && a.step > b.step;
export class Interruptions {
  constructor() { this.sessions = new Map(); }
  observe(id, chat, submissions) {
    const activity = JSON.parse(chat), pending = JSON.parse(submissions);
    let state = this.sessions.get(id);
    const first = !state;
    if (!state) { state = { seq: -1, requests: new Set(), cutoff: null }; this.sessions.set(id, state); }
    let changed = false, wholeTurn = false, userSeq = Infinity, local = false;
    const previous = state.activity;
    state.activity = activity;
    for (const entry of pending) {
      const request = typeof entry === 'string' ? entry : entry.requestId;
      if (!state.requests.has(request)) {
        changed = true; local = true;
        if (entry.placement !== 'steering') wholeTurn = true;
      }
      state.requests.add(request);
    }
    for (const user of activity.users) {
      if (user.seq > state.seq && (!user.rpcId || !state.requests.has(user.rpcId))) {
        changed = true; userSeq = Math.min(userSeq, user.seq);
        if (user.kind !== 'steering') wholeTurn = true;
      }
      state.seq = Math.max(state.seq, user.seq ?? -1);
      if (user.rpcId) state.requests.add(user.rpcId);
    }
    if (first || !changed) return false;
    // Admission and a fast answer may arrive in one publication: only supersede
    // the pre-send request, never the new answer already present in that batch.
    const candidates = local ? [...(previous?.replies || []), previous?.partial]
      : [...activity.replies.filter(reply => reply.seq < userSeq), previous?.partial];
    for (const reply of candidates.filter(Boolean)) {
      const boundary = { turn: reply.turn, step: wholeTurn ? Infinity : reply.step };
      if (!state.cutoff || later(boundary, state.cutoff)) state.cutoff = boundary;
    }
    return true;
  }
  blocked(id, reply) {
    const cutoff = this.sessions.get(id)?.cutoff;
    return !!cutoff && Number.isFinite(reply?.turn) && Number.isFinite(reply?.step) && !later(reply, cutoff);
  }
}
