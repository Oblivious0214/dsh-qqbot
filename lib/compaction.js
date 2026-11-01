import { BlockAssembler, LlmError, contentHasImage } from "@deepseek-ai/dsh-llm";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
/**
* 摘要指令，作为最后一条 user 消息接在回放的对话后面，前缀缓存和原版一样复用。
* 栏目没有内容时整栏省略：对话短时摘要比原文长会被 compaction-basic 拒绝。
*/
const CHAT_COMPACTION_INSTRUCTION = [
	"现在暂停角色扮演，改做摘要整理。把上面的聊天整理成一份存档，让之后的对话能无缝接着聊下去。",
	"",
	"按下面的结构输出，栏目顺序不变。没有内容的栏目整栏省略。每条一行，用短句，不写成段落。",
	"",
	"## 人物与称呼",
	"- [出场的角色和用户；彼此怎么称呼，昵称、外号原样保留]",
	"",
	"## 关系进展",
	"- [关系现在到了哪一步，经历过的转折]",
	"",
	"## 经过",
	"- [按时间顺序的要点，每条写明是谁说的、谁做的；切换过角色时写明何时换成了谁]",
	"",
	"## 当前场景",
	"- [最后在哪里、在做什么、气氛如何，话题停在哪]",
	"",
	"## 约定与待办",
	"- [还没兑现的约定、计划、提醒，带上时间和细节，写明是谁提出的、谁答应的]",
	"",
	"## 用户偏好",
	"- [只写用户本人说过的喜好、忌口、禁忌、对回复方式的要求，以及纠正过的地方。不写角色设定和说话风格，已写进约定与待办的不再重复]",
	"",
	"规则：",
	"- 用中文写。人名、称呼、数字、时间、地点照原文写，不改写。",
	"- 用户的关键原话用引号原样保留。",
	"- 只记录实际发生过的内容，不推测，不补写。",
	"- 不要提到这次整理，也不要说对话被压缩过。",
	"- 只输出存档正文：不调用工具，不输出 [qq] 分段块，不用角色口吻回复。",
	`- 如果上面已有 <compacted-summary> 块，那是之前的存档。不要原样照抄：保留仍然成立的内容，删掉过时的，把新内容合并进同一份存档，结构不变。`
].join("\n");
/**
* 用中文聊天模板生成摘要。目标模型、上限、按模型覆盖的取法和 compaction-basic 相同：
* 配置的摘要模型 → 最近一次请求的模型 → AgentOptions。
*/
async function summarizeChat(llm, config, input, agent, signal) {
	const latest = agent.session.requestHeader()?.config;
	const latestTarget = latest !== void 0 && latest.provider !== "" && latest.model !== "" ? {
		provider: latest.provider,
		model: latest.model
	} : void 0;
	const agentTarget = nonEmptyTarget(agent.options.provider, agent.options.model);
	const policy = policyFor(config, latestTarget ?? agentTarget);
	const target = nonEmptyTarget(policy.summarizationProvider, policy.summarizationModel) ?? latest ?? agentTarget;
	if (target === void 0) throw new Error("no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields");
	const messages = [...input.messages, Object.freeze({
		role: "user",
		content: Object.freeze([{
			type: "text",
			text: CHAT_COMPACTION_INSTRUCTION
		}])
	})];
	const options = {
		provider: target.provider,
		model: target.model,
		messages,
		toolHistory: agent.session.toolHistory(),
		...input.tools === void 0 ? {} : { tools: [...input.tools] },
		maxTokens: policy.maxTokens,
		sessionId: agent.session.id,
		purpose: "compaction",
		...signal === void 0 ? {} : { signal }
	};
	const assembler = new BlockAssembler();
	for await (const chunk of llm.stream(options)) assembler.push(chunk);
	const error = finishError(assembler.finish);
	if (error !== void 0) throw error;
	const rawOutput = assembler.blocks();
	const summary = summaryText(rawOutput);
	if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
	return {
		summary,
		rawOutput,
		llmStreamCall: true,
		provider: options.provider,
		model: options.model,
		maxTokens: policy.maxTokens,
		...assembler.usage === void 0 ? {} : { usage: assembler.usage }
	};
}
/** 默认摘要配置合并按模型的覆盖（compaction-basic 的 resolveTargetPolicy 中摘要用到的部分）。 */
function policyFor(config, target) {
	const override = target === void 0 ? void 0 : config.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model);
	return {
		summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
		summarizationModel: override?.summarizationModel ?? config.summarizationModel,
		maxTokens: override?.maxTokens ?? config.maxTokens
	};
}
function nonEmptyTarget(provider, model) {
	return provider === void 0 || provider === "" || model === void 0 || model === "" ? void 0 : {
		provider,
		model
	};
}
/** 摘要没有正常结束时报错，不落半截存档。 */
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
		case "max-tokens": {
			const error = /* @__PURE__ */ new Error("summarization truncated at the token cap (incomplete checkpoint)");
			error.code = "MAX_TOKENS";
			return error;
		}
		default: return;
	}
}
/** 只留文字；摘要里有图片时报错，不让图片悄悄消失。 */
function summaryText(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
	return blocks.filter((block) => block.type === "text");
}
/** compaction-basic 换成中文聊天模板。配置项、服务名、自动压缩和 `/compact` 都和原版相同。 */
var QqbotCompactionEngine = class extends BasicCompactionEngine {
	async summarize(input, agent, signal) {
		const consolidation = this.ctx.get("qqbot")?.memory.consolidate(agent.id).then((outcome) => {
			if (outcome.kind === "failed") this.ctx.logger.warn(`qqbot: 记忆整理失败：${outcome.error}`);
		}, () => {});
		const summary = await summarizeChat(this.ctx.llm, this.config, input, agent, signal);
		if (consolidation !== void 0) await untilAborted(consolidation, signal);
		return summary;
	}
};
/** 等 promise 结束；压缩被取消时不再等。 */
function untilAborted(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			signal.removeEventListener("abort", done);
			resolve();
		};
		signal.addEventListener("abort", done, { once: true });
		promise.then(done);
	});
}
export { CHAT_COMPACTION_INSTRUCTION, QqbotCompactionEngine, QqbotCompactionEngine as default, summarizeChat };
