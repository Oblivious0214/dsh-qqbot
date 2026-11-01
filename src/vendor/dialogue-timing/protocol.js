// Shared display envelope. Motion extensions are opaque here; only the device
// plugin may interpret them, after its separate session authorization checks.
export const SEGMENT_PROMPT = `QQ 分段：
已开启分段回复。需要分成几条消息发送时，使用一个 [qq] JSON 块，正文放在 stages 的 text 中，不在块外重复：
[qq]{"version":1,"stages":[{"text":"先说这一句。"},{"text":"稍等一下，再接着说。"},{"text":"最后这一段。"}]}[/qq]
每个 text 是一个完整气泡，可以含一句或多句话，最多 20 段。默认不写时长字段，段落间隔由插件按用户设置自动安排；无需分段时直接正常回复。
整个回复只输出一个 [qq] 块，不放在代码块或引用中，开头和结尾始终用方括号 [qq] 和 [/qq]。只有得到其他已启用功能的规则时，才在对应段落添加其扩展字段。`;

// Tolerance for the slips flash-class models make (all readers share it, so display and device agree):
// - tag variants <qq>…</qq>, 【qq】, ［QQ］, odd case or spacing become [qq] / [/qq];
// - a reply whose only block sits in a code fence, inline code or a quote is unwrapped;
// - bare JSON without tags (also inside a ```json fence) is read as a block;
// - several blocks are merged; a missing [/qq] is the caller's decision (finished reply = complete);
// - envelope: version may be missing or anything, extra keys are ignored, a top-level stages array
//   or a single stage object also works, more than 20 stages are cut at 20;
// - stages: a plain string is a text stage, content/message stand in for text, empty stages without
//   motion are dropped, stray [qq]/[dsh] tags inside text are removed, voice may be the string "true";
// - JSON: raw newlines and tabs in strings, unescaped quotes inside text, bad backslashes and
//   trailing commas are repaired. Nothing is ever invented: no stage, motion or string is closed early.
// Motion stays opaque here and is validated by the device plugin as usual.
const TAG_VARIANT = /[[<【［]\s*(\/?)\s*qq\s*[\]>】］]/gi;
export function normalizeTags(text) {
  return text.replace(TAG_VARIANT, (_, slash) => `[${slash}qq]`);
}
const MAX_STAGES = 20;
function stripCodeAndQuotes(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
}
// Fence and quote markers go, their content stays. Only used when no block exists outside them.
function unwrapCodeAndQuotes(text) {
  return text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, '').replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/`+(\[\/?qq\])|(\[\/?qq\])`+/g, '$1$2');
}
const BARE_STARTS = ['{"version"', '{"stages"', '[{"text"'];
function bareStart(text) {
  const head = text.trimStart().slice(0, 40).replace(/\s+/g, '');
  return head !== '' && BARE_STARTS.some(start => head.startsWith(start) || start.startsWith(head));
}
function prepare(text) {
  const tagged = normalizeTags(text);
  const strict = stripCodeAndQuotes(tagged);
  if (strict.includes('[qq]')) return { source: strict, loose: false };
  const loose = unwrapCodeAndQuotes(tagged);
  if (loose.includes('[qq]')) return { source: loose, loose: true };
  if (!bareStart(loose)) return { source: strict, loose: false };
  const whole = loose.trim(), body = whole.replace(/\[\/qq\]$/, '');
  const closed = body.length < whole.length || parseLoose(body) !== undefined;
  return { source: `[qq]${body}${closed ? '[/qq]' : ''}`, loose: true };
}
/** The reply as the readers see it: tags normalized, code and quotes dropped (or unwrapped), bare JSON tagged. */
export function proseOnly(text) {
  return prepare(text).source;
}
/** Whether the reply holds, or is starting, a [qq] block; the display hides raw JSON while it does. */
export function hasTimedBlock(text) {
  return proseOnly(text).includes('[qq]') || PARTIAL_TAG.test(text);
}
// A tag still being typed at the very end. A lone "<" is left alone, it ends emoticons like >_<.
const PARTIAL_TAG = /(?:[[【［]\s*\/?\s*(?:q(?:q\s*[\]>】］]?)?)?|<\s*\/?\s*q(?:q\s*>?)?)$/i;

function nextNonSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i < s.length ? i : -1;
}
// A quote inside a string closes it only when , : } ] follows, or the input ends (atEnd).
function closesString(s, i, atEnd) {
  const j = nextNonSpace(s, i);
  return j === -1 ? atEnd : ',:}]'.includes(s[j]);
}
function repairJson(s) {
  let out = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') {
        const next = s[i + 1];
        if (next !== undefined && '"\\/bfnrtu'.includes(next)) { out += ch + next; i++; } else out += '\\\\';
      } else if (ch === '"') {
        if (closesString(s, i + 1, true)) { quoted = false; out += ch; } else out += '\\"';
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch >= ' ') out += ch;
    } else if (ch === '"') { quoted = true; out += ch; }
    else if (ch === ',') {
      const j = nextNonSpace(s, i + 1);
      if (j === -1 || (s[j] !== '}' && s[j] !== ']')) out += ch;
    } else out += ch;
  }
  return out;
}
function parseLoose(s) {
  try { return JSON.parse(s); } catch { /* repair below */ }
  try { return JSON.parse(repairJson(s)); } catch { return undefined; }
}
// Stages keep only text, an explicit voice=true, tone and motion. Other fields a model adds (seconds, durationMs, emotion…)
// are dropped instead of failing the reply; motion stays for the device plugin to check. Stage timing belongs to the
// display clock, so a duration the model wrote inside motion (seconds, cycles) is dropped and the rest kept as written.
function motionOf(stage) {
  const motion = stage.motion;
  if (motion && typeof motion === 'object' && !Array.isArray(motion)
    && (Object.hasOwn(motion, 'seconds') || Object.hasOwn(motion, 'cycles'))) {
    const { seconds: _s, cycles: _c, ...rest } = motion;
    return rest;
  }
  return motion;
}
// tone: a short delivery description for the voice service. Brackets and line breaks are removed so a
// service that wraps it as [tone] keeps a single cue.
export const TONE_LIMIT = 40;
export function toneOf(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\[\]【】\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TONE_LIMIT).trim();
}
const TEXT_KEYS = ['text', 'content', 'message'];
const STRAY_TAGS = /\[\/?(?:qq|dsh)\]/g;
// Raw items (strings or objects) to stages. Throws only on an item that cannot be a stage, or a
// stage with motion but no text: dropping it could swallow a stop, so the reply fails instead.
function cleanStages(items) {
  const stages = [];
  for (const item of items.slice(0, MAX_STAGES)) {
    const stage = typeof item === 'string' ? { text: item } : item;
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw Error('段落格式无效。');
    const key = TEXT_KEYS.find(k => typeof stage[k] === 'string');
    const text = key === undefined ? '' : stage[key].replace(STRAY_TAGS, '').slice(0, 4000);
    if (!text.trim()) {
      if (Object.hasOwn(stage, 'motion')) throw Error('段落格式无效。');
      continue;
    }
    const kept = { text };
    if (stage.voice === true || stage.voice === 'true') kept.voice = true;
    const tone = toneOf(stage.tone);
    if (tone) kept.tone = tone;
    if (Object.hasOwn(stage, 'motion')) kept.motion = motionOf(stage);
    stages.push(kept);
  }
  return stages;
}
// The stage list inside a parsed block, whatever envelope the model wrapped it in.
function envelopeItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.stages)) return value.stages;
    if (TEXT_KEYS.some(k => typeof value[k] === 'string')) return [value];
  }
  if (typeof value === 'string') return [value];
  return undefined;
}

