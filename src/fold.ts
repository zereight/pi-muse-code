// Keep this as .ts, not .mjs: Pi's bundled CLI loads extensions through
// jiti with tryNative:false, which compiles .ts to CJS. Named imports from
// a sibling .mjs then become `(0, _fold.buildFirstTurnPrompt)(...)` against
// a module object that does not actually have that export.
export const MAX_PRIOR_TURNS = 20;
export const MAX_PRIOR_CHARS = 12000;
export const MAX_MESSAGE_CHARS = 2000;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function capText(text: string): string {
	if (text.length <= MAX_MESSAGE_CHARS) return text;
	const half = Math.floor(MAX_MESSAGE_CHARS / 2);
	const cut = text.length - MAX_MESSAGE_CHARS;
	return `${text.slice(0, half)}\n... (message truncated, ${cut} chars cut) ...\n${text.slice(text.length - half)}`;
}

function formatMessage(msg: {
	role?: string;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	toolName?: unknown;
	summary?: unknown;
	command?: unknown;
	output?: unknown;
}): string | undefined {
	if (msg.role === "user") {
		const text = capText(textOf(msg.content));
		return text ? `User:\n${text}` : undefined;
	}
	if (msg.role === "assistant") {
		const text = capText(textOf(msg.content));
		const label =
			typeof msg.provider === "string" && typeof msg.model === "string"
				? `Assistant (${msg.provider}/${msg.model})`
				: "Assistant";
		return text ? `${label}:\n${text}` : undefined;
	}
	if (msg.role === "toolResult") {
		const text = capText(textOf(msg.content));
		const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
		return text ? `Tool ${name}:\n${text}` : undefined;
	}
	if (msg.role === "compactionSummary" && typeof msg.summary === "string") {
		return `Summary:\n${capText(msg.summary)}`;
	}
	if (msg.role === "branchSummary" && typeof msg.summary === "string") {
		return `Branch summary:\n${capText(msg.summary)}`;
	}
	if (msg.role === "bashExecution") {
		return `Bash: ${msg.command}\n${capText(typeof msg.output === "string" ? msg.output : "")}`;
	}
	return undefined;
}

function findLastUserIndex(messages: Array<{ role?: string }>): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

export function latestUserText(messages: Array<{ role?: string; content?: unknown }>): string {
	const index = findLastUserIndex(messages);
	if (index < 0) throw new Error("No user message found in context");
	return textOf(messages[index].content);
}

export const MUSE_PROVIDER_ID = "muse-code";

type FoldableMessage = {
	role?: string;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	toolName?: unknown;
	summary?: unknown;
	command?: unknown;
	output?: unknown;
};

/** Newest turns first, bounded the same way the first-turn fold is. */
function boundPriorText(prior: string[]): { text: string; truncated: boolean } {
	let truncated = false;
	let bounded = prior;
	if (bounded.length > MAX_PRIOR_TURNS) {
		bounded = bounded.slice(bounded.length - MAX_PRIOR_TURNS);
		truncated = true;
	}
	let text = bounded.join("\n\n");
	if (text.length > MAX_PRIOR_CHARS) {
		text = text.slice(text.length - MAX_PRIOR_CHARS);
		truncated = true;
	}
	return { text, truncated };
}

/**
 * What happened in this Pi session since muse last spoke: turns other models
 * ran while it was not the selected model, plus anything Pi added in between.
 * A live or resumed muse session remembers its own past and nothing else, so
 * without this a "continue what Grok started" reaches muse as a bare
 * instruction. Walking back to muse's own last reply keeps this stateless — no
 * cursor to invalidate when Pi compacts history.
 */
export function buildCatchUpPrompt(messages: FoldableMessage[], provider = MUSE_PROVIDER_ID): string | undefined {
	const lastUser = findLastUserIndex(messages);
	if (lastUser <= 0) return undefined;

	const between: FoldableMessage[] = [];
	for (let index = lastUser - 1; index >= 0; index -= 1) {
		const message = messages[index];
		// Muse authored this one; its session already holds it.
		if (message.role === "assistant" && message.provider === provider) break;
		between.push(message);
	}
	if (between.length === 0) return undefined;

	const prior = between.reverse().map(formatMessage).filter((text): text is string => Boolean(text));
	if (prior.length === 0) return undefined;
	const { text, truncated } = boundPriorText(prior);

	return [
		"Turns that ran in this Pi session while other models held the conversation (you did not see these):",
		truncated ? "(Older turns truncated to fit the fold budget.)" : "",
		"",
		text,
	]
		.filter((line, index) => !(index === 1 && line === ""))
		.join("\n");
}

export function buildFirstTurnPrompt(messages: FoldableMessage[]): string {
	const lastUser = findLastUserIndex(messages);
	if (lastUser < 0) throw new Error("No user message found in context");
	const currentText = textOf(messages[lastUser].content);

	const prior = messages.slice(0, lastUser).map(formatMessage).filter((text): text is string => Boolean(text));
	if (prior.length === 0) return currentText;
	const { text: priorText, truncated } = boundPriorText(prior);

	return [
		"Previous Pi session turns, including other models. Continue from Current request.",
		truncated ? "(Older turns truncated to fit the fold budget.)" : "",
		"",
		priorText,
		"",
		"Current request:",
		currentText,
	]
		.filter((line, index) => !(index === 1 && line === ""))
		.join("\n");
}
