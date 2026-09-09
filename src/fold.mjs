export const PRIOR_MARKER = "<!-- pi-muse-prior-context -->";

// Keep folded prompts bounded: long sessions would otherwise blow up the
// one-shot `muse exec` prompt. Newest turns win; older ones are dropped.
export const MAX_PRIOR_TURNS = 20;
export const MAX_PRIOR_CHARS = 12000;

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function formatMessage(msg) {
	if (msg.role === "user") {
		const text = textOf(msg.content);
		return text ? `User:\n${text}` : undefined;
	}
	if (msg.role === "assistant") {
		const text = textOf(msg.content);
		const label =
			typeof msg.provider === "string" && typeof msg.model === "string"
				? `Assistant (${msg.provider}/${msg.model})`
				: "Assistant";
		// Non-text blocks (toolCall args, images) are intentionally skipped:
		// the one-shot CLI prompt only carries readable text.
		return text ? `${label}:\n${text}` : undefined;
	}
	if (msg.role === "toolResult") {
		const text = textOf(msg.content);
		const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
		return text ? `Tool ${name}:\n${text}` : undefined;
	}
	if (msg.role === "compactionSummary" && typeof msg.summary === "string") {
		return `Summary:\n${msg.summary}`;
	}
	if (msg.role === "branchSummary" && typeof msg.summary === "string") {
		return `Branch summary:\n${msg.summary}`;
	}
	if (msg.role === "bashExecution") {
		return `Bash: ${msg.command}\n${msg.output ?? ""}`;
	}
	return undefined;
}

export function foldMuseContext(messages) {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return undefined;
	const current = messages[lastUser];
	const currentText = textOf(current.content);
	if (currentText.includes(PRIOR_MARKER)) return undefined;
	let prior = messages.slice(0, lastUser).map(formatMessage).filter(Boolean);
	if (prior.length === 0) return undefined;
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
	const folded = [
		PRIOR_MARKER,
		"Previous Pi session turns, including other models. Continue from Current request.",
		truncated ? "(Older turns truncated to fit the one-shot CLI prompt.)" : "",
		"",
		priorText,
		"",
		"Current request:",
		currentText,
	]
		.filter((line, index) => !(index === 2 && line === ""))
		.join("\n");
	const next = messages.slice();
	next[lastUser] = { ...current, content: folded };
	return next;
}
