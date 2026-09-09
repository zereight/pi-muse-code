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

export function buildFirstTurnPrompt(
	messages: Array<{
		role?: string;
		content?: unknown;
		provider?: unknown;
		model?: unknown;
		toolName?: unknown;
		summary?: unknown;
		command?: unknown;
		output?: unknown;
	}>,
): string {
	const lastUser = findLastUserIndex(messages);
	if (lastUser < 0) throw new Error("No user message found in context");
	const currentText = textOf(messages[lastUser].content);

	let prior = messages.slice(0, lastUser).map(formatMessage).filter(Boolean);
	if (prior.length === 0) return currentText;

	let truncated = false;
	if (prior.length > MAX_PRIOR_TURNS) {
		prior = prior.slice(prior.length - MAX_PRIOR_TURNS);
		truncated = true;
	}
	let priorText = prior.join("\n\n");
	if (priorText.length > MAX_PRIOR_CHARS) {
		priorText = priorText.slice(priorText.length - MAX_PRIOR_CHARS);
		truncated = true;
	}

	return [
		"Previous Pi session turns, including other models. Continue from Current request.",
		truncated ? "(Older turns truncated to fit the one-shot CLI prompt.)" : "",
		"",
		priorText,
		"",
		"Current request:",
		currentText,
	]
		.filter((line, index) => !(index === 1 && line === ""))
		.join("\n");
}
