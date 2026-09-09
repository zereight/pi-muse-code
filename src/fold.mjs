// Keep folded prompts bounded: long sessions would otherwise blow up the
// one-shot `muse exec` prompt. Newest turns win; older ones are dropped.
export const MAX_PRIOR_TURNS = 20;
export const MAX_PRIOR_CHARS = 12000;
// One giant tool result (e.g. a workflow dump) must not eat the whole
// MAX_PRIOR_CHARS budget and evict the actual conversation around it.
export const MAX_MESSAGE_CHARS = 2000;

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function capText(text) {
	if (text.length <= MAX_MESSAGE_CHARS) return text;
	const half = Math.floor(MAX_MESSAGE_CHARS / 2);
	const cut = text.length - MAX_MESSAGE_CHARS;
	return `${text.slice(0, half)}\n... (message truncated, ${cut} chars cut) ...\n${text.slice(text.length - half)}`;
}

function formatMessage(msg) {
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
		// Non-text blocks (toolCall args, images) are intentionally skipped:
		// the one-shot CLI prompt only carries readable text.
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
		return `Bash: ${msg.command}\n${capText(msg.output ?? "")}`;
	}
	return undefined;
}

function findLastUserIndex(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

/** Raw text of the latest user message. Used once a muse session is
 * already resumed via --session-id, since muse remembers everything
 * before this turn on its own. */
export function latestUserText(messages) {
	const index = findLastUserIndex(messages);
	if (index < 0) throw new Error("No user message found in context");
	return textOf(messages[index].content);
}

/** Full prior history folded into one prompt string, for the first turn
 * of a fresh muse session (nothing to resume yet). */
export function buildFirstTurnPrompt(messages) {
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
