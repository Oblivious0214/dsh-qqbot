// Shared display envelope. Motion extensions are opaque here; only the device
// plugin may interpret them, after its separate session authorization checks.
export const SEGMENT_PROMPT = `QQ 分段：
已开启分段回复。需要分成几条消息发送时，使用一个 [qq] JSON 块，正文放在 stages 的 text 中，不在块外重复：
[qq]{"version":1,"stages":[{"text":"先说这一句。"},{"text":"稍等一下，再接着说。"},{"text":"最后这一段。"}]}[/qq]
每个 text 是一个完整气泡，可以含一句或多句话，最多 20 段。段落之间的间隔由界面决定；无需分段时直接正常回复。
整个回复只输出一个 [qq] 块，不放在代码块或引用中。只有得到其他已启用功能的规则时，才在对应段落添加其扩展字段。此分段协议本身不授权任何设备动作。`;

export function proseOnly(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
}
// Stages keep only text, cycles and motion. Other fields a model adds (durationMs, emotion…)
// and an invalid cycles are dropped instead of failing the reply; motion stays for the device plugin to check.
export function parseTimedReply(text) {
  const matches = [...proseOnly(text).matchAll(/\[qq\]([\s\S]*?)\[\/qq\]/g)];
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0][1].length > 30000) throw Error('分段回复格式无效。');
  let value;
  try { value = JSON.parse(matches[0][1]); } catch { throw Error('分段回复格式无效。'); }
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'stages,version'
    || !Array.isArray(value.stages) || !value.stages.length || value.stages.length > 20) throw Error('分段回复格式无效。');
  const stages = value.stages.map(stage => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)
      || typeof stage.text !== 'string' || !stage.text.trim() || stage.text.length > 4000
      || /\[\/?(?:qq|dsh)\]/.test(stage.text))
      throw Error('段落格式无效。');
    const kept = { text: stage.text };
    if (Number.isInteger(stage.cycles) && stage.cycles >= 1 && stage.cycles <= 100) kept.cycles = stage.cycles;
    if (Object.hasOwn(stage, 'motion')) kept.motion = stage.motion;
    return kept;
  });
  return { version: 1, stages };
}

// Streaming read: the closed stages of a reply that may still be arriving.
// The prompt writes "version" before "stages", so stages can be read as they close.
// Returns null until one stage has closed; throws on invalid stages or a malformed complete block.
// A reply that ended without [/qq] is the caller's decision.
export function parseTimedStream(text) {
  const source = proseOnly(text);
  if (source.includes('[/qq]')) {
    const reply = parseTimedReply(source);
    return reply && { stages: reply.stages, complete: true };
  }
  const match = /\[qq\]\s*\{\s*"version"\s*:\s*1\s*,\s*"stages"\s*:\s*\[/.exec(source);
  if (!match) return null;
  if (source.length > 100000) throw Error('分段回复过长。');
  const stages = [];
  let i = match.index + match[0].length;
  while (i < source.length) {
    while (/\s/.test(source[i] ?? '')) i++;
    if (source[i] !== '{') break;
    const start = i;
    let depth = 0, quoted = false, escaped = false, closed = false;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) { i++; closed = true; break; }
      }
    }
    if (!closed) break;
    try { stages.push(JSON.parse(source.slice(start, i))); } catch { throw Error('分段回复格式无效。'); }
    while (/\s/.test(source[i] ?? '')) i++;
    if (source[i] !== ',') break;
    i++;
  }
  if (!stages.length) return null;
  // Closed stages pass the same checks as a complete reply.
  return { stages: parseTimedReply(`[qq]${JSON.stringify({ version: 1, stages })}[/qq]`).stages, complete: false };
}

export function stripTimedReply(text) {
  return text.replace(/\[qq\][\s\S]*?(?:\[\/qq\]|$)/g, '')
    .replace(/\[(?:q(?:q(?:\])?)?)?$/g, '');
}
