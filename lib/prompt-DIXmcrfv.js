import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
// src/storage.ts
/**
* dsh-qqbot 的数据目录和 JSON 读写。数据放在 `<DSH_HOME>/qqbot/`，不和旧插件共用文件。
* 用同步 I/O：文件都很小，读只在启动和用户命令时发生；提示词组装是同步的，不能等异步加载。
*/
/** DSH 的数据根目录。空的 DSH_HOME 视为未设置，否则路径会相对于进程工作目录。 */
function dshHome() {
	const configured = process.env["DSH_HOME"]?.trim() ?? "";
	return configured === "" ? join(homedir(), ".dsh") : configured;
}
/** 本插件的数据目录：`<DSH_HOME>/qqbot`。 */
function dataDir(home = dshHome()) {
	return join(home, "qqbot");
}
/**
* 读一个 JSON 文件。不存在时返回 undefined；读不了或格式错时警告，
* 坏文件改名为 `.corrupt` 留给用户检查，下次写入从空状态开始。
*/
function readJson(file, warn) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") warn(`qqbot: 读不了 ${file}：${String(error)}`);
		return;
	}
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		warn(`qqbot: ${file} 不是有效的 JSON，已改名为 ${file}.corrupt`);
		try {
			renameSync(file, `${file}.corrupt`);
		} catch {}
		return;
	}
}
function writeJson(file, value) {
	writeText(file, `${JSON.stringify(value, void 0, 2)}\n`);
}
/** 写到同目录的临时文件再改名，读者不会看到写了一半的文件。 */
function writeText(file, text) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, "utf8");
		renameWithRetry(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
/** Windows 上目标文件被杀毒或编辑器短暂占用时 rename 会报 EPERM/EACCES/EBUSY，稍等重试几次。 */
function renameWithRetry(from, to) {
	for (let attempt = 0;; attempt++) try {
		renameSync(from, to);
		return;
	} catch (error) {
		const code = error.code;
		if (attempt >= 4 || code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
	}
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
var SessionBindings = class SessionBindings {
	file;
	warn;
	now;
	state;
	constructor(file, warn, now = () => /* @__PURE__ */ new Date()) {
		this.file = file;
		this.warn = warn;
		this.now = now;
		this.state = file === void 0 ? {
			version: 1,
			sessions: {}
		} : this.load(file);
	}
	/** 从磁盘重新读取；清理后不保留旧会话绑定。 */
	reload() {
		this.state = this.file === void 0 ? {
			version: 1,
			sessions: {}
		} : this.load(this.file);
	}
	static at(dir, warn) {
		return new SessionBindings(join(dir, "sessions.json"), warn);
	}
	/** 会话的选择；没有记录时为 undefined。 */
	get(sessionId) {
		return this.state.sessions[sessionId]?.role;
	}
	/** 记下会话的选择；值没变时不写盘。 */
	set(sessionId, role) {
		const entry = this.state.sessions[sessionId];
		if (entry?.role === role) return;
		this.commitSession(sessionId, {
			...entry,
			role,
			at: this.now().toISOString()
		});
	}
	/** 会话各轮用的角色，按轮次升序；没有记录时为空。 */
	turnsOf(sessionId) {
		return this.state.sessions[sessionId]?.turns ?? [];
	}
	/**
	* 记下第 turn 轮用的角色。和上一条相同时不写盘，所以每轮调用也只在换人时写。
	* 比 turn 晚的记录是撤回或重新生成前的旧轮次，一起去掉。会话还没有选择记录时不记。
	*/
	recordTurn(sessionId, turn, role) {
		const entry = this.state.sessions[sessionId];
		if (entry === void 0 || !Number.isSafeInteger(turn) || turn < 0) return;
		const current = entry.turns ?? [];
		const kept = current.filter((item) => item.turn < turn);
		const turns = (kept.at(-1)?.role === role ? kept : [...kept, {
			turn,
			role
		}]).slice(-200);
		if (turns.length === current.length && turns.every((item, i) => item.turn === current[i].turn && item.role === current[i].role)) return;
		this.commitSession(sessionId, {
			...entry,
			turns
		});
	}
	/** 会话里这个角色的记忆快照；还没取过时为 undefined。 */
	memorySnapshot(sessionId, roleId) {
		return this.state.sessions[sessionId]?.memory?.[roleId];
	}
	/** 记下快照。已经有了不覆盖；会话还没有选择记录时不记。 */
	setMemorySnapshot(sessionId, roleId, text) {
		const entry = this.state.sessions[sessionId];
		if (entry === void 0 || entry.memory?.[roleId] !== void 0) return;
		this.commitSession(sessionId, {
			...entry,
			memory: {
				...entry.memory,
				[roleId]: text
			}
		});
	}
	/** 有记录的全部会话 id。 */
	sessionIds() {
		return Object.keys(this.state.sessions);
	}
	/** 把新版记忆应用到这个会话时覆盖快照。会话还没有选择记录或内容相同时不写。 */
	replaceMemorySnapshot(sessionId, roleId, text) {
		const entry = this.state.sessions[sessionId];
		if (entry === void 0 || entry.memory?.[roleId] === text) return;
		this.commitSession(sessionId, {
			...entry,
			memory: {
				...entry.memory,
				[roleId]: text
			}
		});
	}
	get defaultRole() {
		return this.state.defaultRole;
	}
	setDefaultRole(role) {
		if (this.state.defaultRole === role) return;
		const { defaultRole: _previous, ...rest } = this.state;
		this.commit(role === void 0 ? rest : {
			...rest,
			defaultRole: role
		});
	}
	commitSession(sessionId, entry) {
		this.commit({
			...this.state,
			sessions: {
				...this.state.sessions,
				[sessionId]: entry
			}
		});
	}
	commit(next) {
		if (this.file !== void 0) writeJson(this.file, next);
		this.state = next;
	}
	load(file) {
		const raw = readJson(file, this.warn);
		if (!isRecord(raw)) {
			if (raw !== void 0) this.warn(`qqbot: ${file} 格式无效，会话绑定从空开始`);
			return {
				version: 1,
				sessions: {}
			};
		}
		const sessions = {};
		if (isRecord(raw["sessions"])) for (const [id, entry] of Object.entries(raw["sessions"])) {
			if (!isRecord(entry)) continue;
			const role = entry["role"];
			if (role !== null && (typeof role !== "string" || role === "")) continue;
			const turns = loadTurns(entry["turns"]);
			const memory = loadMemory(entry["memory"]);
			sessions[id] = {
				role,
				at: typeof entry["at"] === "string" ? entry["at"] : "",
				...turns.length === 0 ? {} : { turns },
				...memory === void 0 ? {} : { memory }
			};
		}
		const defaultRole = raw["defaultRole"];
		return typeof defaultRole === "string" && defaultRole !== "" ? {
			version: 1,
			defaultRole,
			sessions
		} : {
			version: 1,
			sessions
		};
	}
};
/** 读各轮角色：去掉格式不对的条目，按轮次升序，同一轮只留最后一条。 */
function loadTurns(value) {
	if (!Array.isArray(value)) return [];
	const byTurn = /* @__PURE__ */ new Map();
	for (const item of value) {
		if (!isRecord(item)) continue;
		const { turn, role } = item;
		if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0) continue;
		if (role !== null && (typeof role !== "string" || role === "")) continue;
		byTurn.set(turn, role);
	}
	return [...byTurn].sort((a, b) => a[0] - b[0]).map(([turn, role]) => ({
		turn,
		role
	})).slice(-200);
}
/** 读记忆快照：只留字符串值。 */
function loadMemory(value) {
	if (!isRecord(value)) return void 0;
	const entries = Object.entries(value).filter((entry) => typeof entry[1] === "string");
	return entries.length === 0 ? void 0 : Object.fromEntries(entries);
}
// src/library-types.ts
/**
* 角色和破限预设编辑接口的约定，host 和浏览器端共用。不 import 任何东西，两端都能直接打包。
* 接口只有一个路径：GET 读全部，POST 提交一个操作并返回操作后的全部数据。DSH 的 fetch 路由只支持 GET、HEAD、POST。
*/
/** `/api` 下的精确路由，由 DSH 的 connection 做认证；只有 owner 能读写。 */
const LIBRARY_PATH = "/api/qqbot/library";
/** 角色卡 `memeFrequency` 字段的取值。 */
const MEME_FREQUENCIES = [
	"low",
	"medium",
	"high",
	"off"
];
/** 角色卡没写表情频率时用的档位。 */
const DEFAULT_MEME_FREQUENCY = "medium";
const MEME_PROMPT_LIMIT = 4e3;
/**
* 角色卡 `proactivity` 字段：这个角色的设备自主性档位，设备插件直接使用。
* 没写时使用低自主性（follow）。dsh-qqbot 自己不用它，只通过登记服务的 `role()` 交给设备插件。
*/
const ROLE_PROACTIVITIES = [
	"follow",
	"situational",
	"high"
];
const ROLE_PROACTIVITY_TEXT_LIMIT = 2e3;
/** 规整一个偏好动作名：NFKC、去空格，1–60 字，不含逗号和控制字符；不合规时返回 undefined。 */
function motionActionName(value) {
	if (typeof value !== "string") return void 0;
	const text = value.normalize("NFKC").trim();
	return text && text.length <= 60 && !/[,， -]/u.test(text) ? text : void 0;
}
const MOTION_RANGES = [
	"full",
	"lower_half",
	"upper_half",
	"lower",
	"middle",
	"upper"
];
// src/memory-format.ts
/**
* 角色记忆的格式：固定栏目、解析、规范化输出。不依赖 node，浏览器端的编辑器也用它。
* 模型的整理结果和用户的手动修改都先解析成栏目，再按固定顺序重新输出，
* 同样的内容生成的文本逐字节相同，会话快照因此能共用前缀缓存。长度和每栏条数由程序检查。
*/
/** 栏目顺序固定。list 栏每条一行；paragraph 栏只有一段。 */
const MEMORY_SECTIONS = [
	{
		key: "identity",
		title: "称呼与身份",
		kind: "list",
		limit: 6
	},
	{
		key: "relation",
		title: "关系",
		kind: "paragraph",
		limit: 1
	},
	{
		key: "preferences",
		title: "偏好与禁忌",
		kind: "list",
		limit: 10
	},
	{
		key: "promises",
		title: "约定与待办",
		kind: "list",
		limit: 5
	},
	{
		key: "events",
		title: "重要经历",
		kind: "list",
		limit: 5
	}
];
/** 渲染后的总长度上限（字符）。 */
const MEMORY_LIMIT = 1500;
/** `qqbot:role-memory` 段落：没有记忆时为空，整段不出现。只由快照决定，所以会话内不变。 */
function memoryRule(memory) {
	return memory === "" ? "" : `你记得的关于对方的事（以前聊天时记下的，自然地用上，不要复述这份记录）：

${memory}`;
}
/** 解析出错的原因，可以直接展示给用户。 */
var MemoryFormatError = class extends TypeError {};
/**
* 解析记忆文本。`## 栏目名` 开头，list 栏每行一条（可带 `- `），paragraph 栏多行合成一段。
* lenient 用于模型输出：去掉代码围栏，忽略第一个栏目前的文字；用户输入时这些都算错误。
*/
function parseMemory(text, lenient = false) {
	let source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (lenient) source = source.replace(/^\s*```[^\n]*\n/, "").replace(/\n```\s*$/, "");
	const result = {};
	let current;
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const heading = /^#{1,6}\s*(.+?)\s*#*$/.exec(line);
		if (heading !== null) {
			const title = heading[1];
			const section = MEMORY_SECTIONS.find((s) => s.title === title);
			if (section === void 0) throw new MemoryFormatError(`不认识的栏目“${title}”，只能用：${MEMORY_SECTIONS.map((s) => s.title).join("、")}`);
			if (result[section.key] !== void 0) throw new MemoryFormatError(`栏目“${title}”写了两次`);
			result[section.key] = [];
			current = section;
			continue;
		}
		if (current === void 0) {
			if (lenient) continue;
			throw new MemoryFormatError(`内容要写在栏目下面，先写一行“## ${MEMORY_SECTIONS[0].title}”这样的栏目名`);
		}
		const item = line.replace(/^(?:[-*•·]|\d+[.、)])\s*/, "").trim();
		if (item === "") continue;
		const items = result[current.key];
		if (current.kind === "paragraph") items[0] = items[0] === void 0 ? item : `${items[0]}${item}`;
		else items.push(item);
	}
	for (const section of MEMORY_SECTIONS) {
		const items = result[section.key];
		if (items === void 0) continue;
		if (items.length === 0) delete result[section.key];
		else if (items.length > section.limit) throw new MemoryFormatError(`“${section.title}”最多 ${section.limit} 条，现在有 ${items.length} 条`);
	}
	return result;
}
/** 按固定栏目顺序输出；空记忆为空串。 */
function renderMemory(memory) {
	return MEMORY_SECTIONS.filter((section) => (memory[section.key]?.length ?? 0) > 0).map((section) => {
		const items = memory[section.key];
		const body = section.kind === "paragraph" ? items.join("") : items.map((item) => `- ${item}`).join("\n");
		return `## ${section.title}\n${body}`;
	}).join("\n\n");
}
/** 解析并检查长度，返回规范化的文本。超长时抛 MemoryFormatError。 */
function normalizeMemory(text, lenient = false) {
	const rendered = renderMemory(parseMemory(text, lenient));
	if (rendered.length > 1500) throw new MemoryFormatError(`记忆最多 ${MEMORY_LIMIT} 个字，现在有 ${rendered.length} 个`);
	return rendered;
}
// src/vendor/dialogue-timing/protocol.js
const SEGMENT_PROMPT = `QQ 分段：
已开启分段回复。需要分成几条消息发送时，使用一个 [qq] JSON 块，正文放在 stages 的 text 中，不在块外重复：
[qq]{"version":1,"stages":[{"text":"先说这一句。"},{"text":"稍等一下，再接着说。"},{"text":"最后这一段。"}]}[/qq]
每个 text 是一个完整气泡，可以含一句或多句话，最多 20 段。默认不写时长字段，段落间隔由插件按用户设置自动安排；无需分段时直接正常回复。
整个回复只输出一个 [qq] 块，不放在代码块或引用中，开头和结尾始终用方括号 [qq] 和 [/qq]。只有得到其他已启用功能的规则时，才在对应段落添加其扩展字段。`;
function toneOf(value) {
	if (typeof value !== "string") return "";
	return value.replace(/[\[\]【】\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
}
// src/format.ts
/**
* 格式规则：分段、表情和语音。语音说明固定，可用状态通过 runtime 提供。
*/
/** 分段规则：[qq] 块的格式由 dialogue-timing 协议定义，解析和显示在 dsh-qqbot 的浏览器端。 */
const SEGMENT_RULE = SEGMENT_PROMPT;
/** 合成和播放仍由界面负责；让模型知道如何回应用户的语音请求。 */
const VOICE_RULE = `语音：可用状态见运行时 voice 行。默认发文字；语音可用且用户要求语音时，至少一个段落加 "voice":true。按人设和语境偶尔适合用声音时，也可选用语音。语音段在 [qq] 中先写 "voice":true，再写 text，text 写要说的话，不用调工具。一条回复可以文字和语音混发，只有一句语音也用 [qq] 块。例如：
[qq]{"version":1,"stages":[{"text":"我在呢。"},{"voice":true,"text":"晚安，做个好梦。"}]}[/qq]
运行时为“全部转语音”时界面自动转换，不用逐段标记。未启用或没有音色时发文字，按状态提示用户开启语音或给角色选音色。`;
/** dsh-meme 注册的发图工具。它的提示词段在 qqbot 会话里被 complete section 去掉，用法由这里补上。 */
const MEME_TOOL = "send_meme";
const FREQUENCY_TEXT = {
	low: "表情频率：低。偶尔使用，不要连续几轮都发。",
	medium: "表情频率：适中。气氛合适时使用。",
	high: "表情频率：高。闲聊时积极使用贴合情绪的表情。",
	off: "表情频率：不主动发。只在用户明确要求时发。"
};
function isMemeFrequency(value) {
	return typeof value === "string" && MEME_FREQUENCIES.includes(value);
}
/**
* 表情规则。发送方式（Web 写标记还是走 IM 渠道、纯文字模式）以 send_meme 工具说明和结果为准，这里不重复，
* 免得和 dsh-meme 的设置冲突；这里只管什么时候发、发多少。
*/
function memeRule(frequency, preferences) {
	if (frequency === "off") return `表情包：只在用户明确要求时，用 ${MEME_TOOL} 找一张贴合的按工具说明发出。`;
	return [
		`表情包：用 ${MEME_TOOL} 按情绪或关键词找候选，挑贴合的一张，按工具说明的方式发出。`,
		"一次回复最多一张；用户在说正事时不发。",
		FREQUENCY_TEXT[frequency],
		preferences?.memePacks?.length ? `优先图库：${preferences.memePacks.map((pack) => JSON.stringify(pack.name)).join("、")}；从已启用图库中优先挑选，没有合适的可用其他图库。` : "",
		preferences?.memeTags?.length ? `偏好标签：${preferences.memeTags.map((tag) => JSON.stringify(tag)).join("、")}。` : "",
		preferences?.memePrompt ? `表情补充要求：\n${preferences.memePrompt}` : ""
	].filter(Boolean).join("\n");
}
/** AI 最后一次回复后多久没有新消息算空闲。DeepSeek 的前缀缓存一般能保留到这时。 */
const IDLE_MS = 12e5;
var MemoryCoordinator = class {
	content;
	warn;
	paused;
	generation = 0;
	cleanup = new AbortController();
	/** 清理时使进行中和排队的旧整理结果失效。 */
	invalidate() {
		this.cleanup.abort();
		this.cleanup = new AbortController();
		this.generation++;
		this.running.clear();
		this.queues.clear();
	}
	live = /* @__PURE__ */ new Map();
	running = /* @__PURE__ */ new Map();
	/** 角色 id → 这个角色上一个整理任务；新任务接在后面。 */
	queues = /* @__PURE__ */ new Map();
	constructor(content, warn, paused = () => false) {
		this.content = content;
		this.warn = warn;
		this.paused = paused;
	}
	/** 登记会话，返回注销函数。 */
	register(session) {
		this.live.set(session.id, session);
		return () => {
			if (this.live.get(session.id) === session) this.live.delete(session.id);
		};
	}
	/**
	* 会话里还没整理过的轮次范围：从上次整理之后、或当前角色这一段开始（取较晚的）到最新一轮。
	* 换过角色时只算当前角色这一段。
	*/
	pendingTurns(sessionId, roleId, latestTurn) {
		const done = this.content.memories.consolidatedTurn(roleId, sessionId) ?? 0;
		const since = this.content.bindings.turnsOf(sessionId).findLast((item) => item.role === roleId)?.turn ?? 1;
		return Math.max(0, latestTurn - Math.max(done, since - 1));
	}
	/** 整理一个会话。force 时不看门槛（手动），但至少要有一轮新内容。 */
	consolidate(sessionId, force = false) {
		if (this.paused()) return Promise.resolve({
			kind: "skipped",
			reason: "busy"
		});
		const existing = this.running.get(sessionId);
		if (existing !== void 0) return force ? existing : Promise.resolve({
			kind: "skipped",
			reason: "busy"
		});
		const session = this.live.get(sessionId);
		const role = this.content.roleFor({ id: sessionId });
		if (session === void 0 || role === void 0) return Promise.resolve({
			kind: "skipped",
			reason: "no-role"
		});
		const lastRole = this.content.bindings.turnsOf(sessionId).at(-1);
		if (lastRole !== void 0 && lastRole.role !== role.id) return Promise.resolve({
			kind: "skipped",
			reason: "no-request"
		});
		const latest = session.latestTurn();
		if (this.pendingTurns(sessionId, role.id, latest) < (force ? 1 : 10)) return Promise.resolve({
			kind: "skipped",
			reason: "too-few"
		});
		const input = session.capture();
		if (input === void 0) return Promise.resolve({
			kind: "skipped",
			reason: "no-request"
		});
		const generation = this.generation;
		const signal = this.cleanup.signal;
		const settled = (this.queues.get(role.id) ?? Promise.resolve()).then(async () => {
			if (generation !== this.generation) return { kind: "stale" };
			const revision = this.content.memories.revision(role.id);
			const previous = this.content.memories.text(role.id);
			let result;
			try {
				result = await session.run(input, role.name, previous, signal);
			} catch (error) {
				return {
					kind: "failed",
					error: error instanceof Error ? error.message : String(error)
				};
			}
			if (generation !== this.generation) return { kind: "stale" };
			if (!this.content.memories.commitConsolidation(role.id, revision, sessionId, latest, result.text)) return { kind: "stale" };
			if (result.text === void 0) {
				this.warn(`qqbot: 角色“${role.name}”的记忆整理结果不合格，保留旧版：${result.problem ?? ""}`);
				return {
					kind: "rejected",
					problem: result.problem ?? ""
				};
			}
			return {
				kind: "done",
				changed: result.text !== previous
			};
		}).catch((error) => ({
			kind: "failed",
			error: String(error)
		}));
		this.queues.set(role.id, settled);
		this.running.set(sessionId, settled);
		settled.then(() => {
			if (this.running.get(sessionId) === settled) this.running.delete(sessionId);
			if (this.queues.get(role.id) === settled) this.queues.delete(role.id);
		});
		return settled;
	}
	/** 开新会话：同一角色其他还开着的会话有足够的新内容，就在后台整理。不等待。 */
	consolidateOthers(newSessionId, roleId) {
		for (const session of this.live.values()) {
			if (session.id === newSessionId || this.content.roleFor({ id: session.id })?.id !== roleId) continue;
			this.consolidate(session.id).then((outcome) => {
				if (outcome.kind === "failed") this.warn(`qqbot: 记忆整理失败：${outcome.error}`);
			});
		}
	}
	/** 手动整理：用这个角色最近有动静的、还开着的会话。找不到时抛出可以直接展示的错误。 */
	async consolidateRole(roleId) {
		const session = [...this.live.values()].filter((session) => this.content.roleFor({ id: session.id })?.id === roleId).sort((a, b) => b.lastActive() - a.lastActive())[0];
		if (session === void 0) throw new Error("没有正在用这个角色的会话。先打开和它的聊天，再整理记忆");
		return this.consolidate(session.id, true);
	}
};
/** 手动整理结果给用户看的说明；成功时为 undefined。 */
function outcomeMessage(outcome) {
	switch (outcome.kind) {
		case "done": return;
		case "skipped": return outcome.reason === "too-few" ? "上次整理之后还没有新的聊天内容" : outcome.reason === "no-request" ? "这个会话还没有聊过，没有可整理的内容" : "这个会话已经不用这个角色了";
		case "stale": return "整理期间记忆被修改过，这次结果没有保存，请再试一次";
		case "rejected": return `整理结果太长，保留了原来的记忆：${outcome.problem}`;
		case "failed": return `整理请求失败：${outcome.error}`;
	}
}
// src/registry.ts
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** 登记部分；`role()` 由 QqbotService 按角色库实现。 */
var QqbotRegistryStore = class {
	extensions = /* @__PURE__ */ new Map();
	runtimes = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	extension(entry, source) {
		return this.add(this.extensions, entry.name, {
			name: entry.name,
			text: entry.text,
			...withSource(source)
		});
	}
	runtime(name, text, source) {
		return this.add(this.runtimes, name, {
			text,
			...withSource(source)
		});
	}
	/** 名称排序后的条目，供 dsh-qqbot/prompt 和提示词查看器读取。 */
	snapshot() {
		const byName = (map) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		return {
			extensions: byName(this.extensions).map(([, entry]) => entry),
			runtime: byName(this.runtimes).map(([name, value]) => ({
				name,
				...value
			}))
		};
	}
	/** 条目增删时通知；返回取消订阅。 */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	add(map, name, value) {
		if (!NAME_PATTERN.test(name)) throw new TypeError(`qqbot: invalid registration name "${name}"`);
		if (map.has(name)) throw new Error(`qqbot: duplicate registration "${name}"`);
		map.set(name, value);
		this.notify();
		return () => {
			if (map.get(name) !== value) return;
			map.delete(name);
			this.notify();
		};
	}
	notify() {
		for (const listener of [...this.listeners]) listener();
	}
};
function withSource(source) {
	return source === void 0 ? {} : { source };
}
/** 按会话求值条目文本。 */
function resolveText(text, session) {
	return typeof text === "function" ? text(session) : text;
}
// src/order.ts
/**
* qqbot 预设内全部提示词段落和 context 的 order，只在这里定义。
* 其他文件和插件不写数字；外部插件统一落在 EXT 位置，同位置按名称排序。
* 布局和缓存影响见 docs/architecture.md 第 3 节。
*/
/**
* 各段在 `qqbot:prompt` 内的拼接顺序。这些段落不单独注册成 DSH section：
* 它们拼成一个 complete section，DSH 自带段落因此不会进入 qqbot 会话。
*/
const SECTION_ORDER = {
	JB_HEAD: 100,
	PERSONA: 200,
	JB_MID: 300,
	FORMAT_SEGMENT: 400,
	FORMAT_MEME: 410,
	FORMAT_VOICE: 420,
	EXT: 500,
	ROLE_MEMORY: 800,
	JB_TAIL: 900
};
/** DSH 自带 context 在 100–210，qqbot:runtime 排在它们之后。 */
const CONTEXT_ORDER = { RUNTIME: 1e3 };
const SECTION_NAME = {
	PROMPT: "qqbot:prompt",
	JB_HEAD: "qqbot:jb-head",
	PERSONA: "qqbot:persona",
	JB_MID: "qqbot:jb-mid",
	FORMAT_SEGMENT: "qqbot:format-segment",
	FORMAT_MEME: "qqbot:format-meme",
	FORMAT_VOICE: "qqbot:format-voice",
	JB_TAIL: "qqbot:jb-tail",
	EXT_PREFIX: "qqbot:ext:",
	ROLE_MEMORY: "qqbot:role-memory"
};
const CONTEXT_NAME = { RUNTIME: "qqbot:runtime" };
// src/memory-consolidate.ts
/** 整理输出的上限。记忆只有约 1500 字，留出思考模型的推理余量。 */
const MAX_TOKENS = 8192;
function sectionGuide() {
	const notes = {
		identity: "对方的名字、你怎么称呼对方、对方怎么称呼你、职业等很少变的事",
		relation: "你们现在的关系和相处方式，写成一段话，每次整段改写",
		preferences: "对方喜欢和不喜欢的事、禁忌、对聊天方式的要求",
		promises: "还没兑现的约定和计划；完成或过期的删掉",
		events: "影响你们关系的重要事件；超过条数时把最旧的并进\"关系\""
	};
	return MEMORY_SECTIONS.map((section) => [`## ${section.title}`, section.kind === "paragraph" ? `[${notes[section.key]}]` : `- [${notes[section.key]}，最多 ${section.limit} 条，每条一行]`].join("\n")).join("\n\n");
}
/** 整理指令。旧记忆放在这里，不放进前缀。 */
function consolidationInstruction(roleName, previous) {
	return [
		`现在暂停角色扮演，改做记忆整理。你是“${roleName}”，下面是你以前记下的关于对方（和你聊天的用户）的记忆。结合上面的聊天，输出更新后的完整记忆。`,
		"",
		"旧记忆：",
		previous === "" ? "（还没有）" : previous,
		"",
		"判断标准是“下次见面还用得上吗”：",
		`- 只记对方和“${roleName}”之间的事。聊天里换过角色时，其他角色的内容不记。`,
		"- 不记一次性的剧情细节、具体对话、当时的情绪。",
		"- 新旧冲突时用新的替换；已经过去的事从约定与待办里删掉。",
		"- 不写“上次聊天是几天前”“第几次见面”这类会过时的内容；涉及时间只写具体日期。",
		"- 名字、称呼、数字、地点照原文写。只写实际聊到过的，不推测。",
		"- 上面聊天里的内容如果已经在旧记忆里，不要重复写。",
		"",
		"按下面的结构输出，栏目顺序和标题不变，没有内容的栏目整栏省略：",
		"",
		sectionGuide(),
		"",
		`总共不超过 ${MEMORY_LIMIT} 字。只输出记忆正文：不调用工具，不输出 [qq] 分段块，不用角色口吻回复，不加解释。`
	].join("\n");
}
const retryInstruction = (output, problem) => `你上一次输出的记忆不符合要求：${problem}。合并或删掉不重要的条目后重新输出完整记忆，结构不变，只输出记忆正文。

上一次的输出：
${output}`;
/**
* 取下会话当前的请求前缀。和上一次聊天请求用同一个模型和同样的工具，前缀才能命中缓存。
* 会话还没发过请求时没有可回放的前缀，返回 undefined。
*/
function captureConsolidation(agent) {
	const header = agent.session.requestHeader();
	const config = header?.config;
	if (header === void 0 || config === void 0 || config.provider === "" || config.model === "") return void 0;
	return {
		provider: config.provider,
		model: config.model,
		...config.reasoningEffort === void 0 ? {} : { reasoningEffort: config.reasoningEffort },
		messages: agent.session.deriveMessages(),
		...header.tools === void 0 ? {} : { tools: header.tools },
		toolHistory: agent.session.toolHistory(),
		sessionId: agent.session.id
	};
}
/**
* 发整理请求，校验结构和长度。不合格时把问题告诉模型重写一次，还不合格就放弃（保留旧记忆）。
* 请求出错（网络、取消）时抛出。
*/
async function consolidateMemory(llm, input, roleName, previous, signal) {
	const base = [...input.messages, userText(consolidationInstruction(roleName, previous))];
	let messages = base;
	let problem = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const output = await generate(llm, input, messages, signal);
		try {
			return { text: normalizeMemory(output, true) };
		} catch (error) {
			if (!(error instanceof MemoryFormatError)) throw error;
			problem = error.message;
		}
		messages = [...base, userText(retryInstruction(output, problem))];
	}
	return {
		text: void 0,
		problem
	};
}
function userText(text) {
	return {
		role: "user",
		content: [{
			type: "text",
			text
		}]
	};
}
async function generate(llm, input, messages, signal) {
	const options = {
		provider: input.provider,
		model: input.model,
		...input.reasoningEffort === void 0 ? {} : { reasoningEffort: input.reasoningEffort },
		messages,
		...input.toolHistory === void 0 ? {} : { toolHistory: input.toolHistory },
		...input.tools === void 0 ? {} : { tools: [...input.tools] },
		maxTokens: MAX_TOKENS,
		sessionId: input.sessionId,
		...signal === void 0 ? {} : { signal }
	};
	const assembler = new BlockAssembler();
	for await (const chunk of llm.stream(options)) assembler.push(chunk);
	const finish = assembler.finish;
	if (finish.kind === "error" || finish.kind === "aborted") throw new Error(`记忆整理请求失败：${finish.failure.message}`);
	if (finish.kind === "max-tokens") throw new Error("记忆整理输出超出上限");
	return assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
}
// src/agent-turn.ts
/** 新宿主使用轮次投影；缺少该接口的宿主从保留的完整事件快照读取同一轮次。 */
function lastTurnOf(agents, session) {
	if (typeof agents.turnBoundaryOf === "function") return agents.turnBoundaryOf(session).lastTurn;
	if (typeof session.snapshotEvents !== "function") throw new Error("当前 DSH 无法读取对话轮次，请更新 DSH。");
	const events = session.snapshotEvents();
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type === "turn/start") return event.data.turn;
	}
	return 0;
}
// src/memory-agent.ts
var memory_agent_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply$2,
	inject: () => inject$2,
	name: () => name$2
});
const name$2 = "qqbot-memory";
const inject$2 = [
	"qqbot",
	"llm",
	"agents"
];
function apply$2(ctx) {
	const { memory, content } = ctx.qqbot;
	const abort = new AbortController();
	ctx.effect(() => () => {
		abort.abort();
	}, "qqbot: memory abort");
	let timer;
	const clearTimer = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = void 0;
	};
	ctx.effect(() => clearTimer, "qqbot: memory idle timer");
	ctx.effect(() => ctx.qqbot.maintenance.register({ prepare: clearTimer }), "qqbot: reset memory timer");
	let lastActive = Date.now();
	const report = (outcome) => {
		if (outcome.kind === "failed" && !abort.signal.aborted) ctx.logger.warn(`qqbot: 记忆整理失败：${outcome.error}`);
	};
	ctx.on("agent/created", ({ agent, source }) => {
		ctx.effect(() => memory.register({
			id: agent.id,
			latestTurn: () => lastTurnOf(ctx.agents, agent.session),
			lastActive: () => lastActive,
			capture: () => captureConsolidation(agent),
			run: (input, roleName, previous, cleanup) => consolidateMemory(ctx.llm, input, roleName, previous, cleanup === void 0 ? abort.signal : AbortSignal.any([abort.signal, cleanup]))
		}), "qqbot: memory session");
		ctx.effect(() => ctx.on("session/event", (session, event) => {
			if (session !== agent.session || event.type !== "compaction/summary") return;
			const role = content.memoryState(agent.id)?.role;
			if (role === void 0) return;
			try {
				content.applyMemory(agent.id, role);
			} catch (error) {
				ctx.logger.warn(`qqbot: 压缩后没能更新记忆快照：${String(error)}`);
			}
		}), "qqbot: memory after compaction");
		if (source === "startup" || source === "clear") {
			const role = content.roleFor({ id: agent.id });
			if (role !== void 0) memory.consolidateOthers(agent.id, role.id);
		}
	});
	ctx.on("agent/status", ({ agent, status }) => {
		lastActive = Date.now();
		clearTimer();
		if (status !== "idle") return;
		timer = setTimeout(() => {
			timer = void 0;
			memory.consolidate(agent.id).then(report);
		}, IDLE_MS);
		timer.unref?.();
	});
}
// ../../qqbot/src/deepseek-harness/packages/interaction/commands/lib/types/brand.js
/**
* Command definition identities and execution ids for discovery and lifecycle pairing.
*
* The `Branded<B>` primitive lives in `@deepseek-ai/dsh-brand`; this module
* is a pure type/constructor outlet (no cordis imports, no module
* augmentation) so wire and client programs can name the brand without
* loading the host plugin's Context merges — the `dsh-llm/brand` shape.
*
* @module @deepseek-ai/dsh-commands/brand
*/
/**
* Brand a plugin-namespaced command definition identity.
* @param id - stable identity chosen by the registering plugin.
* @returns the same string, branded; no validation is performed.
*/
function CommandDefinitionId(id) {
	return id;
}
// src/role-command.ts
var role_command_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply$1,
	inject: () => inject$1,
	name: () => name$1,
	overview: () => overview,
	runRole: () => runRole
});
const name$1 = "qqbot-role-command";
const inject$1 = [
	"commands",
	"qqbot",
	"agents"
];
const USAGE = "用法：/role <角色名称> 切换角色 · /role none 不用角色 · /role list 列出角色 · /role default <角色名称|none> 设置新会话默认角色";
/** 角色在命令输出里只显示名称；id 是内部键，用户看不到。 */
function label(role) {
	return role.name;
}
function roster(data, current) {
	const roles = data.roles.list();
	if (roles.length === 0) return "角色库是空的：到设置 → QQ Bot 里新建角色。";
	return roles.map((role) => `${role.id === current ? "*" : " "} ${role.name}`).join("\n");
}
/** 当前会话的状态：角色、破限预设、新会话默认角色和角色列表。 */
function overview(data, session) {
	const choice = data.choiceFor(session);
	const role = data.roleFor(session);
	const current = choice === null ? "无" : role === void 0 ? "原来的角色已不在角色库，按无角色运行" : label(role);
	const preset = data.jailbreakFor(session);
	const fallbackId = data.bindings.defaultRole;
	const fallback = fallbackId === void 0 ? "无" : data.roles.get(fallbackId)?.name ?? "已不在角色库";
	return [
		`当前角色：${current}`,
		`通用提示词：${preset.name}`,
		`新会话默认角色：${fallback}`,
		"",
		roster(data, role?.id),
		"",
		USAGE
	].join("\n");
}
/** 执行一次 `/role`。纯逻辑，便于测试；写盘失败时抛出，由调用方转成错误结果。 */
function runRole(data, session, rawInput, busy = false) {
	data.roles.reload();
	const input = rawInput.trim();
	const unknown = (name) => ({
		kind: "error",
		text: `没有叫"${name}"的角色。\n\n${roster(data, data.roleIdFor(session))}\n\n${USAGE}`
	});
	if (input === "") return {
		kind: "success",
		text: overview(data, session)
	};
	if (input === "list") return {
		kind: "success",
		text: roster(data, data.roleIdFor(session))
	};
	if (input === "none" || input === "off") {
		if (busy) return {
			kind: "error",
			text: "请等当前回复和排队消息处理完后再切换角色。"
		};
		const before = data.roleFor(session);
		data.bindings.set(session.id, null);
		return {
			kind: "success",
			text: `${before === void 0 ? "这个会话本来就没有角色。" : `已取消角色 ${label(before)}，下一条消息起不带角色。`}\n\n${overview(data, session)}`
		};
	}
	const fallback = /^default\s+(.+)$/.exec(input)?.[1]?.trim();
	if (fallback !== void 0) {
		if (fallback === "none" || fallback === "off") {
			data.bindings.setDefaultRole(void 0);
			return {
				kind: "success",
				text: "新会话不再默认带角色。已有会话不变。"
			};
		}
		const role = data.roles.find(fallback);
		if (role === void 0) return unknown(fallback);
		data.bindings.setDefaultRole(role.id);
		return {
			kind: "success",
			text: `新 QQ 会话默认使用 ${label(role)}。已有会话不变。`
		};
	}
	const role = data.roles.find(input);
	if (role === void 0) return unknown(input);
	if (busy) return {
		kind: "error",
		text: "请等当前回复和排队消息处理完后再切换角色。"
	};
	const before = data.roleIdFor(session);
	data.bindings.set(session.id, role.id);
	return {
		kind: "success",
		text: `${before === role.id ? `这个会话已经是 ${label(role)}。` : `已切换到 ${label(role)}，下一条消息起生效。`}\n\n${overview(data, session)}`
	};
}
function apply$1(ctx) {
	const data = ctx.qqbot.content;
	ctx.effect(() => ctx.commands.register({
		definitionId: CommandDefinitionId("dsh-qqbot/role"),
		name: "role",
		description: "查看或切换角色、设置新会话默认角色",
		input: { hint: "[<角色名称>|list|none|default <角色名称>]" },
		handler: ({ agent, rawInput }) => {
			try {
				ctx.qqbot.maintenance.assertAvailable();
				const busy = agent.status !== "idle" || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0;
				return runRole(data, { id: agent.id }, rawInput, busy);
			} catch (error) {
				return {
					kind: "error",
					text: `角色没有切换：${error.message}`
				};
			}
		}
	}), "qqbot: /role command");
}
// src/prompt.ts
const name = "qqbot-prompt";
const inject = ["systemPrompt", "qqbot"];
/** 各段之间的分隔，和 DSH 拼接 section 时一致（system-prompt 的 renderPrompt）。 */
const PART_SEPARATOR = "\n\n";
const NO_FEATURES = { meme: false };
/** 诊断性组装没有 agent，此时所有按会话求值的内容都为空。 */
function sessionOf(context) {
	const id = context.agent?.id;
	return id === void 0 ? void 0 : { id };
}
/** 真实组装带着本步放行的工具集；send_meme 不在里面（没装 dsh-meme、被关掉）时不写表情规则。 */
function featuresOf(context) {
	return { meme: context.toolSet?.view(context.scope).has(MEME_TOOL) === true };
}
/**
* 按 SECTION_ORDER 列出本会话的各段，去掉空段。同 order 按名称排序，和 DSH 的 section 排序规则一致。
* session 为空时只剩不按会话求值的段落。
*/
function assembleParts(content, store, session, features = NO_FEATURES) {
	const perSession = (read) => session === void 0 ? "" : read(session);
	const jailbreak = session === void 0 ? void 0 : content.jailbreakFor(session);
	return [
		{
			name: SECTION_NAME.JB_HEAD,
			order: SECTION_ORDER.JB_HEAD,
			text: jailbreak?.head ?? ""
		},
		{
			name: SECTION_NAME.PERSONA,
			order: SECTION_ORDER.PERSONA,
			text: perSession((s) => content.personaFor(s))
		},
		{
			name: SECTION_NAME.JB_MID,
			order: SECTION_ORDER.JB_MID,
			text: jailbreak?.mid ?? ""
		},
		{
			name: SECTION_NAME.FORMAT_SEGMENT,
			order: SECTION_ORDER.FORMAT_SEGMENT,
			text: SEGMENT_RULE
		},
		{
			name: SECTION_NAME.FORMAT_MEME,
			order: SECTION_ORDER.FORMAT_MEME,
			text: features.meme ? perSession((s) => memeRule(content.memeFrequencyFor(s), content.memePreferencesFor(s))) : ""
		},
		{
			name: SECTION_NAME.FORMAT_VOICE,
			order: SECTION_ORDER.FORMAT_VOICE,
			text: VOICE_RULE
		},
		...store.snapshot().extensions.map((entry) => ({
			name: `${SECTION_NAME.EXT_PREFIX}${entry.name}`,
			order: SECTION_ORDER.EXT,
			text: perSession((s) => resolveText(entry.text, s)),
			...entry.source === void 0 ? {} : { source: entry.source }
		})),
		{
			name: SECTION_NAME.ROLE_MEMORY,
			order: SECTION_ORDER.ROLE_MEMORY,
			text: perSession((s) => memoryRule(content.roleMemoryFor(s)))
		},
		{
			name: SECTION_NAME.JB_TAIL,
			order: SECTION_ORDER.JB_TAIL,
			text: jailbreak?.tail ?? ""
		}
	].filter((part) => part.text !== "").sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/** `qqbot:runtime` context 的文本：每条一行 `名称: 内容`，空条目去掉。 */
function renderRuntime(store, session) {
	return store.snapshot().runtime.map((item) => ({
		name: item.name,
		text: resolveText(item.text, session)
	})).filter((item) => item.text !== "").map((item) => `${item.name}: ${item.text}`).join("\n");
}
function apply(ctx) {
	const { content, store } = ctx.qqbot;
	ctx.systemPrompt.section({
		name: SECTION_NAME.PROMPT,
		order: 0,
		complete: true,
		interpolate: false,
		text: (context) => {
			ctx.qqbot.maintenance.assertAvailable();
			const session = sessionOf(context);
			if (session !== void 0) content.settle(session);
			const text = assembleParts(content, store, session, featuresOf(context)).map((part) => part.text).join("\n\n");
			if (context.agent !== void 0) ctx.qqbot.lastPrompt.set(context.agent, text);
			return text;
		}
	});
	ctx.systemPrompt.context({
		name: CONTEXT_NAME.RUNTIME,
		order: CONTEXT_ORDER.RUNTIME,
		required: true,
		interpolate: false,
		text: (context) => {
			const session = sessionOf(context);
			return session === void 0 ? "" : renderRuntime(store, session);
		}
	});
	ctx.on("agent/pre-step", async ({ agent, turn }, next) => {
		const decision = await next();
		if (decision.kind !== "reject") ctx.qqbot.maintenance.assertAvailable();
		if (decision.kind !== "reject") content.recordTurn({ id: agent.id }, turn);
		return decision;
	});
	ctx.plugin(role_command_exports);
	ctx.plugin(memory_agent_exports);
}
export { renameWithRetry as A, ROLE_PROACTIVITY_TEXT_LIMIT as C, dshHome as D, dataDir as E, writeText as M, __exportAll as N, isRecord as O, ROLE_PROACTIVITIES as S, SessionBindings as T, normalizeMemory as _, name as a, MEME_PROMPT_LIMIT as b, CONTEXT_NAME as c, resolveText as d, MemoryCoordinator as f, toneOf as g, isMemeFrequency as h, inject as i, writeJson as j, readJson as k, SECTION_NAME as l, MEME_TOOL as m, apply as n, renderRuntime as o, outcomeMessage as p, assembleParts as r, lastTurnOf as s, PART_SEPARATOR as t, QqbotRegistryStore as u, DEFAULT_MEME_FREQUENCY as v, motionActionName as w, MOTION_RANGES as x, LIBRARY_PATH as y };
