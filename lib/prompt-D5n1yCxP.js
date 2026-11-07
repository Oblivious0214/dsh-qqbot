import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
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
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
var SessionBindings = class SessionBindings {
	file;
	warn;
	now;
	state;
	choiceAdapter;
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
	get filePath() {
		return this.file;
	}
	interceptChoices(adapter) {
		this.choiceAdapter = adapter;
		return () => {
			if (this.choiceAdapter === adapter) this.choiceAdapter = void 0;
		};
	}
	/** 记下会话的选择；值没变时不写盘。 */
	set(sessionId, role) {
		const entry = this.state.sessions[sessionId];
		if (entry?.role === role) return;
		const publish = () => this.commitSession(sessionId, {
			...entry,
			role,
			at: this.now().toISOString()
		});
		if (this.choiceAdapter) this.choiceAdapter(sessionId, role, publish);
		else publish();
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
		if (!isRecord$1(raw)) {
			if (raw !== void 0) this.warn(`qqbot: ${file} 格式无效，会话绑定从空开始`);
			return {
				version: 1,
				sessions: {}
			};
		}
		const sessions = {};
		if (isRecord$1(raw["sessions"])) for (const [id, entry] of Object.entries(raw["sessions"])) {
			if (!isRecord$1(entry)) continue;
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
		if (!isRecord$1(item)) continue;
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
	if (!isRecord$1(value)) return void 0;
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
// src/json-record.ts
/** 普通记录形状判断，可供浏览器使用。 */
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
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
		preferences?.memePacks?.length ? `可用图库：${preferences.memePacks.map((pack) => JSON.stringify(pack.name)).join("、")}。没有合适的表情时继续文字回应。` : "当前角色未选图库，使用文字回应。",
		preferences?.memeTags?.length ? `偏好标签：${preferences.memeTags.map((tag) => JSON.stringify(tag)).join("、")}。` : "",
		preferences?.memePrompt ? `表情补充要求：\n${preferences.memePrompt}` : ""
	].filter(Boolean).join("\n");
}
// src/role-dynamics/types.ts
var DynamicsError = class extends Error {
	code;
	path;
	constructor(code, path, message) {
		super(`${path}: ${message}`);
		this.code = code;
		this.path = path;
		this.name = "DynamicsError";
	}
};
const fail = (path, message, code = "invalid") => {
	throw new DynamicsError(code, path, message);
};
// src/role-dynamics/validate.ts
const dangerous = /* @__PURE__ */ new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
const bytes = (value) => new TextEncoder().encode(value).byteLength;
function jsonData(value, path = "$", seen = /* @__PURE__ */ new Set(), depth = 0) {
	if (depth > 32) fail(path, "JSON 嵌套过深");
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		finite(value, path);
		return;
	}
	if (typeof value !== "object" || value === null) fail(path, "需要普通 JSON 数据");
	const object = value;
	if (seen.has(object)) fail(path, "循环引用");
	seen.add(object);
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(path, "需要普通对象");
	for (const key of Reflect.ownKeys(object)) {
		if (typeof key !== "string" || dangerous.has(key)) fail(path, "非法键名");
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (!("value" in descriptor)) fail(path, "不接受访问器");
		if (Array.isArray(value) && key === "length") continue;
		if (!descriptor.enumerable) fail(`${path}.${key}`, "不接受非枚举属性");
		if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) fail(path, "非法数组属性");
		jsonData(descriptor.value, `${path}.${key}`, seen, depth + 1);
	}
	if (Array.isArray(value) && Object.keys(value).length !== value.length) fail(path, "不接受稀疏数组");
	seen.delete(object);
}
function object(value, path, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "需要对象");
	const result = value;
	for (const key of Object.keys(result)) if (!keys.includes(key) || dangerous.has(key)) fail(`${path}.${key}`, "未知键");
	return result;
}
function finite(value, path) {
	if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(path, "需要有限数字（不接受 -0）");
}
function text(value, path, max, nonempty = false) {
	if (typeof value !== "string") return fail(path, "需要字符串");
	const result = value.replace(/\r\n/g, "\n");
	if (result.length > max || nonempty && !result.trim()) fail(path, `文字长度须为 ${nonempty ? 1 : 0}–${max}`);
	return result;
}
function normalizeName(value, path = "$.name") {
	if (typeof value !== "string") return fail(path, "需要名称");
	const name = value.normalize("NFC").trim();
	if (!name || name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || dangerous.has(name)) fail(path, "名称无效");
	return name;
}
function bool(value, path) {
	if (typeof value !== "boolean") return fail(path, "需要布尔值");
	return value;
}
function validateValue(field, value, path = "$.value") {
	switch (field.type) {
		case "number":
			finite(value, path);
			if (field.min !== void 0 && value < field.min || field.max !== void 0 && value > field.max) fail(path, "数值超出范围");
			return value;
		case "boolean": return bool(value, path);
		case "text": return text(value, path, 2e3);
		case "choice":
			if (typeof value !== "string" || !field.options.includes(value)) return fail(path, "需要定义内的选项");
			return value;
	}
}
function validateCondition(config, value, path = "$.when") {
	jsonData(value, path);
	let nodes = 0;
	const fields = new Map(config.fields.map((field) => [field.name, field]));
	function walk(input, at, depth) {
		if (++nodes > 128 || depth > 8) fail(at, "条件超过深度或节点上限");
		const item = object(input, at, [
			"all",
			"any",
			"field",
			"op",
			"value"
		]);
		if (Object.hasOwn(item, "all") || Object.hasOwn(item, "any")) {
			const key = Object.hasOwn(item, "all") ? "all" : "any";
			object(item, at, [key]);
			const children = item[key];
			if (!Array.isArray(children) || !children.length) return fail(at, "条件组不能为空");
			const conditions = children.map((child, i) => walk(child, `${at}.${key}[${i}]`, depth + 1));
			return key === "all" ? { all: conditions } : { any: conditions };
		}
		object(item, at, [
			"field",
			"op",
			"value"
		]);
		const name = normalizeName(item.field, `${at}.field`);
		const field = fields.get(name);
		if (!field) return fail(`${at}.field`, "引用不存在的字段");
		const op = item.op;
		if (![
			"eq",
			"ne",
			"gt",
			"gte",
			"lt",
			"lte"
		].includes(String(op))) return fail(`${at}.op`, "未知比较");
		const raw = item.value;
		if (field.type === "number") finite(raw, `${at}.value`);
		else if (field.type === "boolean") bool(raw, `${at}.value`);
		else if (typeof raw !== "string" || raw.length > 2e3) fail(`${at}.value`, "比较值类型不符");
		if (op !== "eq" && op !== "ne" && field.type !== "number") fail(at, "顺序比较仅适用数字");
		return {
			field: name,
			op,
			value: typeof raw === "string" ? raw.replace(/\r\n/g, "\n") : raw
		};
	}
	return walk(value, path, 1);
}
function validateConfig(input) {
	jsonData(input);
	if (bytes(JSON.stringify(input)) > 131072) fail("$", "定义超过 128 KiB");
	const value = object(input, "$", [
		"version",
		"enabled",
		"fields",
		"entries"
	]);
	if (value.version !== 1) fail("$.version", "未知版本");
	const enabled = bool(value.enabled, "$.enabled");
	if (!Array.isArray(value.fields) || value.fields.length > 32 || enabled && !value.fields.length) fail("$.fields", "字段数量无效");
	if (!Array.isArray(value.entries) || value.entries.length > 64) fail("$.entries", "条目数量无效");
	const names = /* @__PURE__ */ new Set();
	const config = {
		version: 1,
		enabled,
		fields: value.fields.map((raw, i) => {
			const at = `$.fields[${i}]`;
			const item = object(raw, at, [
				"name",
				"type",
				"initial",
				"visible",
				"aiWritable",
				"pluginWritable",
				"updateRule",
				"min",
				"max",
				"options"
			]);
			const name = normalizeName(item.name, `${at}.name`);
			if (names.has(name)) fail(`${at}.name`, "名称重复");
			names.add(name);
			const base = {
				name,
				visible: bool(item.visible, `${at}.visible`),
				aiWritable: bool(item.aiWritable, `${at}.aiWritable`)
			};
			if (!base.visible && base.aiWritable) fail(at, "隐藏字段不可由 AI 更新");
			const extra = {};
			if (Object.hasOwn(item, "pluginWritable")) extra.pluginWritable = bool(item.pluginWritable, `${at}.pluginWritable`);
			if (Object.hasOwn(item, "updateRule")) extra.updateRule = text(item.updateRule, `${at}.updateRule`, 1e3, base.aiWritable);
			if (base.aiWritable && !extra.updateRule) fail(`${at}.updateRule`, "需要更新规则");
			const common = [
				"name",
				"type",
				"initial",
				"visible",
				"aiWritable",
				"pluginWritable",
				"updateRule"
			];
			let field;
			if (item.type === "number") {
				object(item, at, [
					...common,
					"min",
					"max"
				]);
				const range = {};
				for (const key of ["min", "max"]) if (Object.hasOwn(item, key)) {
					finite(item[key], `${at}.${key}`);
					range[key] = item[key];
				}
				if (range.min !== void 0 && range.max !== void 0 && range.min > range.max) fail(at, "min 大于 max");
				field = {
					...base,
					...extra,
					...range,
					type: "number",
					initial: item.initial
				};
			} else if (item.type === "choice") {
				object(item, at, [...common, "options"]);
				if (!Array.isArray(item.options) || !item.options.length || item.options.length > 32) fail(`${at}.options`, "选项数量无效");
				const options = item.options.map((entry, n) => text(entry, `${at}.options[${n}]`, 100, true));
				if (new Set(options).size !== options.length) fail(`${at}.options`, "选项重复");
				field = {
					...base,
					...extra,
					type: "choice",
					options,
					initial: item.initial
				};
			} else if (item.type === "text" || item.type === "boolean") {
				object(item, at, common);
				field = {
					...base,
					...extra,
					type: item.type,
					initial: item.initial
				};
			} else return fail(`${at}.type`, "未知字段类型");
			field.initial = validateValue(field, item.initial, `${at}.initial`);
			return field;
		}),
		entries: []
	};
	names.clear();
	let total = 0;
	config.entries = value.entries.map((raw, i) => {
		const at = `$.entries[${i}]`;
		const item = object(raw, at, [
			"name",
			"when",
			"text"
		]);
		const name = normalizeName(item.name, `${at}.name`);
		if (names.has(name)) fail(`${at}.name`, "名称重复");
		names.add(name);
		const body = text(item.text, `${at}.text`, 8e3);
		total += body.length;
		if (total > 5e4) fail("$.entries", "正文合计超过 50000 字符");
		return {
			name,
			text: body,
			when: validateCondition(config, item.when, `${at}.when`)
		};
	});
	return config;
}
function initialValues(config) {
	return Object.fromEntries(validateConfig(config).fields.map((field) => [field.name, field.initial]));
}
function validateValues(config, values) {
	jsonData(values);
	const input = object(values, "$.values", config.fields.map((field) => field.name));
	return Object.fromEntries(config.fields.map((field) => [field.name, validateValue(field, input[field.name], `$.values.${field.name}`)]));
}
// src/role-dynamics/history.ts
function canonical(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value).sort().filter((key) => value[key] !== void 0).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
function prefixes(cut) {
	if (cut.seq !== cut.events.length || !Number.isSafeInteger(cut.inheritedEventCount) || cut.inheritedEventCount < 0 || cut.inheritedEventCount > cut.seq) fail("$.history", "历史截点不完整", "history");
	const chain = [digest([])];
	cut.events.forEach((event, i) => {
		if (event.seq !== i || !event.type || !event.data) fail("$.history", "事件序列不连续", "history");
		chain.push(digest([chain[i], event]));
	});
	return chain;
}
function anchor(cut, phase, seq = cut.seq) {
	const count = seq + (phase === "after" ? 1 : 0);
	const prefix = prefixes(cut)[count];
	if (!prefix) return fail("$.history", "锚点超过事件截点", "history");
	return {
		sessionId: cut.header.id,
		seq,
		phase,
		prefix
	};
}
function matches(position, cut, includeTail) {
	const count = position.seq + (position.phase === "after" ? 1 : 0);
	const chain = prefixes(cut);
	return (position.phase === "after" || position.seq < cut.seq || includeTail) && chain[count] === position.prefix && (position.phase === "after" || position.nextPrefix === void 0 || chain[position.seq + 1] === position.nextPrefix);
}
function turnEnd(cut, startSeq) {
	const start = cut.events[startSeq];
	if (start?.type !== "turn/start") return void 0;
	for (const event of cut.events.slice(startSeq + 1)) {
		if (event.type === "turn/start") return void 0;
		if (event.type === "turn/end" && event.data.turn === start.data.turn) return event;
	}
}
function completed(cut, startSeq) {
	const end = turnEnd(cut, startSeq);
	if ((end?.data.reason)?.kind !== "completed") return void 0;
	return cut.events.slice(startSeq + 1, end.seq).some((event) => event.type === "assistant/message" && event.data.turn === cut.events[startSeq].data.turn && event.data.interrupted !== true) ? end : void 0;
}
function successfulCall(cut, startSeq, callSeq, callId) {
	const end = completed(cut, startSeq);
	const call = cut.events[callSeq];
	if (!end || !call || call.seq <= startSeq || call.seq >= end.seq || !validStateCall(cut, startSeq, call, callId)) return false;
	if (call.type === "tool/ptc-dispatch-start") {
		const root = ptcRoot(cut, startSeq, call);
		if (!root || !successfulRoot(cut, startSeq, root.seq, String(call.data.rootCallId))) return false;
		const boundary = cut.events.slice(callSeq + 1, end.seq).find((event) => event.type === "tool/ptc-dispatch-start" && event.data.subCallId === callId && event.data.rootCallId === call.data.rootCallId || event.type === "tool/call" && event.data.callId === call.data.rootCallId)?.seq ?? end.seq;
		const results = cut.events.slice(callSeq + 1, boundary).filter((event) => event.type === "tool/ptc-dispatch" && event.data.subCallId === callId && event.data.rootCallId === call.data.rootCallId && event.data.parentCallId === call.data.parentCallId);
		return results.length === 1 && results[0].data.name === "qqbot_update_state" && results[0].data.isError === false && !Object.hasOwn(results[0].data, "error");
	}
	return successfulRoot(cut, startSeq, callSeq, callId);
}
/** rc.5 Native root and PTC sub-dispatch identities are both real host events. */
function validStateCall(cut, startSeq, call, callId) {
	if (call.data.name !== "qqbot_update_state") return false;
	if (call.type === "tool/call") return call.data.callId === callId && call.data.turn === cut.events[startSeq]?.data.turn;
	if (call.type !== "tool/ptc-dispatch-start" || call.data.subCallId !== callId || typeof call.data.rootCallId !== "string" || typeof call.data.parentCallId !== "string") return false;
	const root = ptcRoot(cut, startSeq, call);
	return root !== void 0 && !cut.events.slice(root.seq + 1, call.seq).some((event) => event.type === "tool/result" && event.sourceEventSeqs?.includes(root.seq));
}
function ptcRoot(cut, startSeq, call) {
	return cut.events.slice(startSeq + 1, call.seq).findLast((event) => event.type === "tool/call" && event.data.callId === call.data.rootCallId && event.data.name === "run_code" && event.data.turn === cut.events[startSeq]?.data.turn);
}
function successfulRoot(cut, startSeq, callSeq, callId) {
	const end = completed(cut, startSeq);
	if (!end) return false;
	const call = cut.events[callSeq];
	const results = cut.events.slice(callSeq + 1, end.seq).filter((event) => event.type === "tool/result" && event.sourceEventSeqs?.includes(callSeq));
	if (results.length !== 1) return false;
	const data = results[0].data;
	const message = data.message;
	return data.turn === call.data.turn && message?.toolCallId === callId && message.isError === false && !Object.hasOwn(data, "error");
}
// src/data-transactions.ts
/** 本插件多文件数据事务：原件备份先完成，manifest 最后提交；启动时撤销未提交单元。 */
function inside(root, path) {
	const absolute = resolve(path);
	const rel = relative(resolve(root), absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("事务路径超出本插件数据范围");
	for (let current = absolute; current !== resolve(root); current = dirname(current)) if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("事务拒绝联接或符号链接");
	if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("事务数据根目录是联接");
	return absolute;
}
function checksum(path) {
	if (lstatSync(path).isSymbolicLink()) throw new Error("事务备份拒绝符号链接");
	const hash = createHash("sha256");
	if (lstatSync(path).isDirectory()) for (const name of readdirSync(path).sort()) hash.update(JSON.stringify([name, checksum(join(path, name))]));
	else hash.update(readFileSync(path));
	return hash.digest("hex");
}
var FileDataTransaction = class FileDataTransaction {
	root;
	manifest;
	fault;
	dir;
	constructor(root, domain, manifest, fault) {
		this.root = root;
		this.manifest = manifest;
		this.fault = fault;
		this.dir = inside(root, join(root, domain, manifest.stamp));
	}
	static prepare(root, domain, paths, metadata, fault = () => {}) {
		FileDataTransaction.recover(root, domain);
		const stamp = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
		const entries = [...new Set(paths.map((path) => relative(root, inside(root, path))))];
		if (entries.some((path) => path === domain || path.startsWith(`${domain}${sep}`))) throw new Error("事务不能覆盖自己的备份目录");
		if (entries.some((a) => entries.some((b) => a !== b && b.startsWith(`${a}${sep}`)))) throw new Error("事务路径重叠");
		const tx = new FileDataTransaction(root, domain, {
			version: 1,
			stamp,
			state: "prepared",
			paths: [],
			metadata
		}, fault);
		mkdirSync(tx.dir, { recursive: true });
		entries.forEach((path, index) => {
			const from = inside(root, join(root, path));
			const existed = existsSync(from);
			if (existed) {
				const sum = checksum(from);
				cpSync(from, join(tx.dir, `original-${index}`), {
					recursive: true,
					errorOnExist: true,
					force: false
				});
				if (sum !== checksum(join(tx.dir, `original-${index}`))) throw new Error("事务备份核对失败");
				tx.manifest.paths.push({
					path,
					existed,
					checksum: sum
				});
			} else tx.manifest.paths.push({
				path,
				existed
			});
		});
		tx.persist();
		try {
			fault("prepared");
		} catch (error) {
			tx.manifest.state = "rolled-back";
			tx.persist();
			throw error;
		}
		return tx;
	}
	persist() {
		writeJson(join(this.dir, "manifest.json"), this.manifest);
	}
	/** ROLE.md 的唯一预期新字节，防止失败恢复覆盖等待期间的外部手写修改。 */
	expectFile(path, text, newDirectory = false) {
		const relativePath = relative(this.root, inside(this.root, newDirectory ? dirname(path) : path));
		const entry = this.manifest.paths.find((item) => item.path === relativePath);
		if (!entry) throw new Error("事务文件未登记");
		const sum = createHash("sha256").update(text).digest("hex");
		entry.expected = newDirectory ? createHash("sha256").update(JSON.stringify(["ROLE.md", sum])).digest("hex") : sum;
		this.persist();
	}
	changed() {
		this.fault("changed");
	}
	commit() {
		this.fault("commit");
		this.manifest.state = "committed";
		this.persist();
		this.fault("committed");
	}
	get committed() {
		return JSON.parse(readFileSync(join(this.dir, "manifest.json"), "utf8")).state === "committed";
	}
	rollback() {
		if (this.committed) throw new Error("已提交事务不能自动撤销");
		this.fault("rollback");
		this.manifest.paths.forEach((entry, index) => {
			inside(this.root, join(this.root, entry.path));
			if (entry.existed && checksum(join(this.dir, `original-${index}`)) !== entry.checksum) throw new Error("事务备份损坏，原件保留待恢复");
			const current = join(this.root, entry.path);
			if (entry.expected && existsSync(current)) {
				const sum = checksum(current);
				if (sum !== entry.checksum && sum !== entry.expected) throw new Error("角色文件在事务期间被外部修改，当前文件和备份均保留");
			}
		});
		this.manifest.paths.forEach((entry, index) => {
			const path = inside(this.root, join(this.root, entry.path));
			rmSync(path, {
				recursive: true,
				force: true
			});
			if (entry.existed) {
				mkdirSync(dirname(path), { recursive: true });
				cpSync(join(this.dir, `original-${index}`), path, { recursive: true });
			}
		});
		this.manifest.state = "rolled-back";
		this.persist();
	}
	static recover(root, domain) {
		const directory = inside(root, join(root, domain));
		if (!existsSync(directory)) return;
		for (const name of readdirSync(directory)) {
			if (!/^[a-zA-Z0-9-]{1,100}$/.test(name)) throw new Error("事务清单目录无效");
			const file = inside(root, join(directory, name, "manifest.json"));
			if (!existsSync(file)) continue;
			const raw = JSON.parse(readFileSync(file, "utf8"));
			if (raw.version !== 1 || raw.stamp !== name || ![
				"prepared",
				"committed",
				"rolled-back"
			].includes(raw.state) || !Array.isArray(raw.paths)) throw new Error("事务清单损坏，原件已保留");
			for (const entry of raw.paths) {
				if (typeof entry.path !== "string" || isAbsolute(entry.path) || typeof entry.existed !== "boolean") throw new Error("事务路径清单损坏");
				if (relative(root, inside(root, join(root, entry.path))) !== entry.path || entry.path === domain || entry.path.startsWith(`${domain}${sep}`)) throw new Error("事务路径清单损坏");
			}
			if (raw.state === "prepared") new FileDataTransaction(root, domain, raw, () => {}).rollback();
		}
	}
};
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
// src/agent-preset.ts
/** 不同宿主构建的预设读取接口不同；回退只读实时绑定，不读创建时的 header。 */
function presetForAgent(presets, agent) {
	if (typeof presets.presetForSession === "function") return presets.presetForSession(agent.session);
	if (typeof presets.composedPreset === "function") return presets.composedPreset(agent.ctx) ?? null;
	return null;
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
	DYNAMICS_TOOL: 430,
	EXT: 500,
	ROLE_MEMORY: 800,
	JB_TAIL: 900
};
/** DSH 自带 context 在 100–210，qqbot:runtime 排在它们之后。 */
const CONTEXT_ORDER = {
	RUNTIME: 1e3,
	ROLE_DYNAMICS: 1010
};
const SECTION_NAME = {
	PROMPT: "qqbot:prompt",
	JB_HEAD: "qqbot:jb-head",
	PERSONA: "qqbot:persona",
	JB_MID: "qqbot:jb-mid",
	FORMAT_SEGMENT: "qqbot:format-segment",
	FORMAT_MEME: "qqbot:format-meme",
	FORMAT_VOICE: "qqbot:format-voice",
	DYNAMICS_TOOL: "qqbot:dynamics-tool",
	JB_TAIL: "qqbot:jb-tail",
	EXT_PREFIX: "qqbot:ext:",
	ROLE_MEMORY: "qqbot:role-memory"
};
const CONTEXT_NAME = {
	RUNTIME: "qqbot:runtime",
	ROLE_DYNAMICS: "qqbot:role-dynamics"
};
// src/meme-scope.ts
/** QQ 表情的共享检索与显示协议；只在已经限定的图库中匹配。 */
const MEME_SCOPE_PATH = "/api/qqbot/memes";
const fold = (text) => text.normalize("NFKC").trim().toLocaleLowerCase().replace(/[“”‘’]/g, "\"").replace(/\s+/g, " ");
/** 标签和关键词只缩小当前角色候选，不跨图库回退。 */
function searchMemes(rows, tag = "", query = "", limit = 3) {
	const words = fold(query).split(/\s+/).filter(Boolean);
	const candidates = rows.filter((row) => (!tag || fold(row.tag) === fold(tag)) && words.every((word) => fold(`${row.caption} ${row.keywords} ${row.path}`).includes(word)));
	const start = Math.floor(Math.random() * candidates.length);
	return Array.from({ length: Math.min(candidates.length, Math.max(1, Math.min(10, Math.floor(limit) || 3))) }, (_, i) => candidates[(start + i) % candidates.length]);
}
/** 候选自带图库和路径身份，描述同名也不会串图。标识只用于消息协议，界面不显示。 */
function memeKey(row) {
	return `qqbot:${encodeURIComponent(row.pack)}:${encodeURIComponent(row.path)}`;
}
function memeMarker(row) {
	return `[表情: ${memeKey(row)}]`;
}
// src/meme-agent.ts
var meme_agent_exports = /* @__PURE__ */ __exportAll({
	MEME_DESCRIPTION: () => MEME_DESCRIPTION,
	MEME_PARAMETERS: () => MEME_PARAMETERS,
	apply: () => apply$4,
	inject: () => inject$4,
	name: () => name$4,
	scopedMemeTool: () => scopedMemeTool,
	toolDeclaration: () => toolDeclaration$1
});
const MEME_DESCRIPTION = "从当前角色的可用图库中按标签或关键词找表情。挑选贴合的一张，将候选的 marker 原样写进回复；没有合适候选时继续文字回应。";
const MEME_PARAMETERS = {
	type: "object",
	properties: {
		tag: {
			type: "string",
			description: "表情分类，可用分类见结果 tags。"
		},
		query: {
			type: "string",
			description: "描述或关键词。"
		},
		limit: {
			type: "number",
			description: "候选数量，默认 3，最多 10。"
		}
	},
	additionalProperties: false
};
/** rc.5 的 complete section 会移除 PTC SDK，补回本工具自己的声明。 */
function toolDeclaration$1(ctx, input) {
	const tools = ctx.get("tools");
	if (!input.agent || tools?.modeFor?.(input.scope) !== "ptc" || !tools.get("send_meme", input.agent)) return "";
	return `tools.${MEME_TOOL}\n${JSON.stringify({
		name: MEME_TOOL,
		description: MEME_DESCRIPTION,
		parameters: MEME_PARAMETERS
	})}`;
}
function scopedMemeTool(ctx, agent) {
	return {
		name: MEME_TOOL,
		description: MEME_DESCRIPTION,
		parameters: MEME_PARAMETERS,
		output: {
			schema: { type: "object" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args, exec) {
			ctx.qqbot.maintenance.assertAvailable();
			if (exec.agent !== agent || !ctx.tools.get("send_meme") || exec.signal.aborted) throw new Error("表情工具当前不可用");
			const data = ctx.qqbot.content;
			data.roles.reload();
			const selected = () => {
				const role = data.roleFor({ id: agent.id });
				return {
					id: role?.id,
					packs: role?.memePacks ?? []
				};
			};
			const before = selected();
			const result = await ctx.qqbot.memes.read(before.packs, AbortSignal.any([exec.signal, AbortSignal.timeout(15e3)]));
			data.roles.reload();
			ctx.qqbot.maintenance.assertAvailable();
			if (exec.signal.aborted || !ctx.tools.get("send_meme") || JSON.stringify(selected()) !== JSON.stringify(before)) throw new Error("角色表情设置已变化，请重新选图");
			const input = isRecord(args) ? args : {};
			const hits = searchMemes(result.memes, typeof input["tag"] === "string" ? input["tag"] : "", typeof input["query"] === "string" ? input["query"] : "", typeof input["limit"] === "number" ? input["limit"] : 3);
			return {
				hits: hits.map((row) => ({
					caption: row.caption,
					tag: row.tag,
					marker: memeMarker(row)
				})),
				tags: [...new Set(result.memes.map((row) => row.tag))],
				message: result.message ?? (hits.length ? "将选中候选的 marker 原样写进回复。" : "没有匹配的表情，可按 tags 换词检索，或继续文字回应。")
			};
		}
	};
}
const name$4 = "qqbot-meme-scope";
const inject$4 = ["qqbot", "tools"];
function apply$4(ctx) {
	const agents = /* @__PURE__ */ new Map();
	let syncing = false;
	const sync = () => {
		if (syncing) return;
		syncing = true;
		try {
			const available = !!ctx.tools.get(MEME_TOOL);
			for (const [agent, dispose] of agents) {
				if (available && !dispose) agents.set(agent, agent.ctx.tools.register(scopedMemeTool(ctx, agent)));
				if (!available && dispose) {
					agents.set(agent, void 0);
					dispose();
				}
			}
		} finally {
			syncing = false;
		}
	};
	const attach = (agent) => {
		const presets = ctx.get("agentPresets");
		if (presets && presetForAgent(presets, agent) !== "qqbot") return;
		if (agents.has(agent)) return;
		agents.set(agent, void 0);
		sync();
	};
	ctx.on("agent/created", ({ agent }) => {
		attach(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		const dispose = agents.get(agent);
		agents.delete(agent);
		dispose?.();
	});
	ctx.on("tools/change", sync);
	if (ctx.get("agentPresets")) for (const agent of ctx.get("agents")?.list() ?? []) attach(agent);
	ctx.effect(() => () => {
		const disposers = [...agents.values()];
		agents.clear();
		for (const dispose of disposers) dispose?.();
	}, "qqbot: scoped meme tools");
}
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
	apply: () => apply$3,
	inject: () => inject$3,
	name: () => name$3
});
const name$3 = "qqbot-memory";
const inject$3 = [
	"qqbot",
	"llm",
	"agents"
];
function apply$3(ctx) {
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
	apply: () => apply$2,
	inject: () => inject$2,
	name: () => name$2,
	overview: () => overview,
	runRole: () => runRole
});
const name$2 = "qqbot-role-command";
const inject$2 = [
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
		`预设：${preset.name}`,
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
function apply$2(ctx) {
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
				const host = ctx.qqbot.dynamicsHost, nextRole = data.roles.find(rawInput.trim())?.id;
				if (!busy && host?.needsSelection(agent.id, nextRole)) return host.prepareSelection(agent.id, nextRole).then(() => {
					const current = (ctx.get?.("agents") ?? agent.ctx.get("agents"))?.get(agent.id);
					const presets = ctx.get?.("agentPresets") ?? agent.ctx.get("agentPresets");
					if (current !== agent || !presets || presetForAgent(presets, current) !== "qqbot") return {
						kind: "error",
						text: "角色没有切换：请在 QQ Bot 对话中选择角色。"
					};
					return runRole(data, { id: current.id }, rawInput, current.status !== "idle" || current.inbox.nextTurn.length > 0 || current.inbox.nextStep.length > 0);
				}).catch((error) => ({
					kind: "error",
					text: `角色没有切换：${error.message}`
				}));
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
// src/role-transactions.ts
/** 第04步数据层协调；第06步由唯一宿主服务绑定真实核心与维护门禁。 */
const progressDirectory = (root, id) => join(root, "role-dynamics", "roles", createHash("sha256").update(id).digest("hex"));
var RoleDataTransactions = class {
	roles;
	options;
	root;
	active = false;
	unregister;
	constructor(roles, options = {}) {
		this.roles = roles;
		this.options = options;
		this.root = dirname(roles.dir);
		FileDataTransaction.recover(this.root, "role-transactions");
		roles.useTransactions(this);
		if (options.dynamics && options.maintenance) {
			const service = options.dynamics;
			this.unregister = options.maintenance.register({
				cache: () => service.clearCaches(),
				prepare: () => {
					try {
						service.invalidate(options.maintenance.view().dataEpoch);
					} finally {
						options.invalidated?.();
					}
				},
				reload: () => {
					try {
						service.invalidate(options.maintenance.view().dataEpoch);
					} finally {
						options.invalidated?.();
					}
				}
			});
		}
	}
	dispose() {
		this.unregister?.();
		this.unregister = void 0;
	}
	async run(id, body) {
		if (this.active) throw new Error("角色资料正在保存，请稍后再试");
		this.roles.assertReady(id);
		this.active = true;
		this.roles.reserve(id, true);
		const work = async (guard) => {
			if (this.options.prepareHistory) await this.options.prepareHistory(id);
			guard();
			if (this.options.dynamics) return this.options.dynamics.withRolePersistence(id, (core) => body(() => {
				guard();
				core.guard();
			}, core));
			if (existsSync(progressDirectory(this.root, id))) throw new Error("动态进度服务未接入，角色资料保持原样");
			return body(guard);
		};
		try {
			return this.options.maintenance ? await this.options.maintenance.write(work) : await work(() => {});
		} finally {
			this.active = false;
			this.roles.reserve(id, false);
			this.roles.reload();
		}
	}
	save(prepared) {
		return this.run(prepared.id, async (guard, core) => {
			const { id, current, draft } = prepared;
			if (current?.dynamicsError) throw new Error(current.dynamicsError);
			if (!(draft.dynamics !== void 0 && (draft.resetDynamics === true || digest(current?.dynamics ?? null) !== digest(draft.dynamics)))) {
				guard();
				return this.roles.publish(prepared);
			}
			const next = draft.dynamics ?? void 0;
			const progress = progressDirectory(this.root, id);
			await core?.prepare();
			if ((existsSync(prepared.file) ? readFileSync(prepared.file, "utf8") : void 0) !== prepared.existing) {
				this.roles.gate(id, true);
				throw new Error("角色保存失败，事务需要恢复，等待期间角色文件已变化，当前文件已保留");
			}
			const compatible = core && current?.dynamics && next ? core.plan(next, { ...draft.dynamicsRenames }).compatible : false;
			if (core && current?.dynamics && next && !compatible && !draft.resetDynamics) throw new Error("需要重置该角色各会话进度后应用");
			if (!next && existsSync(progress) && !draft.resetDynamics) throw new Error("删除动态设定需要重置该角色各会话进度后应用");
			guard();
			const tx = FileDataTransaction.prepare(this.root, "role-transactions", [prepared.create ? dirname(prepared.file) : prepared.file, progress], {
				kind: "configuration",
				roleId: id,
				from: current?.dynamicsRevision,
				to: digest(next ?? null)
			}, this.options.fault);
			try {
				tx.expectFile(prepared.file, prepared.text, prepared.create);
				if (core && current?.dynamics) {
					if (draft.resetDynamics) {
						if (next && compatible) core.approve(next, { ...draft.dynamicsRenames });
						await core.reset(next);
					} else if (next) core.approve(next, { ...draft.dynamicsRenames });
					else core.invalidate();
				}
				guard();
				if (!next && existsSync(progress)) renameWithRetry(progress, inside(this.root, join(tx.dir, "removed-progress")));
				const saved = this.roles.publish(prepared);
				if (core && next && current?.dynamics && draft.resetDynamics) core.approve(next);
				tx.changed();
				guard();
				tx.commit();
				return saved;
			} catch (error) {
				if (!tx.committed) try {
					guard();
					tx.rollback();
					this.roles.reload();
					core?.invalidate();
				} catch (recovery) {
					this.roles.gate(id, true);
					throw new Error("角色保存失败，事务需要恢复，资料门禁保持关闭", { cause: new AggregateError([error, recovery]) });
				}
				throw error;
			}
		});
	}
	remove(id, extras) {
		return this.run(id, async (guard, core) => {
			const file = this.roles.fileFor(id);
			if (!file) throw new Error("角色已不存在");
			const source = basename(file) === "ROLE.md" && dirname(dirname(file)) === this.roles.dir ? dirname(file) : file;
			const progress = progressDirectory(this.root, id);
			await core?.prepare();
			const paths = [source, ...extras].filter((path) => existsSync(inside(this.root, path)));
			const tx = FileDataTransaction.prepare(this.root, "role-transactions", [...paths, progress], {
				kind: "remove",
				roleId: id,
				sources: paths
			}, this.options.fault);
			const trash = join(this.root, "roles-trash", tx.manifest.stamp);
			try {
				guard();
				core?.detach(tx.manifest.stamp);
				mkdirSync(trash, { recursive: true });
				for (let index = 0; index < paths.length; index++) renameWithRetry(paths[index], join(trash, `${index}-${basename(paths[index])}`));
				tx.changed();
				guard();
				tx.commit();
				return tx.manifest.stamp;
			} catch (error) {
				if (!tx.committed) try {
					guard();
					const coreTrash = join(this.root, "role-dynamics", "trash", `${digest(id)}-${tx.manifest.stamp}`);
					if (core && existsSync(coreTrash)) core.restore(tx.manifest.stamp);
					else core?.release();
					tx.rollback();
					core?.invalidate();
				} catch (recovery) {
					this.roles.gate(id, true);
					throw new Error("角色回收失败，事务需要恢复", { cause: new AggregateError([error, recovery]) });
				}
				throw error;
			}
		});
	}
	async restore(stamp) {
		if (!/^[a-zA-Z0-9-]{1,100}$/.test(stamp)) throw new Error("回收标识无效");
		const directory = inside(this.root, join(this.root, "role-transactions", stamp));
		const removal = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
		if (removal.state !== "committed" || removal.metadata.kind !== "remove") throw new Error("没有已完成的角色回收记录");
		const { roleId, sources } = removal.metadata;
		return this.run(roleId, async (guard, core) => {
			const progress = progressDirectory(this.root, roleId);
			if (this.roles.get(roleId) || sources.some((path) => existsSync(inside(this.root, path))) || existsSync(progress)) throw new Error("角色位置已有资料，不能覆盖恢复");
			const trash = inside(this.root, join(this.root, "roles-trash", stamp));
			const coreTrash = inside(this.root, join(this.root, "role-dynamics", "trash", `${digest(roleId)}-${stamp}`));
			const paths = [
				...sources,
				progress,
				trash,
				coreTrash
			];
			const tx = FileDataTransaction.prepare(this.root, "role-transactions", paths, {
				kind: "restore",
				roleId,
				stamp
			}, this.options.fault);
			try {
				guard();
				if (existsSync(coreTrash)) {
					if (!core) throw new Error("动态进度服务未接入");
					core.restore(stamp);
				}
				for (let index = 0; index < sources.length; index++) {
					const target = inside(this.root, sources[index]);
					mkdirSync(dirname(target), { recursive: true });
					renameWithRetry(join(trash, `${index}-${basename(target)}`), target);
				}
				tx.changed();
				guard();
				tx.commit();
				core?.release();
			} catch (error) {
				if (tx.committed) core?.release();
				if (!tx.committed) try {
					guard();
					tx.rollback();
					core?.detach(stamp);
				} catch (recovery) {
					this.roles.gate(roleId, true);
					throw new Error("角色恢复失败，事务需要恢复", { cause: new AggregateError([error, recovery]) });
				}
				throw error;
			}
		});
	}
};
// src/role-dynamics/host-history.ts
/** rc.5 public sessionQuery observations; no writes to the host log. */
var HostHistoryView = class {
	host;
	cuts = /* @__PURE__ */ new Map();
	publications = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(host) {
		this.host = host;
	}
	/** The caller subscribes before the first asynchronous observation. */
	observe(session, event) {
		if (this.disposed) return;
		const cut = this.cuts.get(session.id);
		if (!cut && !this.publications.has(session.id)) return;
		if (cut && event.seq === cut.seq) {
			cut.events.push(structuredClone(event));
			cut.seq++;
		}
		for (const pending of this.publications.get(session.id) ?? []) pending.push(structuredClone(event));
	}
	async prepare(id, ancestors = /* @__PURE__ */ new Set(), inherit = false) {
		if (this.disposed) throw new Error("动态历史读取已停止");
		if (ancestors.has(id)) throw new Error("会话分叉血缘循环");
		const pending = [], readers = this.publications.get(id) ?? /* @__PURE__ */ new Set();
		readers.add(pending);
		this.publications.set(id, readers);
		let lease;
		try {
			lease = await this.host().sessionQuery.observeSession(id, { projections: "none" });
		} catch (error) {
			readers.delete(pending);
			if (!readers.size) this.publications.delete(id);
			throw error;
		}
		let cut;
		try {
			cut = {
				header: structuredClone(lease.header),
				inheritedEventCount: lease.inheritedEventCount,
				seq: lease.cursor + 1,
				events: structuredClone([...lease.events])
			};
		} finally {
			lease[Symbol.dispose]();
			readers.delete(pending);
			if (!readers.size) this.publications.delete(id);
		}
		if (this.disposed) throw new Error("动态历史读取已停止");
		prefixes(cut);
		if (cut.header.id !== id) throw new Error("动态历史会话身份不匹配");
		const live = this.host().sessions.get(id);
		for (const event of pending.sort((a, b) => a.seq - b.seq)) {
			if (event.seq < cut.seq || !live || event.seq >= live.seq) continue;
			if (event.seq !== cut.seq) throw new Error("动态历史观察缺少事件");
			cut.events.push(structuredClone(event));
			cut.seq++;
		}
		if (live && live.seq !== cut.seq) throw new Error("动态历史观察尚未追齐");
		prefixes(cut);
		this.cuts.set(id, cut);
		if (inherit && cut.header.isSeeded && cut.header.parentSession) await this.prepare(cut.header.parentSession, /* @__PURE__ */ new Set([...ancestors, id]), true);
	}
	capture(id) {
		if (this.disposed) throw new Error("动态历史读取已停止");
		const cut = this.cuts.get(id);
		if (!cut) throw new Error("动态历史尚未准备");
		const live = this.host().sessions.get(id);
		if (live && live.seq !== cut.seq) throw new Error("动态历史观察尚未追齐");
		return structuredClone(cut);
	}
	async flush(id) {
		await this.prepare(id);
		const cut = this.capture(id);
		const live = this.host().sessions.get(id);
		if (live && !await this.host().sessions.flush(live)) throw new Error("会话历史没有持久化屏障");
		if (this.disposed) throw new Error("动态历史读取已停止");
		await this.prepare(id);
		if (prefixes(this.capture(id))[cut.seq] !== digestPrefix(cut)) throw new Error("持久化期间会话历史已变化");
		return cut;
	}
	clear() {
		this.cuts.clear();
		this.publications.clear();
	}
	dispose() {
		this.disposed = true;
		this.clear();
	}
};
function digestPrefix(cut) {
	return prefixes(cut).at(-1) ?? digest([]);
}
// src/role-dynamics/selection.ts
/** Role choices share the same real-event before boundary as owner state edits. */
var DynamicsSelections = class {
	file;
	constructor(file) {
		this.file = file;
	}
	load() {
		if (!existsSync(this.file)) return {
			version: 1,
			sessions: {},
			nextOrder: 0
		};
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8"));
			if (raw.version !== 1 || raw.checksum !== digest(raw.choices) || raw.choices.version !== 1 || !raw.choices.sessions || !Number.isSafeInteger(raw.choices.nextOrder)) throw Error("shape");
			return raw.choices;
		} catch {
			throw new Error("角色选择历史损坏，原件已保留");
		}
	}
	save(choices) {
		writeJson(this.file, {
			version: 1,
			checksum: digest(choices),
			choices
		});
	}
	has(sessionId) {
		return Object.hasOwn(this.load().sessions, sessionId);
	}
	/** Copy all necessary prefixes to the child so later forks need no parent. */
	inherit(cut, parent) {
		const choices = this.load();
		if (Object.hasOwn(choices.sessions, cut.header.id)) return this.current(cut);
		const records = choices.sessions[parent.header.id];
		if (!records) return void 0;
		if (!cut.header.isSeeded || cut.header.parentSession !== parent.header.id || cut.inheritedEventCount > parent.seq || prefixes(cut)[cut.inheritedEventCount] !== prefixes(parent)[cut.inheritedEventCount]) throw new Error("角色选择分叉前缀不匹配");
		const inherited = {
			...cut,
			seq: cut.inheritedEventCount,
			events: cut.events.slice(0, cut.inheritedEventCount)
		};
		const kept = records.filter((record) => matches(record.anchor, inherited, false));
		if (!kept.length) throw new Error("这个历史截点缺少角色选择基线");
		choices.sessions[cut.header.id] = structuredClone(kept);
		this.save(choices);
		return kept.at(-1).role;
	}
	current(cut) {
		return this.load().sessions[cut.header.id]?.filter((record) => matches(record.anchor, cut, true)).at(-1)?.role;
	}
	/** All historically selected roles still verifiable in this branch's cut. */
	roles(cut) {
		return [...new Set((this.load().sessions[cut.header.id] ?? []).filter((record) => record.role !== null && matches(record.anchor, cut, true)).map((record) => record.role))];
	}
	record(cut, role, start = false) {
		const choices = this.load();
		const records = choices.sessions[cut.header.id] ?? [];
		const before = digest(choices);
		const chain = prefixes(cut);
		for (const record of records) if (!record.anchor.nextPrefix && record.anchor.seq < cut.seq && chain[record.anchor.seq] === record.anchor.prefix) record.anchor.nextPrefix = chain[record.anchor.seq + 1];
		const last = records.filter((record) => matches(record.anchor, cut, true)).at(-1);
		if (last?.role !== role || !last) {
			const position = start && cut.events.at(-1)?.type === "turn/start" ? cut.seq - 1 : cut.seq;
			records.push({
				anchor: anchor(cut, "before", position),
				role,
				order: choices.nextOrder++
			});
		}
		choices.sessions[cut.header.id] = records;
		if (digest(choices) !== before) this.save(choices);
	}
	seal(cut) {
		if (!this.has(cut.header.id)) return;
		const role = this.current(cut);
		if (role !== void 0) this.record(cut, role);
	}
};
// src/role-dynamics/evolution.ts
function planEvolution(old, next, snapshots, renames = {}) {
	const previous = validateConfig(old);
	const config = validateConfig(next);
	jsonData(renames, "$.renames");
	const mapping = /* @__PURE__ */ new Map();
	const targets = /* @__PURE__ */ new Set();
	for (const [raw, target] of Object.entries(renames)) {
		const from = normalizeName(raw);
		const to = normalizeName(target);
		if (mapping.has(from) || targets.has(to)) fail("$.renames", "重命名必须一一对应");
		const a = previous.fields.find((field) => field.name === from);
		const b = config.fields.find((field) => field.name === to);
		if (!a || !b || a.type !== b.type || from !== to && previous.fields.some((field) => field.name === to)) fail("$.renames", "重命名来源、目标或类型不兼容");
		mapping.set(from, to);
		targets.add(to);
	}
	const issues = [];
	for (const field of previous.fields) {
		const name = mapping.get(field.name) ?? field.name;
		const replacement = config.fields.find((item) => item.name === name);
		let reason = !replacement ? "字段移除" : replacement.type !== field.type ? "字段类型变化" : "";
		const affected = [];
		for (const snapshot of snapshots) {
			const values = validateValues(previous, snapshot.values);
			if (!reason && replacement) try {
				validateValue(replacement, values[field.name]);
			} catch {
				affected.push(snapshot.progressId);
			}
			else affected.push(snapshot.progressId);
		}
		if (reason || affected.length) issues.push({
			field: field.name,
			progressIds: [...new Set(affected)],
			reason: reason || "历史值与新定义不兼容"
		});
	}
	const migrate = (values) => {
		if (issues.length) return fail("$.evolution", "需要重置该角色进度后应用", "incompatible");
		const state = validateValues(previous, values);
		const result = {};
		for (const field of config.fields) {
			const from = [...mapping].find(([, to]) => to === field.name)?.[0] ?? (mapping.has(field.name) ? void 0 : field.name);
			result[field.name] = from !== void 0 && Object.hasOwn(state, from) ? validateValue(field, state[from]) : field.initial;
		}
		return result;
	};
	return {
		compatible: issues.length === 0,
		config,
		issues,
		migrate
	};
}
// src/role-dynamics/projection.ts
function evaluate(values, condition) {
	if ("all" in condition) return condition.all.every((child) => evaluate(values, child));
	if ("any" in condition) return condition.any.some((child) => evaluate(values, child));
	const value = values[condition.field];
	switch (condition.op) {
		case "eq": return value === condition.value;
		case "ne": return value !== condition.value;
		case "gt": return value > condition.value;
		case "gte": return value >= condition.value;
		case "lt": return value < condition.value;
		case "lte": return value <= condition.value;
	}
}
function projectModel(config, values) {
	const valid = validateConfig(config);
	const state = validateValues(valid, values);
	if (!valid.enabled) return {
		fields: [],
		texts: []
	};
	const projection = {
		fields: valid.fields.filter((field) => field.visible).map((field) => {
			const base = {
				name: field.name,
				type: field.type,
				value: state[field.name]
			};
			if (!field.aiWritable) return {
				...base,
				writable: false
			};
			return {
				...base,
				writable: true,
				updateRule: field.updateRule,
				...field.type === "number" && field.min !== void 0 ? { min: field.min } : {},
				...field.type === "number" && field.max !== void 0 ? { max: field.max } : {},
				...field.type === "choice" ? { options: [...field.options] } : {}
			};
		}),
		texts: valid.entries.filter((entry) => evaluate(state, entry.when)).map((entry) => entry.text)
	};
	if (bytes(JSON.stringify(projection)) > 65536) fail("$.projection", "可见投影超过 64 KiB");
	return projection;
}
function diagnose(config, values) {
	const valid = validateConfig(config);
	const state = validateValues(valid, values);
	function detail(when) {
		if ("all" in when) return {
			matched: evaluate(state, when),
			all: when.all.map(detail)
		};
		if ("any" in when) return {
			matched: evaluate(state, when),
			any: when.any.map(detail)
		};
		return {
			...when,
			actual: state[when.field],
			matched: evaluate(state, when)
		};
	}
	return valid.entries.map((entry) => ({
		name: entry.name,
		matched: evaluate(state, entry.when),
		reason: detail(entry.when)
	}));
}
// src/role-dynamics/service.ts
const clone = (value) => structuredClone(value);
function freeze(value) {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}
const targetKey = (target) => digest([target.sessionId, target.roleId]);
/** No host imports. All mutations reload the authoritative journal inside the queue. */
var RoleDynamicsService = class {
	options;
	epoch;
	disposed = false;
	lifecycle = 0;
	queue = Promise.resolve();
	active;
	blockedRoles = /* @__PURE__ */ new Set();
	knownRoles = /* @__PURE__ */ new Set();
	sources = /* @__PURE__ */ new Map();
	handles = /* @__PURE__ */ new Map();
	stoppedTurns = /* @__PURE__ */ new Set();
	listeners = /* @__PURE__ */ new Map();
	ai;
	constructor(options) {
		this.options = options;
		this.epoch = options.epoch;
		this.ai = this.source("ai", "AI", "ai");
	}
	id() {
		return (this.options.id ?? randomUUID)();
	}
	now() {
		return (this.options.clock ?? Date.now)();
	}
	guard(epoch = this.active?.epoch ?? this.epoch, lifecycle = this.active?.lifecycle ?? this.lifecycle) {
		if (this.disposed || epoch !== this.epoch || lifecycle !== this.lifecycle) fail("$.lifecycle", "操作已失效", "stale");
	}
	run(body) {
		const epoch = this.epoch;
		const lifecycle = this.lifecycle;
		const next = this.queue.then(async () => {
			this.guard(epoch, lifecycle);
			this.active = {
				epoch,
				lifecycle
			};
			try {
				const result = await body();
				this.guard(epoch, lifecycle);
				return result;
			} finally {
				this.active = void 0;
			}
		});
		this.queue = next.catch(() => {});
		return next;
	}
	source(identity, name, kind) {
		const handle = freeze({
			token: this.id(),
			name
		});
		this.sources.set(handle.token, {
			identity,
			kind,
			active: true
		});
		return handle;
	}
	/** Called by trusted owner/host adapters; never expose source registration over model/HTTP JSON. */
	createOwnerSource() {
		this.guard(this.epoch, this.lifecycle);
		return this.source("owner", "用户", "owner");
	}
	registerSource(pluginIdentity, displayName) {
		this.guard(this.epoch, this.lifecycle);
		const identity = normalizeName(pluginIdentity);
		const name = normalizeName(displayName);
		if ([...this.sources.values()].some((source) => source.active && source.identity === `plugin:${identity}`)) fail("$.source", "来源已登记");
		const handle = this.source(`plugin:${identity}`, name, "plugin");
		return {
			handle,
			dispose: () => {
				const source = this.sources.get(handle.token);
				if (source) source.active = false;
			}
		};
	}
	authorize(handle) {
		const source = this.sources.get(handle?.token);
		if (!source?.active) return fail("$.source", "来源已失效", "source");
		return source;
	}
	config(roleId) {
		const input = this.options.config(roleId);
		return input === void 0 ? void 0 : validateConfig(input);
	}
	load(roleId) {
		this.knownRoles.add(roleId);
		const raw = this.options.store.load(roleId);
		if (raw === void 0) return {
			version: 1,
			roleId,
			configs: {},
			evolutions: [],
			progress: [],
			nextOrder: 0
		};
		try {
			jsonData(raw);
			const journal = raw;
			if (journal.version !== 1 || journal.roleId !== roleId || !Array.isArray(journal.progress) || !Array.isArray(journal.evolutions) || !Number.isSafeInteger(journal.nextOrder) || journal.nextOrder < 0) throw new Error("shape");
			for (const [revision, config] of Object.entries(journal.configs)) if (digest(validateConfig(config)) !== revision) throw new Error("config");
			const ids = /* @__PURE__ */ new Set();
			for (const progress of journal.progress) {
				if (!progress.id || ids.has(progress.id) || !progress.generation || !progress.sessionId || !Array.isArray(progress.observed) || !Array.isArray(progress.turns) || !Array.isArray(progress.receipts) || !Array.isArray(progress.records) || !progress.records.length) throw new Error("progress");
				ids.add(progress.id);
				for (const record of progress.records) {
					const snapshot = record.snapshot;
					const config = journal.configs[snapshot.configRevision];
					if (!config || snapshot.roleId !== roleId || snapshot.sessionId !== progress.sessionId || snapshot.generation !== progress.generation || snapshot.progressId !== progress.id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Number.isSafeInteger(record.order) || !Number.isSafeInteger(record.anchor.seq) || record.anchor.seq < 0 || !["before", "after"].includes(record.anchor.phase) || !/^[a-f0-9]{64}$/.test(record.anchor.prefix)) throw new Error("record");
					validateValues(config, snapshot.values);
				}
				for (const turn of progress.turns) {
					if (digest(validateConfig(turn.config)) !== turn.snapshot.configRevision || !Array.isArray(turn.candidates)) throw new Error("turn");
					validateValues(turn.config, turn.snapshot.values);
				}
			}
			const loaded = clone(journal);
			for (const progress of loaded.progress) for (const turn of progress.turns) if (this.stoppedTurns.has(turn.id)) turn.revoked = true;
			return loaded;
		} catch {
			return fail("$.journal", "进度日志损坏，原件已保留", "corrupt");
		}
	}
	save(journal) {
		this.guard();
		this.options.store.save(journal.roleId, journal, () => this.guard());
	}
	record(journal, progress, snapshot, position, source, operationId, payload, status, baseRevision, turnId) {
		const record = {
			order: journal.nextOrder++,
			anchor: clone(position),
			snapshot: clone(snapshot),
			source,
			operationId,
			payloadDigest: payload,
			status,
			baseRevision,
			time: this.now(),
			...turnId ? { turnId } : {}
		};
		progress.records.push(record);
		return record;
	}
	newProgress(target, cut) {
		return {
			sessionId: target.sessionId,
			id: this.id(),
			generation: this.id(),
			observed: prefixes(cut),
			records: [],
			turns: [],
			receipts: [],
			extensions: {}
		};
	}
	snapshot(target, progress, config, values = initialValues(config)) {
		return {
			...target,
			progressId: progress.id,
			generation: progress.generation,
			revision: 0,
			configRevision: digest(config),
			dataEpoch: this.epoch,
			values: clone(values)
		};
	}
	migrate(journal, snapshot, to, visited = /* @__PURE__ */ new Set()) {
		if (snapshot.configRevision === to) return clone(snapshot);
		if (visited.has(snapshot.configRevision)) return fail("$.evolution", "配置演进循环", "history");
		visited.add(snapshot.configRevision);
		const reaches = (from, seen = /* @__PURE__ */ new Set()) => {
			if (from === to) return true;
			if (seen.has(from)) return false;
			seen.add(from);
			return journal.evolutions.some((edge) => edge.from === from && reaches(edge.to, new Set(seen)));
		};
		const edge = [...journal.evolutions].reverse().find((item) => item.from === snapshot.configRevision && !visited.has(item.to) && reaches(item.to));
		if (!edge) return fail("$.evolution", "历史配置缺少已批准的迁移", "incompatible");
		const previous = journal.configs[edge.from];
		const next = journal.configs[edge.to];
		if (!previous || !next) return fail("$.evolution", "配置基线缺失", "history");
		const values = planEvolution(previous, next, [{
			progressId: snapshot.progressId,
			values: snapshot.values
		}], edge.renames).migrate(snapshot.values);
		return this.migrate(journal, {
			...snapshot,
			values,
			configRevision: edge.to
		}, to, visited);
	}
	validCandidate(cut, turn, candidate) {
		return prefixes(cut)[candidate.callSeq + 1] === candidate.callPrefix && successfulCall(cut, turn.start.seq, candidate.callSeq, candidate.callId);
	}
	/** Replay records and durable candidates against a precise cut without changing the parent. */
	fold(progress, cut, tail) {
		const records = progress.records.filter((record) => matches(record.anchor, cut, tail || record.source === "initial")).map(clone);
		const virtual = [];
		for (const turn of progress.turns) {
			if (turn.revoked || turn.result && !["committed", "no-change"].includes(turn.result.status)) continue;
			if (!matches(turn.start, cut, false)) continue;
			const end = completed(cut, turn.start.seq);
			if (end && !records.some((record) => record.turnId === turn.id)) virtual.push({
				seq: end.seq,
				turn
			});
		}
		const events = [...records.map((record) => ({
			seq: record.anchor.seq,
			phase: record.anchor.phase === "before" ? 0 : 1,
			order: record.order,
			record
		})), ...virtual.map((item) => ({
			seq: item.seq,
			phase: 1,
			order: Number.MAX_SAFE_INTEGER,
			turn: item.turn
		}))].sort((a, b) => a.seq - b.seq || a.phase - b.phase || a.order - b.order);
		const output = [];
		for (const item of events) {
			if ("record" in item) {
				output.push(item.record);
				continue;
			}
			const turn = item.turn;
			const head = output.at(-1)?.snapshot;
			if (!head || head.generation !== turn.snapshot.generation || head.revision !== turn.snapshot.revision || head.configRevision !== turn.snapshot.configRevision || turn.snapshot.dataEpoch !== this.epoch) continue;
			const candidates = turn.candidates.filter((candidate) => this.validCandidate(cut, turn, candidate)).sort((a, b) => a.callSeq - b.callSeq);
			if (!candidates.length) continue;
			const values = clone(head.values);
			candidates.forEach((candidate) => candidate.changes.forEach((change) => {
				values[change.name] = change.value;
			}));
			const changed = digest(values) !== digest(head.values);
			output.push({
				order: Number.MAX_SAFE_INTEGER,
				anchor: anchor(cut, "after", item.seq),
				snapshot: {
					...head,
					values,
					revision: head.revision + (changed ? 1 : 0)
				},
				baseRevision: head.revision,
				source: "ai",
				operationId: turn.id,
				payloadDigest: digest(candidates),
				status: changed ? "committed" : "no-change",
				time: this.now(),
				turnId: turn.id
			});
		}
		return output;
	}
	ensure(journal, target, cut, config, visited = /* @__PURE__ */ new Set()) {
		if (cut.header.id !== target.sessionId) return fail("$.history", "源会话身份不匹配", "history");
		const chain = prefixes(cut);
		journal.configs[digest(config)] = config;
		let progress = journal.progress.findLast((item) => item.sessionId === target.sessionId);
		if (progress) {
			this.sealSession(journal, target.sessionId, chain);
			const common = progress.observed.findIndex((prefix, i) => chain[i] !== prefix);
			if (common !== -1) {
				if (common <= 1 && progress.observed.length > 1) return fail("$.history", "无法验证历史共同前缀", "history");
				const recovered = this.asOf(journal, target.sessionId, cut);
				if (!recovered.length) return fail("$.history", "历史基线缺失", "history");
				const replacement = this.newProgress(target, cut);
				replacement.records = recovered.map((record) => ({
					...record,
					order: journal.nextOrder++,
					snapshot: {
						...record.snapshot,
						progressId: replacement.id,
						generation: replacement.generation,
						dataEpoch: this.epoch
					}
				}));
				journal.progress.push(replacement);
				progress = replacement;
			}
			this.seal(progress, chain);
			progress.observed = chain;
			return progress;
		}
		if (visited.has(target.sessionId)) return fail("$.history", "分叉血缘循环", "history");
		visited.add(target.sessionId);
		progress = this.newProgress(target, cut);
		if (cut.header.isSeeded && cut.inheritedEventCount > 0 && cut.header.parentSession === void 0) return fail("$.history", "继承历史缺少父会话身份", "history");
		if (cut.header.isSeeded && cut.header.parentSession !== void 0) {
			const parentId = cut.header.parentSession;
			if (visited.has(parentId)) return fail("$.history", "分叉血缘循环", "history");
			const parent = this.options.history.capture(parentId);
			const parentChain = prefixes(parent);
			const count = cut.inheritedEventCount;
			if (count > parent.seq || chain[count] !== parentChain[count]) return fail("$.history", "继承前缀与父会话不一致", "history");
			const parentProgress = this.ensure(journal, {
				sessionId: parentId,
				roleId: target.roleId
			}, parent, config, visited);
			const inherited = {
				...cut,
				seq: count,
				events: cut.events.slice(0, count),
				inheritedEventCount: 0
			};
			const records = this.asOf(journal, parentProgress.sessionId, inherited);
			if (!records.length) return fail("$.history", "分叉基线缺失", "history");
			progress.records = records.map((record) => ({
				...record,
				order: journal.nextOrder++,
				anchor: {
					...record.anchor,
					sessionId: target.sessionId
				},
				snapshot: {
					...record.snapshot,
					...target,
					progressId: progress.id,
					generation: progress.generation,
					dataEpoch: this.epoch
				}
			}));
		} else {
			const snapshot = this.snapshot(target, progress, config);
			this.record(journal, progress, snapshot, {
				sessionId: target.sessionId,
				seq: 0,
				phase: "after",
				prefix: chain[1] ?? chain[0]
			}, "initial", this.id(), "", "no-change", 0);
			progress.records[0].anchor = {
				sessionId: target.sessionId,
				seq: 0,
				phase: "before",
				prefix: chain[0]
			};
		}
		journal.progress.push(progress);
		return progress;
	}
	seal(progress, chain) {
		for (const record of progress.records) {
			if (record.source === "initial" || record.anchor.phase !== "before" || record.anchor.nextPrefix !== void 0) continue;
			const next = chain[record.anchor.seq + 1];
			if (next && chain[record.anchor.seq] === record.anchor.prefix) record.anchor.nextPrefix = next;
		}
	}
	sealSession(journal, sessionId, chain) {
		for (const progress of journal.progress.filter((item) => item.sessionId === sessionId)) {
			this.seal(progress, progress.observed);
			this.seal(progress, chain);
		}
	}
	asOf(journal, sessionId, cut) {
		return journal.progress.filter((progress) => progress.sessionId === sessionId).flatMap((progress) => this.fold(progress, cut, false)).sort((a, b) => a.anchor.seq - b.anchor.seq || (a.anchor.phase === b.anchor.phase ? a.order - b.order : a.anchor.phase === "before" ? -1 : 1));
	}
	current(journal, progress, cut, config) {
		const last = this.fold(progress, cut, true).at(-1)?.snapshot;
		if (!last) return fail("$.history", "没有可验证的状态快照", "history");
		return {
			...this.migrate(journal, last, digest(config)),
			dataEpoch: this.epoch
		};
	}
	async durable(target, lifecycle, epoch) {
		const cut = await this.options.history.flush(target.sessionId);
		this.guard(epoch, lifecycle);
		prefixes(cut);
		return cut;
	}
	settle(journal, progress, cut, config) {
		const notifications = [];
		let changed = false;
		for (const turn of progress.turns) {
			if (turn.result || !turnEnd(cut, turn.start.seq)) continue;
			if (!this.options.isSelected({
				sessionId: progress.sessionId,
				roleId: journal.roleId
			}) || turn.snapshot.configRevision !== digest(config) || turn.snapshot.dataEpoch !== this.epoch) turn.revoked = true;
			const snapshot = this.current(journal, progress, cut, config);
			const derived = this.fold(progress, cut, true).find((record) => record.turnId === turn.id);
			let status = "discarded";
			if (turn.revoked) status = "conflict";
			else if (derived) status = derived.status;
			else if (completed(cut, turn.start.seq) && turn.candidates.some((candidate) => this.validCandidate(cut, turn, candidate)) && snapshot.revision !== turn.snapshot.revision) status = "conflict";
			if (derived && (status === "committed" || status === "no-change")) {
				if (!progress.records.some((record) => record.turnId === turn.id)) {
					progress.records.push({
						...derived,
						order: journal.nextOrder++
					});
					if (status === "committed") notifications.push(derived.snapshot);
				}
			}
			turn.result = {
				status,
				snapshot: this.current(journal, progress, cut, config)
			};
			changed = true;
		}
		return {
			changed,
			notifications
		};
	}
	notify(target, snapshot) {
		for (const listener of this.listeners.get(targetKey(target)) ?? []) try {
			listener(freeze(clone(snapshot)));
		} catch {}
	}
	async context(target, persist = true) {
		if (this.blockedRoles.has(target.roleId)) return fail("$.target", "角色进度已回收", "stale");
		const config = this.config(target.roleId);
		if (!config) return void 0;
		const lifecycle = this.lifecycle;
		const epoch = this.epoch;
		let cut = clone(this.options.history.capture(target.sessionId));
		let journal = this.load(target.roleId);
		const existing = journal.progress.findLast((item) => item.sessionId === target.sessionId);
		if (existing?.turns.some((turn) => !turn.result && turnEnd(cut, turn.start.seq)) || !existing && cut.header.isSeeded) cut = await this.durable(target, lifecycle, epoch);
		this.guard(epoch, lifecycle);
		if (this.blockedRoles.has(target.roleId)) return fail("$.target", "角色进度已回收", "stale");
		if (digest(this.config(target.roleId)) !== digest(config)) return fail("$.configRevision", "配置已变化", "conflict");
		journal = this.load(target.roleId);
		if (journal.pendingConfigRevision !== void 0) {
			if (journal.pendingConfigRevision !== digest(config)) return fail("$.configRevision", "角色配置与重置事务尚未对齐", "incompatible");
			delete journal.pendingConfigRevision;
		}
		const progress = this.ensure(journal, target, cut, config);
		for (const turn of progress.turns) if (!turn.result && (turn.snapshot.configRevision !== digest(config) || turn.snapshot.dataEpoch !== this.epoch)) turn.revoked = true;
		const head = this.fold(progress, cut, true).at(-1)?.snapshot;
		if (head && head.configRevision !== digest(config)) {
			const migrated = this.migrate(journal, head, digest(config));
			this.record(journal, progress, migrated, anchor(cut, "before"), "evolution", this.id(), digest(config), "no-change", head.revision);
		}
		const result = this.settle(journal, progress, cut, config);
		if (persist) {
			this.save(journal);
			result.notifications.forEach((snapshot) => this.notify(target, snapshot));
		}
		return {
			journal,
			progress,
			cut,
			config
		};
	}
	readSnapshot(target) {
		return this.run(async () => {
			const ctx = await this.context(target);
			return ctx ? freeze(this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)) : void 0;
		});
	}
	/** Owner UI preview: derive the current values without creating or updating a journal. */
	inspectSnapshot(target) {
		return this.run(async () => {
			const ctx = await this.context(target, false);
			return ctx ? freeze(this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)) : void 0;
		});
	}
	async stableContext(target) {
		for (;;) {
			const ctx = await this.context(target);
			this.guard();
			if (this.blockedRoles.has(target.roleId)) return fail("$.target", "角色进度已回收", "stale");
			if (!ctx) return void 0;
			if (digest(this.config(target.roleId)) !== digest(ctx.config)) continue;
			const latest = this.options.history.capture(target.sessionId);
			if (latest.seq === ctx.cut.seq && prefixes(latest).at(-1) === prefixes(ctx.cut).at(-1)) return ctx;
		}
	}
	projectModel(target) {
		return this.run(async () => {
			const ctx = await this.context(target);
			return ctx ? freeze(projectModel(ctx.config, this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config).values)) : void 0;
		});
	}
	beginTurn(target, turnStart) {
		return this.run(async () => {
			const ctx = await this.stableContext(target);
			if (!ctx || !ctx.config.enabled) return void 0;
			if (!this.options.isSelected(target)) return fail("$.target", "角色选择已变化", "conflict");
			if (ctx.cut.events[turnStart]?.type !== "turn/start" || turnEnd(ctx.cut, turnStart) || ctx.cut.events.findLastIndex((event) => event.type === "turn/start") !== turnStart) return fail("$.turnStart", "需要当前开放轮次", "history");
			let turn = ctx.progress.turns.find((item) => item.start.seq === turnStart && matches(item.start, ctx.cut, false));
			if (!turn) {
				const snapshot = this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config);
				turn = {
					id: this.id(),
					start: anchor(ctx.cut, "after", turnStart),
					snapshot,
					config: clone(ctx.config),
					projection: projectModel(ctx.config, snapshot.values),
					candidates: []
				};
				ctx.progress.turns.push(turn);
				this.save(ctx.journal);
			}
			const token = [...this.handles].find(([, entry]) => entry.turnId === turn.id && entry.generation === ctx.progress.generation && entry.lifecycle === this.lifecycle)?.[0] ?? this.id();
			this.handles.set(token, {
				target: clone(target),
				turnId: turn.id,
				generation: ctx.progress.generation,
				lifecycle: this.lifecycle
			});
			return freeze({
				token,
				snapshot: clone(turn.snapshot),
				projection: clone(turn.projection),
				source: this.ai
			});
		});
	}
	resolve(handle) {
		const entry = this.handles.get(handle.token);
		if (!entry || entry.lifecycle !== this.lifecycle) return fail("$.turn", "轮次句柄已失效", "stale");
		const journal = this.load(entry.target.roleId);
		const progress = journal.progress.findLast((item) => item.sessionId === entry.target.sessionId);
		const turn = progress?.turns.find((item) => item.id === entry.turnId);
		if (!progress || progress.generation !== entry.generation || !turn) return fail("$.turn", "进度代次已变化", "stale");
		return {
			...entry,
			journal,
			progress,
			turn
		};
	}
	changes(config, operation, kind) {
		if (!Array.isArray(operation.changes) || !operation.changes.length || operation.changes.length > 32) return fail("$.changes", "需要 1–32 项更新");
		const names = /* @__PURE__ */ new Set();
		return operation.changes.map((raw, i) => {
			jsonData(raw);
			const item = object(raw, `$.changes[${i}]`, ["name", "value"]);
			let name;
			try {
				name = normalizeName(item.name);
			} catch (error) {
				if (kind === "ai") return fail("$.changes", "本轮没有这个可更新字段");
				throw error;
			}
			const field = config.fields.find((item) => item.name === name);
			if (!field || kind === "ai" && (!field.visible || !field.aiWritable)) return fail("$.changes", kind === "ai" ? "本轮没有这个可更新字段" : "字段不存在或未开放");
			if (kind === "plugin" && !field.pluginWritable) return fail("$.changes", "字段未开放给插件", "source");
			if (names.has(name)) return fail("$.changes", "重复字段");
			names.add(name);
			return {
				name,
				value: validateValue(field, item.value, kind === "ai" ? `$.${name}` : `$.changes[${i}].value`)
			};
		});
	}
	operation(operation, snapshot, config, ai = false, permissions) {
		if (typeof operation.operationId !== "string" || !operation.operationId || operation.operationId.length > 256) fail("$.operationId", "操作标识无效");
		if (!Number.isSafeInteger(operation.baseRevision) || operation.baseRevision < 0) fail("$.baseRevision", "状态版本无效");
		if (operation.dataEpoch !== this.epoch || operation.dataEpoch !== snapshot.dataEpoch) fail("$.dataEpoch", "资料代次已变化", "stale");
		const source = this.authorize(operation.source);
		if (source.kind === "ai" !== ai) fail("$.source", "来源类型不符", "source");
		if (operation.configRevision !== digest(config)) fail("$.configRevision", "配置已变化", "conflict");
		if (operation.progressId !== snapshot.progressId || operation.generation !== snapshot.generation) fail("$.generation", "进度代次已变化", "conflict");
		const changes = this.changes(config, operation, permissions ?? source.kind);
		return {
			source,
			changes,
			payload: digest({
				changes,
				baseRevision: operation.baseRevision,
				configRevision: operation.configRevision,
				dataEpoch: operation.dataEpoch,
				generation: operation.generation,
				progressId: operation.progressId
			})
		};
	}
	propose(handle, operation, call) {
		return this.run(() => {
			const ctx = this.resolve(handle);
			if (ctx.turn.result || ctx.turn.revoked || !this.options.isSelected(ctx.target) || digest(this.config(ctx.target.roleId)) !== ctx.turn.snapshot.configRevision) return fail("$.turn", "轮次已失效", "conflict");
			const cut = this.options.history.capture(ctx.target.sessionId);
			const event = cut.events[call.seq];
			if (turnEnd(cut, ctx.turn.start.seq) || !matches(ctx.turn.start, cut, false) || !event || call.seq <= ctx.turn.start.seq || cut.events.findLastIndex((event) => event.type === "turn/start") !== ctx.turn.start.seq || !validStateCall(cut, ctx.turn.start.seq, event, call.callId)) return fail("$.call", "工具调用证据不匹配", "history");
			const valid = this.operation(operation, ctx.turn.snapshot, ctx.turn.config, true);
			const callPrefix = prefixes(cut)[call.seq + 1];
			if (operation.baseRevision !== ctx.turn.snapshot.revision) return fail("$.baseRevision", "候选基线不匹配", "conflict");
			const previous = ctx.turn.candidates.find((item) => item.operationId === operation.operationId || item.callSeq === call.seq);
			if (previous) {
				if (previous.payload !== valid.payload || previous.callSeq !== call.seq || previous.callId !== call.callId || previous.callPrefix !== callPrefix || previous.operationId !== operation.operationId) return fail("$.operationId", "操作标识已用于不同内容", "conflict");
				return { accepted: true };
			}
			if (ctx.progress.turns.flatMap((turn) => turn.candidates).find((item) => item.operationId === operation.operationId)) return fail("$.operationId", "操作标识已用于不同调用", "conflict");
			ctx.turn.candidates.push({
				operationId: operation.operationId,
				payload: valid.payload,
				changes: valid.changes,
				callSeq: call.seq,
				callId: call.callId,
				callPrefix,
				sourceIdentity: "ai"
			});
			ctx.progress.observed = prefixes(cut);
			this.save(ctx.journal);
			return { accepted: true };
		});
	}
	settleTurn(handle) {
		return this.run(async () => {
			const entry = this.resolve(handle);
			let ctx;
			try {
				ctx = await this.context(entry.target);
			} catch (error) {
				if (error instanceof DynamicsError && [
					"stale",
					"conflict",
					"corrupt",
					"history",
					"incompatible"
				].includes(error.code)) throw error;
				return freeze({
					status: "pending",
					snapshot: clone(entry.turn.snapshot),
					error: error instanceof Error ? error.message : "结算失败"
				});
			}
			if (!ctx || ctx.progress.generation !== entry.generation) return fail("$.turn", "轮次已失效", "stale");
			const turn = ctx.progress.turns.find((item) => item.id === entry.turnId);
			return freeze(clone(turn.result ?? {
				status: "pending",
				snapshot: this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)
			}));
		});
	}
	commit(target, operation) {
		return this.run(async () => {
			const ctx = await this.stableContext(target);
			if (!ctx) return fail("$.target", "角色没有动态配置");
			if (!this.options.isSelected(target)) return fail("$.target", "角色选择已变化", "conflict");
			const snapshot = this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config);
			const valid = this.operation(operation, snapshot, ctx.config);
			const key = digest([
				ctx.progress.generation,
				valid.source.identity,
				operation.operationId
			]);
			const prior = ctx.progress.receipts.find((receipt) => receipt.key === key);
			if (prior) {
				if (prior.payload !== valid.payload) return fail("$.operationId", "操作标识已用于不同内容", "conflict");
				return freeze(clone(prior.result));
			}
			if (operation.baseRevision !== snapshot.revision) return fail("$.baseRevision", "状态已变化", "conflict");
			const values = clone(snapshot.values);
			valid.changes.forEach((change) => {
				values[change.name] = change.value;
			});
			const changed = digest(values) !== digest(snapshot.values);
			const next = {
				...snapshot,
				values,
				revision: snapshot.revision + (changed ? 1 : 0)
			};
			const result = {
				status: changed ? "committed" : "no-change",
				snapshot: next
			};
			const cut = this.options.history.capture(target.sessionId);
			this.record(ctx.journal, ctx.progress, next, anchor(cut, "before"), valid.source.identity, operation.operationId, valid.payload, result.status, snapshot.revision);
			ctx.progress.observed = prefixes(cut);
			ctx.progress.receipts.push({
				key,
				payload: valid.payload,
				result
			});
			this.save(ctx.journal);
			if (changed) this.notify(target, next);
			return freeze(clone(result));
		});
	}
	subscribe(target, listener) {
		this.guard();
		const key = targetKey(target);
		const set = this.listeners.get(key) ?? /* @__PURE__ */ new Set();
		set.add(listener);
		this.listeners.set(key, set);
		return () => {
			set.delete(listener);
			if (!set.size) this.listeners.delete(key);
		};
	}
	planConfiguration(roleId, next, renames = {}) {
		this.guard();
		const old = this.config(roleId);
		if (!old) return fail("$.config", "旧配置缺失");
		const journal = this.load(roleId);
		if (journal.pendingConfigRevision !== void 0 && journal.pendingConfigRevision !== digest(old)) return fail("$.configRevision", "角色配置与重置事务尚未对齐", "incompatible");
		return planEvolution(old, next, journal.progress.flatMap((progress) => [...progress.records, ...progress.turns]).flatMap((item) => {
			try {
				return [this.migrate(journal, item.snapshot, digest(old))];
			} catch (error) {
				if (item.isolatedByReset && error instanceof DynamicsError && error.code === "incompatible") return [];
				throw error;
			}
		}).map((snapshot) => ({
			progressId: snapshot.progressId,
			values: snapshot.values
		})), renames);
	}
	/** Persist migration evidence before the outer ROLE.md transaction publishes its new definition. */
	approveEvolution(roleId, next, renames = {}) {
		return this.run(() => this.approveEvolutionNow(roleId, next, renames));
	}
	approveEvolutionNow(roleId, next, renames) {
		const plan = this.planConfiguration(roleId, next, renames);
		if (!plan.compatible) return fail("$.evolution", "需要重置该角色进度后应用", "incompatible");
		const old = this.config(roleId);
		const journal = this.load(roleId);
		const from = digest(old);
		const to = digest(plan.config);
		const alignedReset = journal.pendingConfigRevision !== void 0;
		delete journal.pendingConfigRevision;
		if (from === to) {
			if (alignedReset) this.save(journal);
			return;
		}
		journal.configs[from] = old;
		journal.configs[to] = plan.config;
		if (!journal.evolutions.some((edge) => edge.from === from && edge.to === to)) journal.evolutions.push({
			from,
			to,
			renames: clone(renames)
		});
		for (const progress of journal.progress) for (const turn of progress.turns) if (!turn.result) turn.revoked = true;
		this.save(journal);
	}
	resetRole(roleId, next) {
		return this.run(() => this.resetRoleNow(roleId, next));
	}
	async resetRoleNow(roleId, next) {
		if (this.blockedRoles.has(roleId)) return fail("$.target", "角色进度已回收", "stale");
		const definition = clone(this.options.config(roleId));
		const config = next === void 0 ? this.config(roleId) : validateConfig(next);
		if (!config) return fail("$.config", "配置缺失");
		const before = this.load(roleId);
		const boundaries = [...new Set(before.progress.map((progress) => progress.sessionId))].map((sessionId) => {
			const cut = clone(this.options.history.capture(sessionId));
			prefixes(cut);
			if (cut.header.id !== sessionId) return fail("$.history", "源会话身份不匹配", "history");
			return {
				sessionId,
				cut,
				settle: before.progress.findLast((item) => item.sessionId === sessionId).turns.some((turn) => !turn.result && !turn.revoked && turnEnd(cut, turn.start.seq))
			};
		});
		for (const boundary of boundaries) {
			if (!boundary.settle) continue;
			const durable = await this.durable({
				roleId,
				sessionId: boundary.sessionId
			}, this.lifecycle, this.epoch);
			if (durable.header.id !== boundary.sessionId || prefixes(durable)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) return fail("$.history", "重置前的历史尚未持久化或已变化", "history");
		}
		this.guard();
		if (this.blockedRoles.has(roleId)) return fail("$.target", "角色进度已回收", "stale");
		if (digest(this.options.config(roleId) ?? null) !== digest(definition ?? null)) return fail("$.configRevision", "配置已变化", "conflict");
		const journal = this.load(roleId);
		journal.configs[digest(config)] = config;
		if (next !== void 0) journal.pendingConfigRevision = digest(config);
		for (const boundary of boundaries) {
			const { sessionId } = boundary;
			const target = {
				roleId,
				sessionId
			};
			const cut = this.options.history.capture(sessionId);
			if (cut.header.id !== sessionId || prefixes(cut)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) return fail("$.history", "重置前的历史已变化", "history");
			if (boundary.settle) {
				const old = definition === void 0 ? config : validateConfig(definition);
				const previous = this.ensure(journal, target, boundary.cut, old);
				this.settle(journal, previous, boundary.cut, old);
			}
			this.sealSession(journal, sessionId, prefixes(cut));
			for (const previous of journal.progress.filter((item) => item.sessionId === sessionId)) for (const item of [...previous.records, ...previous.turns]) try {
				this.migrate(journal, item.snapshot, digest(config));
			} catch (error) {
				if (!(error instanceof DynamicsError) || error.code !== "incompatible") throw error;
				item.isolatedByReset = true;
			}
			const progress = this.newProgress(target, cut);
			this.record(journal, progress, this.snapshot(target, progress, config), anchor(cut, "before"), "owner", this.id(), "", "committed", 0);
			journal.progress.push(progress);
		}
		for (const progress of journal.progress) for (const turn of progress.turns) if (!turn.result) turn.revoked = true;
		this.save(journal);
		this.invalidateHandles(roleId);
	}
	/** Trusted data-layer boundary: ROLE.md and journal recovery share the existing queue.
	* The scoped port expires before queued model/user operations can resume. */
	withRolePersistence(roleId, body) {
		return this.run(async () => {
			let active = true;
			const guard = () => {
				this.guard();
				if (!active) fail("$.transaction", "事务句柄已失效", "stale");
			};
			const port = {
				guard,
				prepare: () => {
					guard();
					return this.preparePersistence(roleId, guard);
				},
				plan: (next, renames = {}) => {
					guard();
					return this.planConfiguration(roleId, next, renames);
				},
				approve: (next, renames = {}) => {
					guard();
					this.approveEvolutionNow(roleId, next, renames);
				},
				reset: (next) => {
					guard();
					return this.resetRoleNow(roleId, next);
				},
				invalidate: () => {
					guard();
					this.invalidateTarget(roleId);
				},
				detach: (stamp) => {
					guard();
					this.invalidateTarget(roleId);
					this.blockedRoles.add(roleId);
					this.options.store.detach(roleId, stamp, guard);
				},
				restore: (stamp) => {
					guard();
					this.options.store.restore(roleId, stamp, guard);
					this.blockedRoles.delete(roleId);
				},
				release: () => {
					guard();
					this.blockedRoles.delete(roleId);
				}
			};
			try {
				return await body(port);
			} finally {
				active = false;
			}
		});
	}
	/** Freeze the operation boundary before any flush. Keep completed history recoverable
	* even if preparation fails, and persist it before the outer rollback backup. */
	async preparePersistence(roleId, guard) {
		if (this.blockedRoles.has(roleId)) return fail("$.target", "角色进度已回收", "stale");
		const definition = this.config(roleId);
		const before = this.load(roleId);
		const boundaries = [...new Set(before.progress.map((progress) => progress.sessionId))].map((sessionId) => {
			const cut = clone(this.options.history.capture(sessionId));
			prefixes(cut);
			if (cut.header.id !== sessionId) return fail("$.history", "源会话身份不匹配", "history");
			return {
				sessionId,
				cut
			};
		});
		this.invalidateHandles(roleId);
		let revoked = false;
		for (const progress of before.progress) {
			const cut = boundaries.find((boundary) => boundary.sessionId === progress.sessionId).cut;
			for (const turn of progress.turns) if (!turn.result && !turn.revoked && !turnEnd(cut, turn.start.seq)) {
				turn.revoked = true;
				revoked = true;
			}
		}
		if (revoked) this.save(before);
		const ended = boundaries.filter(({ sessionId, cut }) => before.progress.some((progress) => progress.sessionId === sessionId && progress.turns.some((turn) => !turn.result && !turn.revoked && turnEnd(cut, turn.start.seq))));
		if (!ended.length) return;
		for (const boundary of ended) {
			const durable = await this.durable({
				roleId,
				sessionId: boundary.sessionId
			}, this.lifecycle, this.epoch);
			guard();
			if (durable.header.id !== boundary.sessionId || prefixes(durable)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) return fail("$.history", "资料操作前的历史尚未持久化或已变化", "history");
		}
		guard();
		if (this.blockedRoles.has(roleId)) return fail("$.target", "角色进度已回收", "stale");
		if (digest(this.config(roleId) ?? null) !== digest(definition ?? null)) return fail("$.configRevision", "配置已变化", "conflict");
		if (!definition) return fail("$.config", "旧配置缺失");
		const journal = this.load(roleId);
		for (const boundary of ended) {
			const cut = this.options.history.capture(boundary.sessionId);
			if (cut.header.id !== boundary.sessionId || prefixes(cut)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) return fail("$.history", "资料操作前的历史已变化", "history");
			const progress = this.ensure(journal, {
				roleId,
				sessionId: boundary.sessionId
			}, boundary.cut, definition);
			this.settle(journal, progress, boundary.cut, definition);
		}
		this.save(journal);
	}
	invalidateHandles(roleId, sessionId) {
		for (const [token, entry] of this.handles) if (entry.target.roleId === roleId && (sessionId === void 0 || entry.target.sessionId === sessionId)) this.handles.delete(token);
	}
	/** Stop an adapter without discarding rounds already closed before unload. */
	invalidateOpenTarget(target) {
		this.invalidateHandles(target.roleId, target.sessionId);
		const journal = this.load(target.roleId);
		if (!journal.progress.some((progress) => progress.sessionId === target.sessionId && progress.turns.some((turn) => !turn.result))) return;
		const cut = this.options.history.capture(target.sessionId);
		let changed = false;
		for (const progress of journal.progress) if (progress.sessionId === target.sessionId) {
			for (const turn of progress.turns) if (!turn.result && !turnEnd(cut, turn.start.seq)) {
				this.stoppedTurns.add(turn.id);
				turn.revoked = true;
				changed = true;
			}
		}
		if (changed) this.save(journal);
	}
	invalidateTarget(roleId, sessionId) {
		this.invalidateHandles(roleId, sessionId);
		const journal = this.load(roleId);
		if (!journal.progress.length) return;
		for (const progress of journal.progress) if (sessionId === void 0 || progress.sessionId === sessionId) {
			for (const turn of progress.turns) if (!turn.result) turn.revoked = true;
		}
		this.save(journal);
	}
	clearCaches() {
		this.guard(this.epoch, this.lifecycle);
	}
	invalidate(epoch) {
		const active = this.active;
		this.active = void 0;
		try {
			for (const roleId of this.knownRoles) this.invalidateTarget(roleId);
		} finally {
			this.epoch = epoch;
			this.lifecycle++;
			this.handles.clear();
			this.sources.clear();
			this.ai = this.source("ai", "AI", "ai");
			this.active = active;
		}
	}
	dispose() {
		if (this.disposed) return;
		this.lifecycle++;
		this.handles.clear();
		this.listeners.clear();
		this.sources.clear();
		try {
			for (const roleId of this.knownRoles) {
				const journal = this.load(roleId);
				let changed = false;
				for (const progress of journal.progress) for (const turn of progress.turns) if (!turn.result && !turn.revoked) {
					turn.revoked = true;
					changed = true;
				}
				if (changed) this.options.store.save(roleId, journal, () => {
					if (this.disposed) fail("$.lifecycle", "已停用", "stale");
				});
			}
		} finally {
			this.disposed = true;
		}
	}
	detachRole(roleId, stamp) {
		this.invalidateTarget(roleId);
		const alreadyBlocked = this.blockedRoles.has(roleId);
		this.blockedRoles.add(roleId);
		return this.run(() => {
			try {
				this.options.store.detach(roleId, stamp, () => this.guard());
			} catch (error) {
				if (!alreadyBlocked && this.options.store.load(roleId) !== void 0) this.blockedRoles.delete(roleId);
				throw error;
			}
		});
	}
	restoreRole(roleId, stamp) {
		return this.run(() => {
			this.options.store.restore(roleId, stamp, () => this.guard());
			this.blockedRoles.delete(roleId);
		});
	}
	readExtension(source, target) {
		return this.run(async () => {
			const registered = this.authorize(source);
			if (registered.kind !== "plugin") return fail("$.source", "需要插件来源", "source");
			const ctx = await this.stableContext(target);
			this.authorize(source);
			const extension = ctx?.progress.extensions[digest(registered.identity)];
			return extension ? freeze({
				revision: extension.revision,
				values: clone(extension.values)
			}) : void 0;
		});
	}
	commitExtension(source, target, definition, operation) {
		return this.run(async () => {
			const registered = this.authorize(source);
			if (registered.kind !== "plugin") return fail("$.source", "需要插件来源", "source");
			const config = validateConfig(definition);
			if (config.entries.length) return fail("$.extension", "私有扩展不含角色条件");
			const ctx = await this.stableContext(target);
			this.authorize(source);
			if (!ctx) return fail("$.target", "角色没有动态配置");
			if (!this.options.isSelected(target)) return fail("$.target", "角色选择已变化", "conflict");
			const key = digest(registered.identity);
			const extension = ctx.progress.extensions[key] ?? {
				config,
				revision: 0,
				values: initialValues(config),
				receipts: []
			};
			if (digest(extension.config) !== digest(config) || operation.configRevision !== digest(config)) return fail("$.configRevision", "扩展定义已变化", "conflict");
			const snapshot = this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config);
			const valid = this.operation({
				...operation,
				source
			}, snapshot, config, false, "owner");
			const changes = valid.changes;
			const payload = valid.payload;
			const receipt = extension.receipts.find((item) => item.key === operation.operationId);
			if (receipt) {
				if (receipt.payload !== payload) return fail("$.operationId", "操作标识冲突", "conflict");
				return freeze({
					revision: receipt.result.snapshot.revision,
					values: clone(receipt.result.snapshot.values)
				});
			}
			if (operation.baseRevision !== extension.revision) return fail("$.baseRevision", "扩展状态已变化", "conflict");
			const values = clone(extension.values);
			changes.forEach((change) => {
				values[change.name] = change.value;
			});
			const changed = digest(values) !== digest(extension.values);
			extension.values = values;
			extension.revision += changed ? 1 : 0;
			const next = {
				...snapshot,
				configRevision: digest(config),
				revision: extension.revision,
				values
			};
			extension.receipts.push({
				key: operation.operationId,
				payload,
				result: {
					status: changed ? "committed" : "no-change",
					snapshot: next
				}
			});
			ctx.progress.extensions[key] = extension;
			this.save(ctx.journal);
			return freeze({
				revision: extension.revision,
				values: clone(values)
			});
		});
	}
};
// src/role-dynamics/store.ts
var FileJournalStore = class {
	fault;
	root;
	constructor(root, fault = () => {}) {
		this.fault = fault;
		this.root = resolve(root);
	}
	check(path) {
		let current = resolve(path);
		while (current !== parse(current).root) {
			if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail("$.storage", "拒绝联接或符号链接", "storage");
			current = dirname(current);
		}
	}
	directory(roleId) {
		return join(this.root, "roles", createHash("sha256").update(roleId).digest("hex"));
	}
	file(roleId) {
		return join(this.directory(roleId), "journal.json");
	}
	load(roleId) {
		const file = this.file(roleId);
		this.check(file);
		if (!existsSync(file)) return void 0;
		try {
			const envelope = JSON.parse(readFileSync(file, "utf8"));
			if (envelope.version !== 1 || envelope.checksum !== digest(envelope.journal)) throw new Error("checksum");
			return envelope.journal;
		} catch {
			return fail("$.storage", "进度日志损坏，原件已保留", "corrupt");
		}
	}
	save(roleId, journal, guard) {
		const file = this.file(roleId);
		this.check(file);
		guard();
		mkdirSync(dirname(file), { recursive: true });
		const temporary = join(dirname(file), `${randomUUID()}.tmp`);
		try {
			this.fault("temporary");
			guard();
			const fd = openSync(temporary, "wx");
			try {
				writeFileSync(fd, canonical({
					version: 1,
					checksum: digest(journal),
					journal
				}), "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.fault("rename");
			guard();
			this.check(file);
			renameSync(temporary, file);
			this.fault("directory-sync");
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
	detach(roleId, stamp, guard) {
		if (!/^[a-zA-Z0-9-]{1,100}$/.test(stamp)) fail("$.stamp", "非法回收标识");
		const from = this.directory(roleId);
		const to = join(this.root, "trash", `${digest(roleId)}-${stamp}`);
		this.check(from);
		this.check(to);
		guard();
		if (!existsSync(from)) return;
		if (existsSync(to)) fail("$.storage", "回收目标已存在");
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
	}
	restore(roleId, stamp, guard) {
		if (!/^[a-zA-Z0-9-]{1,100}$/.test(stamp)) fail("$.stamp", "非法回收标识");
		const to = this.directory(roleId);
		const from = join(this.root, "trash", `${digest(roleId)}-${stamp}`);
		this.check(from);
		this.check(to);
		guard();
		if (existsSync(to)) fail("$.storage", "已有角色进度，不可覆盖");
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
	}
};
// src/role-dynamics/model.ts
const UPDATE_TOOL = "qqbot_update_state";
const STATE_GUIDANCE = "依据当前状态和已生效设定回应。";
const UPDATE_DESCRIPTION = `${STATE_GUIDANCE}按字段更新规则，用 qqbot_update_state 提交本轮变化后的值；更新从下一轮生效。`;
function renderModelProjection(projection) {
	if (!projection.fields.length && !projection.texts.length) return "";
	return [
		projection.fields.some((field) => field.writable) ? "" : STATE_GUIDANCE,
		projection.fields.length ? `当前状态：\n${JSON.stringify(projection.fields)}` : "",
		...projection.texts
	].filter(Boolean).join("\n\n");
}
const UPDATE_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["changes"],
	properties: { changes: {
		type: "array",
		minItems: 1,
		maxItems: 32,
		items: {
			type: "object",
			additionalProperties: false,
			required: ["name", "value"],
			properties: {
				name: { type: "string" },
				value: { oneOf: [
					{ type: "number" },
					{ type: "string" },
					{ type: "boolean" }
				] }
			}
		}
	} }
};
// src/role-dynamics/host.ts
/** Trusted host boundary: one core, file store and data coordinator. */
var DynamicsHost = class {
	ctx;
	data;
	maintenance;
	history;
	core;
	store;
	transactions;
	owner;
	selections;
	adapters = /* @__PURE__ */ new Set();
	sources = /* @__PURE__ */ new Set();
	pluginSources = /* @__PURE__ */ new WeakMap();
	cleanups = [];
	disposed = false;
	generation = 0;
	constructor(ctx, root, data, maintenance) {
		this.ctx = ctx;
		this.data = data;
		this.maintenance = maintenance;
		this.history = new HostHistoryView(() => {
			const sessionQuery = ctx.get("sessionQuery"), sessions = ctx.get("sessions");
			if (!sessionQuery || !sessions) throw new Error("动态设定需要宿主会话历史服务");
			return {
				sessionQuery,
				sessions
			};
		});
		this.store = new FileJournalStore(join(root, "role-dynamics"));
		this.selections = new DynamicsSelections(join(root, "role-dynamics", "selections.json"));
		this.core = new RoleDynamicsService({
			store: this.store,
			history: this.history,
			config: (id) => data.roles.configuration(id),
			isSelected: (target) => data.roleIdFor({ id: target.sessionId }) === target.roleId,
			epoch: maintenance.view().dataEpoch
		});
		this.owner = this.core.createOwnerSource();
		this.transactions = new RoleDataTransactions(data.roles, {
			dynamics: this.core,
			maintenance,
			prepareHistory: (id) => this.prepareRole(id),
			invalidated: () => this.renew()
		});
		this.cleanups.push(ctx.on("session/event", (session, event) => {
			this.history.observe(session, event);
			if (!this.maintenance.active && this.selections.has(session.id)) this.sealSelection(session.id);
		}));
		this.cleanups.push(data.bindings.interceptChoices((id, role, publish) => {
			const before = data.roleIdFor({ id });
			if (!(role !== null && data.roles.configuration(role) !== void 0 || before !== void 0 && data.roles.configuration(before) !== void 0) && !this.selections.has(id)) {
				publish();
				return;
			}
			maintenance.assertAvailable();
			const cut = this.history.capture(id);
			const files = [join(root, "role-dynamics", "selections.json"), data.bindings.filePath].filter((file) => file !== void 0);
			const tx = FileDataTransaction.prepare(root, "selection-transactions", files, { sessionId: id });
			try {
				this.selections.record(cut, role, true);
				publish();
				tx.commit();
			} catch (error) {
				if (!tx.committed) {
					tx.rollback();
					data.bindings.reload();
				}
				throw error;
			}
			if (before !== void 0 && before !== role) this.core.invalidateTarget(before, id);
		}));
	}
	assertGeneration(generation) {
		if (this.disposed || generation !== this.generation) throw new Error("动态设定操作已失效");
		this.maintenance.assertAvailable();
	}
	renew() {
		this.generation++;
		for (const reset of this.adapters) reset();
		this.owner = this.core.createOwnerSource();
		for (const record of this.sources) {
			if (!record.active) continue;
			const next = this.core.registerSource(record.identity, record.name);
			record.handle = next.handle;
			record.revoke = next.dispose;
		}
	}
	onInvalidate(reset) {
		this.adapters.add(reset);
		return () => {
			this.adapters.delete(reset);
		};
	}
	async prepareRole(id) {
		const journal = this.store.load(id);
		for (const sessionId of new Set(journal?.progress?.map((progress) => progress.sessionId))) await this.history.prepare(sessionId);
	}
	async prepareSession(id, targetRole = this.data.roleIdFor({ id }), selectionOnly = false) {
		const generation = this.generation;
		const journal = targetRole === void 0 ? void 0 : this.store.load(targetRole);
		const visit = async (sessionId, seen = /* @__PURE__ */ new Set()) => {
			if (seen.has(sessionId)) throw new Error("动态历史血缘循环");
			await this.history.prepare(sessionId);
			this.assertGeneration(generation);
			const cut = this.history.capture(sessionId);
			if ((!this.selections.has(sessionId) || !selectionOnly && targetRole !== void 0 && !journal?.progress?.some((progress) => progress.sessionId === sessionId)) && cut.header.isSeeded && cut.header.parentSession) await visit(cut.header.parentSession, /* @__PURE__ */ new Set([...seen, sessionId]));
		};
		await visit(id);
	}
	async attach(id) {
		const current = this.data.roleIdFor({ id });
		const config = current === void 0 ? void 0 : this.data.roles.configuration(current);
		const header = this.ctx.get("sessions")?.get(id)?.header;
		if (!config && !this.selections.has(id) && (!header?.isSeeded || !header.parentSession || !this.selections.has(header.parentSession))) return;
		await this.maintenance.write(async (guard) => {
			await this.prepareSession(id, void 0, true);
			guard();
			const restore = (sessionId, seen = /* @__PURE__ */ new Set()) => {
				if (seen.has(sessionId)) throw new Error("角色选择血缘循环");
				const cut = this.history.capture(sessionId);
				if (this.selections.has(sessionId)) return this.selections.current(cut);
				if (!cut.header.isSeeded || !cut.header.parentSession) return void 0;
				restore(cut.header.parentSession, /* @__PURE__ */ new Set([...seen, sessionId]));
				return this.selections.inherit(cut, this.history.capture(cut.header.parentSession));
			};
			const role = restore(id);
			if (role !== void 0 && this.data.bindings.get(id) !== role) this.data.bindings.set(id, role);
			this.data.settle({ id });
			const selected = this.data.roleIdFor({ id });
			if (selected !== void 0 && this.data.roles.configuration(selected) !== void 0 && !this.selections.has(id)) this.selections.record(this.history.capture(id), selected, true);
			if (this.history.capture(id).header.isSeeded) for (const roleId of this.selections.roles(this.history.capture(id))) {
				if (this.data.roles.configuration(roleId) === void 0) continue;
				await this.prepareSession(id, roleId);
				guard();
				await this.core.readSnapshot({
					sessionId: id,
					roleId
				});
				guard();
			}
			guard();
		});
	}
	needsSelection(id, nextRole) {
		const previous = this.data.roleIdFor({ id });
		return this.selections.has(id) || previous !== void 0 && this.data.roles.configuration(previous) !== void 0 || nextRole !== void 0 && this.data.roles.configuration(nextRole) !== void 0;
	}
	async prepareSelection(id, nextRole) {
		if (!this.needsSelection(id, nextRole)) return;
		await this.maintenance.write(async (guard) => {
			await this.prepareSession(id);
			guard();
			const roleId = this.data.roleIdFor({ id });
			if (roleId !== void 0 && this.data.roles.configuration(roleId) !== void 0) await this.core.readSnapshot({
				sessionId: id,
				roleId
			});
			guard();
		});
	}
	sealSelection(id) {
		this.selections.seal(this.history.capture(id));
	}
	recordSelection(id, start) {
		const cut = this.history.capture(id), role = this.data.roleIdFor({ id }) ?? null;
		this.selections.record({
			...cut,
			seq: start + 1,
			events: cut.events.slice(0, start + 1)
		}, role, true);
	}
	async state(id, expectedRole, preview = false) {
		return this.maintenance.write(async (guard) => {
			const role = this.data.roleFor({ id });
			if (expectedRole !== void 0 && role?.id !== expectedRole) throw new Error("角色已切换，请重新选择对话");
			if (!role) return void 0;
			const config = this.data.roles.configuration(role.id);
			if (!config || !preview && !config.enabled) return void 0;
			await this.prepareSession(id);
			guard();
			const target = {
				sessionId: id,
				roleId: role.id
			};
			const snapshot = await (preview ? this.core.inspectSnapshot(target) : this.core.readSnapshot(target));
			guard();
			if (this.data.roleIdFor({ id }) !== role.id) throw new Error("角色已切换，请重新打开状态");
			return snapshot ? {
				roleId: role.id,
				name: role.name,
				config,
				snapshot,
				diagnosis: diagnose(config, snapshot.values)
			} : void 0;
		});
	}
	async ownerCommit(id, roleId, operation) {
		return this.maintenance.write(async (guard) => {
			const generation = this.generation, owner = this.owner;
			await this.prepareSession(id);
			guard();
			this.assertGeneration(generation);
			if (this.data.roleIdFor({ id }) !== roleId || !this.data.roles.configuration(roleId)?.enabled) throw new Error("角色已切换或动态设定已停用");
			const result = await this.core.commit({
				sessionId: id,
				roleId
			}, {
				...operation,
				source: owner
			});
			guard();
			return result;
		});
	}
	async preview(id) {
		const roleId = this.data.roleIdFor({ id });
		if (!roleId || !this.data.roles.configuration(roleId)?.enabled) return "";
		return this.maintenance.write(async (guard) => {
			await this.prepareSession(id);
			guard();
			const projection = await this.core.projectModel({
				sessionId: id,
				roleId
			});
			guard();
			return projection ? renderModelProjection(projection) : "";
		});
	}
	forPlugin(identity, caller) {
		if (!identity) throw new Error("动态设定来源需要插件身份");
		const registerSource = (name) => {
			const source = this.registerSource(identity, name, caller);
			this.pluginSources.set(caller.fiber, source);
			return source;
		};
		const source = () => this.pluginSources.get(caller.fiber) ?? registerSource(identity);
		return {
			registerSource,
			readSnapshot: (target) => source().readSnapshot(target),
			commit: (target, operation) => source().commit(target, operation),
			projectModel: (target) => source().projectModel(target),
			subscribe: (target, listener) => source().subscribe(target, listener)
		};
	}
	registerSource(identity, name, caller) {
		this.assertGeneration(this.generation);
		const registered = this.core.registerSource(identity, name);
		const record = {
			identity,
			name,
			handle: registered.handle,
			revoke: registered.dispose,
			active: true
		};
		this.sources.add(record);
		const subscriptions = /* @__PURE__ */ new Set();
		const check = () => {
			if (!record.active || this.disposed) throw new Error("动态设定来源已撤销");
		};
		const run = (target, body) => this.maintenance.write(async (guard) => {
			check();
			const handle = record.handle, generation = this.generation;
			await this.prepareSession(target.sessionId, target.roleId);
			guard();
			check();
			this.assertGeneration(generation);
			const result = await body(handle);
			guard();
			check();
			return result;
		});
		const dispose = () => {
			if (!record.active) return;
			record.active = false;
			record.revoke();
			this.sources.delete(record);
			for (const cancel of subscriptions) cancel();
			subscriptions.clear();
		};
		caller.effect(() => dispose, "qqbot: dynamics source");
		return {
			readSnapshot: (target) => run(target, () => this.core.readSnapshot(target)),
			projectModel: (target) => run(target, () => this.core.projectModel(target)),
			commit: (target, operation) => run(target, (source) => this.core.commit(target, {
				...operation,
				source
			})),
			readExtension: (target) => run(target, (source) => this.core.readExtension(source, target)),
			commitExtension: (target, config, operation) => run(target, (source) => this.core.commitExtension(source, target, config, operation)),
			subscribe: (target, listener) => {
				check();
				const cancel = this.core.subscribe(target, listener);
				subscriptions.add(cancel);
				return () => {
					cancel();
					subscriptions.delete(cancel);
				};
			},
			dispose
		};
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		for (const reset of this.adapters) reset();
		this.adapters.clear();
		for (const source of this.sources) source.revoke();
		this.sources.clear();
		for (const cleanup of this.cleanups.reverse()) cleanup();
		this.transactions.dispose();
		try {
			this.core.dispose();
		} finally {
			this.history.dispose();
		}
	}
};
/** Must run before constructing the bindings store. */
function recoverDynamicsSelections(root) {
	FileDataTransaction.recover(root, "selection-transactions");
}
function candidateOperation(snapshot, source, start, call, changes) {
	return {
		operationId: digest([
			snapshot.generation,
			start,
			call
		]),
		baseRevision: snapshot.revision,
		configRevision: snapshot.configRevision,
		progressId: snapshot.progressId,
		generation: snapshot.generation,
		dataEpoch: snapshot.dataEpoch,
		source,
		changes
	};
}
// src/role-dynamics/agent.ts
var agent_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply$1,
	inject: () => inject$1,
	name: () => name$1,
	toolDeclaration: () => toolDeclaration
});
const name$1 = "qqbot-role-dynamics";
const inject$1 = [
	"qqbot",
	"systemPrompt",
	"tools"
];
/** rc.5 collapses PTC schemas to run_code and complete removes tools:sdk.
* Carry only this registered capability's existing declaration in qqbot:prompt. */
function toolDeclaration(ctx, input) {
	if (!input.agent) return "";
	const tools = ctx.get("tools");
	if (tools?.modeFor?.(input.scope) !== "ptc" || !tools.get("qqbot_update_state", input.agent)) return "";
	return `tools.${UPDATE_TOOL}\n${JSON.stringify({
		name: UPDATE_TOOL,
		description: UPDATE_DESCRIPTION,
		parameters: UPDATE_PARAMETERS
	})}`;
}
function apply$1(ctx) {
	const host = ctx.qqbot.dynamicsHost, states = /* @__PURE__ */ new Map();
	const reset = (state) => {
		if (state.slot) state.blockedStart = state.slot.start;
		delete state.slot;
		state.unregister?.();
		delete state.unregister;
	};
	const stop = (state) => {
		state.disposed = true;
		try {
			if (state.slot?.enabled && state.slot.roleId !== void 0) host.core.invalidateOpenTarget({
				roleId: state.slot.roleId,
				sessionId: state.agent.id
			});
		} finally {
			reset(state);
		}
	};
	ctx.effect(() => host.onInvalidate(() => {
		for (const state of states.values()) reset(state);
	}), "qqbot: dynamics lifecycle");
	ctx.effect(() => () => {
		const errors = [];
		for (const state of states.values()) try {
			stop(state);
		} catch (error) {
			errors.push(error);
		}
		states.clear();
		if (errors.length) throw new AggregateError(errors, "动态轮次撤销失败");
	}, "qqbot: dynamics agents");
	const configFor = (agent) => {
		const roleId = host.data.roleIdFor({ id: agent.id });
		return {
			roleId,
			config: roleId === void 0 ? void 0 : host.data.roles.configuration(roleId)
		};
	};
	const select = (state, event) => {
		state.unregister?.();
		delete state.unregister;
		const { roleId, config } = configFor(state.agent);
		state.slot = {
			start: event.seq,
			...roleId === void 0 ? {} : { roleId },
			revision: digest(config ?? null),
			enabled: config?.enabled === true,
			writable: config?.enabled === true && config.fields.some((field) => field.visible && field.aiWritable)
		};
		if (state.slot.writable) state.unregister = state.agent.ctx.tools.register(tool(state));
	};
	const freeze = async (state, input) => {
		if (input.signal?.aborted || state.disposed) throw new Error("动态轮次已取消");
		const current = state.slot;
		if (!current || current.start === state.blockedStart) throw new Error("动态轮次准入已失效");
		if (current.error) throw current.error;
		if (current.handle) return current.handle;
		if (!current.enabled) return void 0;
		const { roleId, config } = configFor(state.agent);
		if (!config?.enabled || roleId !== current.roleId || current.revision !== digest(config)) throw new Error("动态设定或角色已变化，请重新发送");
		if (!current.pending) current.pending = host.maintenance.write(async (guard) => {
			await host.prepareSession(state.agent.id);
			guard();
			if (state.slot !== current || state.disposed || input.signal?.aborted) throw new Error("动态轮次准入已失效");
			if (current.revision !== digest(configFor(state.agent).config ?? null)) throw new Error("动态设定已变化，请重新发送");
			host.recordSelection(state.agent.id, current.start);
			const handle = await host.core.beginTurn({
				sessionId: state.agent.id,
				roleId
			}, current.start);
			guard();
			if (state.slot !== current || state.disposed || input.signal?.aborted) {
				host.core.invalidateOpenTarget({
					sessionId: state.agent.id,
					roleId
				});
				throw new Error("动态轮次准入已失效");
			}
			if (handle) current.handle = handle;
			return handle;
		});
		return current.pending;
	};
	function tool(state) {
		return {
			name: UPDATE_TOOL,
			description: UPDATE_DESCRIPTION,
			parameters: structuredClone(UPDATE_PARAMETERS),
			output: {
				schema: {
					type: "object",
					properties: { accepted: { type: "boolean" } },
					required: ["accepted"],
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			async execute(input, exec) {
				const current = state.slot, handle = current?.handle;
				if (state.disposed || exec.agent !== state.agent || exec.signal.aborted || !current?.writable || !handle) throw new Error("本轮状态更新已失效");
				let changes;
				try {
					jsonData(input);
					if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "changes")) throw Error("shape");
					const raw = input.changes;
					if (!Array.isArray(raw) || !raw.length || raw.length > 32) throw Error("shape");
					changes = raw.map((item) => {
						if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["name", "value"].includes(key))) throw Error("shape");
						const name = normalizeName(item.name), field = handle.projection.fields.find((field) => field.name === name && field.writable);
						if (!field) throw Error("field");
						return {
							name,
							value: validateValue({
								...field,
								initial: field.value,
								visible: true,
								aiWritable: true
							}, item.value, `$.${field.name}`)
						};
					});
				} catch (error) {
					if (error instanceof DynamicsError && handle.projection.fields.some((field) => error.path === `$.${field.name}`)) throw new Error(error.message);
					if (error instanceof Error && error.message === "field" || error instanceof DynamicsError && error.path === "$.name") throw new Error("本轮没有这个可更新字段");
					throw new Error("状态更新格式无效");
				}
				return host.maintenance.write(async (guard) => {
					if (exec.signal.aborted || state.slot !== current || state.disposed) throw new Error("本轮状态更新已失效");
					const cut = host.history.capture(state.agent.id);
					if (turnEnd(cut, current.start)) throw new Error("本轮状态更新已失效");
					const call = cut.events.findLast((event) => event.seq > current.start && validStateCall(cut, current.start, event, exec.callId));
					if (!call) throw new Error("本轮没有匹配的状态更新调用");
					try {
						const accepted = await host.core.propose(handle, candidateOperation(handle.snapshot, handle.source, current.start, call.seq, changes), {
							seq: call.seq,
							callId: exec.callId
						});
						guard();
						if (exec.signal.aborted || state.slot !== current || state.disposed) throw new Error("stale");
						return accepted;
					} catch {
						throw new Error("本轮状态更新未被接收，请依据当前状态继续回应");
					}
				});
			}
		};
	}
	ctx.on("agent/created", async ({ agent, signal }) => {
		const presets = ctx.get("agentPresets");
		if (presets && presetForAgent(presets, agent) !== "qqbot") return;
		const state = {
			agent,
			disposed: false
		};
		states.set(agent, state);
		await host.attach(agent.id);
		if (signal?.aborted || state.disposed) throw new Error("动态会话初始化已取消");
	});
	ctx.on("agent/disposed", ({ agent }) => {
		const state = states.get(agent);
		if (!state) return;
		try {
			stop(state);
		} finally {
			states.delete(agent);
		}
	});
	ctx.on("session/event", (session, event) => {
		const state = [...states.values()].find((state) => state.agent.session === session);
		if (!state || state.disposed) return;
		if (event.type === "turn/start") try {
			select(state, event);
		} catch (error) {
			state.slot = {
				start: event.seq,
				revision: "",
				enabled: true,
				writable: false,
				error
			};
		}
		if (event.type === "turn/end") {
			const current = state.slot;
			state.unregister?.();
			delete state.unregister;
			if (!current?.handle) return;
			host.maintenance.write(async (guard) => {
				const result = await host.core.settleTurn(current.handle);
				guard();
				if (result.status === "pending") throw new Error(result.error ?? "动态状态结算尚未完成");
			}).catch((error) => {
				ctx.logger.warn("qqbot: 动态状态结算失败：%s", error);
			});
		}
	});
	ctx.systemPrompt.context({
		name: CONTEXT_NAME.ROLE_DYNAMICS,
		order: CONTEXT_ORDER.ROLE_DYNAMICS,
		required: true,
		interpolate: false,
		text: (input) => {
			const state = input.agent && states.get(input.agent);
			return state?.slot?.handle ? renderModelProjection(state.slot.handle.projection) : "";
		}
	});
	ctx.on("system-prompt/assemble", async (assembly, input, next) => {
		if (!input.agent) return next();
		const state = states.get(input.agent);
		if (!state) return next();
		const current = state.slot;
		if (!current) {
			if (configFor(state.agent).config?.enabled) throw new Error("动态轮次尚未开始");
			return next();
		}
		if (current.error) throw current.error;
		const handle = await freeze(state, input);
		const assert = () => {
			if (state.slot !== current || state.disposed || input.signal?.aborted) throw new Error("动态轮次准入已失效");
		};
		assert();
		const text = handle ? renderModelProjection(handle.projection) : "";
		const replace = (value) => {
			const contexts = value.contexts.filter((context) => text || context.name !== CONTEXT_NAME.ROLE_DYNAMICS).map((context) => context.name === CONTEXT_NAME.ROLE_DYNAMICS ? {
				...context,
				text,
				interpolate: false
			} : context);
			if (text && !contexts.some((context) => context.name === CONTEXT_NAME.ROLE_DYNAMICS)) contexts.push({
				name: CONTEXT_NAME.ROLE_DYNAMICS,
				text,
				interpolate: false
			});
			const tools = value.tools;
			if (current.writable && !state.agent.ctx.tools.get("qqbot_update_state", state.agent)) throw new Error("动态状态工具登记已变化");
			if (current.writable && tools && !tools.some((tool) => ["qqbot_update_state", "run_code"].includes(tool.name))) throw new Error("动态状态工具与请求不一致");
			value.contexts = contexts;
			if (tools) value.tools = tools.filter((tool) => tool.name !== "qqbot_update_state" || current.writable);
			return value;
		};
		replace(assembly);
		const result = replace(await next());
		assert();
		if (handle) ctx.qqbot.lastDynamics.set(state.agent, text);
		return result;
	});
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
function featuresOf(ctx, context) {
	return {
		meme: context.toolSet !== void 0 ? context.toolSet.view(context.scope).has(MEME_TOOL) : context.agent !== void 0 && ctx.get("tools")?.get("send_meme", context.agent) !== void 0,
		memeTool: toolDeclaration$1(ctx, context)
	};
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
			text: features.meme ? perSession((s) => [memeRule(content.memeFrequencyFor(s), content.memePreferencesFor(s)), features.memeTool].filter(Boolean).join("\n")) : ""
		},
		{
			name: SECTION_NAME.FORMAT_VOICE,
			order: SECTION_ORDER.FORMAT_VOICE,
			text: VOICE_RULE
		},
		{
			name: SECTION_NAME.DYNAMICS_TOOL,
			order: SECTION_ORDER.DYNAMICS_TOOL,
			text: features.dynamicsTool ?? ""
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
			const text = assembleParts(content, store, session, {
				...featuresOf(ctx, context),
				dynamicsTool: toolDeclaration(ctx, context)
			}).map((part) => part.text).join("\n\n");
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
	ctx.plugin(agent_exports);
	ctx.plugin(meme_agent_exports);
	ctx.plugin(memory_agent_exports);
}
export { DEFAULT_MEME_FREQUENCY as A, dshHome as B, object as C, toneOf as D, isMemeFrequency as E, ROLE_PROACTIVITIES as F, writeText as G, readJson as H, ROLE_PROACTIVITY_TEXT_LIMIT as I, __exportAll as K, motionActionName as L, MEME_FREQUENCIES as M, MEME_PROMPT_LIMIT as N, normalizeMemory as O, MOTION_RANGES as P, SessionBindings as R, jsonData as S, MEME_TOOL as T, renameWithRetry as U, isRecord$1 as V, writeJson as W, MemoryCoordinator as _, name as a, inside as b, recoverDynamicsSelections as c, MEME_SCOPE_PATH as d, CONTEXT_NAME as f, resolveText as g, QqbotRegistryStore as h, inject as i, LIBRARY_PATH as j, isRecord as k, lastTurnOf as l, presetForAgent as m, apply as n, renderRuntime as o, SECTION_NAME as p, assembleParts as r, DynamicsHost as s, PART_SEPARATOR as t, toolDeclaration$1 as u, outcomeMessage as v, validateConfig as w, digest as x, FileDataTransaction as y, dataDir as z };
