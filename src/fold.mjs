export const PRIOR_MARKER = "<!-- pi-muse-prior-context -->";
export const SESSION_MARKER_PREFIX = "<!-- pi-muse-session-id:";
const SESSION_MARKER_SUFFIX = " -->";

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

function capText(text) {
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

function formatSessionMarker(museSessionId) {
	return `${SESSION_MARKER_PREFIX}${museSessionId}${SESSION_MARKER_SUFFIX}`;
}

/**
 * @param {unknown[]} messages
 * @param {{ museSessionId?: string, seeded?: boolean }} [options]
 *   museSessionId: a stable muse `--session-id` for this Pi session, if the
 *   caller's pi-muse-bridge build understands the `pi-muse-session-id`
 *   marker and resumes that muse session instead of starting cold.
 *   seeded: true once this museSessionId has already received the full
 *   prior-context fold on an earlier turn. When true, only the session
 *   marker is (re)attached; the expensive text fold is skipped, since a
 *   resumed muse session already remembers its own earlier turns.
 */
export function foldMuseContext(messages, options = {}) {
	const { museSessionId, seeded } = options;
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
	// Already processed this exact message (e.g. a re-fired hook on the
	// same request). Leave it alone.
	if (currentText.includes(PRIOR_MARKER) || currentText.includes(SESSION_MARKER_PREFIX)) {
		return undefined;
	}

	const priorFormatted = messages.slice(0, lastUser).map(formatMessage).filter(Boolean);
	const shouldFold = !seeded && priorFormatted.length > 0;

	let body = currentText;
	if (shouldFold) {
		let prior = priorFormatted;
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
		body = [
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
	}

	if (museSessionId) {
		body = `${formatSessionMarker(museSessionId)}\n${body}`;
	}

	if (body === currentText) return undefined;
	const next = messages.slice();
	next[lastUser] = { ...current, content: body };
	return next;
}