// Items of a closed block. Plain text between the tags is one stage. An unfinished envelope is
// completed only after a fully closed stage (never a stage, motion or string).
function closedItems(body) {
  const trimmed = body.trim();
  if (!/^[{["]/.test(trimmed)) return trimmed ? [trimmed] : [];
  for (const suffix of ['', ']}', '}', ']']) {
    const items = envelopeItems(parseLoose(trimmed + suffix));
    if (items) return items;
  }
  throw Error('分段回复格式无效。');
}

/** A complete reply: every [qq] block closed (or the caller treats the reply as finished). */
export function parseTimedReply(text) {
  const stream = parseTimedStream(text);
  return stream && stream.complete ? { version: 1, stages: stream.stages } : null;
}

// End of the JSON value starting at i, or -1 while it is still arriving. Quotes close strings by
// the same rule as repairJson, so streaming and the final parse cut stages at the same places.
function valueEnd(s, i) {
  if (s[i] === '"') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '"' && closesString(s, j + 1, false)) return j + 1;
    }
    return -1;
  }
  let depth = 0, quoted = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (quoted) {
      if (ch === '\\') j++;
      else if (ch === '"' && closesString(s, j + 1, false)) quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth === 0) return j + 1;
  }
  return -1;
}
// Closed stages of a block still arriving: a top-level array, or the array under "stages".
function streamItems(body) {
  const head = /^\s*\[/.exec(body) ?? /^\s*\{[^[]*?"stages"\s*:\s*\[/.exec(body);
  if (!head) return [];
  const items = [];
  let i = head[0].length;
  while (items.length < MAX_STAGES) {
    i = nextNonSpace(body, i);
    if (i === -1 || (body[i] !== '{' && body[i] !== '"')) break;
    const end = valueEnd(body, i);
    if (end === -1) break;
    const item = parseLoose(body.slice(i, end));
    if (item === undefined) throw Error('分段回复格式无效。');
    items.push(item);
    i = nextNonSpace(body, end);
    if (i === -1 || body[i] !== ',') break;
    i++;
  }
  return items;
}

// Streaming read: the stages of a reply that may still be arriving. Blocks are merged in order;
// complete means every block has closed. Returns null when there is no block or no stage yet;
// throws on a stage that cannot be read or a closed block without any stage.
// A reply that ended without [/qq] is the caller's decision.
export function parseTimedStream(text) {
  const source = proseOnly(text);
  if (!source.includes('[qq]')) return null;
  if (source.length > 100000) throw Error('分段回复过长。');
  const items = [];
  let complete = true;
  for (const [, body, close] of source.matchAll(/\[qq\]([\s\S]*?)(\[\/qq\]|$)/g)) {
    if (close === '[/qq]') { items.push(...closedItems(body)); continue; }
    complete = false;
    items.push(...streamItems(body));
  }
  const stages = cleanStages(items);
  if (!stages.length) {
    if (complete) throw Error('分段回复格式无效。');
    return null;
  }
  return { stages, complete };
}

// A reply that has finished generating: a block left open counts as closed. The open block is
// first read as if [/qq] followed (plain text, or an envelope missing only its end); when that
// fails, the stages already closed while streaming are kept. A stage is never closed for the model.
export function parseFinishedReply(text) {
  const stream = parseTimedStream(text);
  if (stream?.complete) return stream;
  if (!proseOnly(text).includes('[qq]')) return stream;
  try {
    // On its own line, so a trailing fence line can still be unwrapped.
    const closed = parseTimedStream(`${text}\n[/qq]`);
    if (closed && stream?.stages.every((stage, i) => closed.stages[i]?.text === stage.text) !== false) return closed;
  } catch { /* keep what streaming read */ }
  return stream && { stages: stream.stages, complete: true };
}

// Best-effort text when the blocks still do not parse after repair. Only text survives: motion
// is dropped, and every stage is marked salvaged so the device plugin stops instead
// of guessing. A text value ends at the quote followed by `,"key":` or `}`.
// Returns null when the reply parses (normal rules decide), has no block, or yields no text.
export function salvageTimedReply(text) {
  const source = proseOnly(text);
  if (!source.includes('[qq]') || source.length > 100000) return null;
  try { if (parseFinishedReply(text)) return null; } catch { /* salvage below */ }
  const stages = [];
  const key = /"(?:text|content|message)"\s*:\s*"/g;
  const end = /"(?=\s*(?:,\s*"[A-Za-z_]+"\s*:|\}))/g;
  const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  for (let m; (m = key.exec(source)) && stages.length < MAX_STAGES;) {
    end.lastIndex = m.index + m[0].length;
    let close;
    while ((close = end.exec(source)) && source[close.index - 1] === '\\') { /* escaped quote */ }
    if (!close) break;
    const value = source.slice(m.index + m[0].length, close.index).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g,
      (_, c) => c[0] === 'u' ? String.fromCharCode(parseInt(c.slice(1), 16)) : escapes[c] ?? c)
      .replace(STRAY_TAGS, '').slice(0, 4000);
    if (value.trim()) stages.push({ text: value, salvaged: true });
    key.lastIndex = close.index + 1;
  }
  return stages.length ? { version: 1, stages } : null;
}

export function stripTimedReply(text) {
  const { source, loose } = prepare(text);
  const stripped = source.replace(/\[qq\][\s\S]*?(?:\[\/qq\]|$)/g, '');
  // Strict mode keeps code and quotes in the display, so strip from the tag-normalized original.
  const shown = loose ? stripped : normalizeTags(text).replace(/\[qq\][\s\S]*?(?:\[\/qq\]|$)/g, '');
  return shown.replace(PARTIAL_TAG, '');
}
