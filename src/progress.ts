// Compact progress lines for muse-side activity, rendered into a Pi thinking
// block plus the live working message. One line per tool call, shell run,
// subagent, or workflow transition — never Pi tool calls, which Pi would
// re-execute, and never raw tool output, which would flood the transcript.
export const MAX_PROGRESS_LINES = 200;
export const MAX_PROGRESS_LINE_CHARS = 300;
export const MAX_PROGRESS_TOTAL_CHARS = 20000;

/** Structural slice of the MSP `Item` this package renders. */
export interface MuseViewItem {
	itemId: string;
	kind: string;
	status: string;
	tool?: string;
	args?: string;
	commandText?: string;
	exitCode?: number;
	role?: string;
	objective?: string;
	controlStatus?: string;
	entryId?: string;
	scriptId?: string;
	message?: string;
	outcome?: string;
	reason?: string;
	failureReason?: string;
	fallbackText?: string;
	summary?: string[];
}

export function compactOneLine(text: string, cap = MAX_PROGRESS_LINE_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= cap) return flat;
	return `${flat.slice(0, Math.max(0, cap - 3))}...`;
}

const SALIENT_ARG_KEYS = [
	"command",
	"commandText",
	"cmd",
	"path",
	"filePath",
	"file",
	"pattern",
	"query",
	"url",
	"text",
	"prompt",
	"message",
];

/** A short `k=v` read of model-authored tool args; never throws. */
export function summarizeArgs(args: string | undefined): string {
	if (!args) return "";
	const raw = args.trim();
	if (!raw) return "";
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const entries = Object.entries(parsed as Record<string, unknown>);
			const salient = SALIENT_ARG_KEYS.map((key) => [key, (parsed as Record<string, unknown>)[key]] as const).find(
				([, value]) => typeof value === "string" && value.trim() !== "",
			);
			if (salient) {
				const rest = entries.length - 1;
				return compactOneLine(`${salient[0]}=${(salient[1] as string).trim()}${rest > 0 ? ` (+${rest} more)` : ""}`, 160);
			}
			if (entries.length > 0) return compactOneLine(`(${entries.length} args)`, 160);
		}
	} catch {
		// Almost-JSON or plain text: fall through to the raw read.
	}
	return compactOneLine(raw, 160);
}

function isTerminal(status: string): boolean {
	return status !== "inProgress";
}

interface ItemProgressState {
	seen: boolean;
	done: boolean;
	summarized: boolean;
	lastStatus?: string;
}

/**
 * Turns a live item stream into progress lines. Items arrive on open and on
 * every revision change; already-terminal items may arrive exactly once, so a
 * first sighting in a terminal state emits both the open line and the outcome.
 */
export class ProgressTracker {
	private states = new Map<string, ItemProgressState>();
	private lines = 0;
	private chars = 0;
	private truncated = false;

	private stateFor(itemId: string): ItemProgressState {
		let state = this.states.get(itemId);
		if (!state) {
			state = { seen: false, done: false, summarized: false };
			this.states.set(itemId, state);
		}
		return state;
	}

	/** Reasoning summaries already streamed live; skip the completion re-emit. */
	markSummarized(itemId: string): void {
		this.stateFor(itemId).summarized = true;
	}

	/** Budget gate: caps lines and chars, appends one truncation notice. */
	take(lines: string[]): string[] {
		if (this.truncated) return [];
		const kept: string[] = [];
		for (const line of lines) {
			if (this.lines >= MAX_PROGRESS_LINES || this.chars + line.length > MAX_PROGRESS_TOTAL_CHARS) {
				this.truncated = true;
				kept.push("(further muse progress hidden)");
				break;
			}
			this.lines += 1;
			this.chars += line.length;
			kept.push(line);
		}
		return kept;
	}

	linesFor(item: MuseViewItem): string[] {
		const state = this.stateFor(item.itemId);
		const terminal = isTerminal(item.status);
		switch (item.kind) {
			case "userMessage":
			case "agentMessage":
			case "reminderChild":
				return [];
			case "toolCall": {
				const name = item.tool?.trim() || "tool";
				const out: string[] = [];
				if (!state.seen) {
					state.seen = true;
					const args = summarizeArgs(item.args);
					out.push(args ? `tool ${name} ${args}` : `tool ${name}`);
				}
				if (terminal && !state.done) {
					state.done = true;
					if (item.status === "completed") out.push(`tool ${name} done`);
					else if (item.failureReason?.trim()) out.push(compactOneLine(`tool ${name} ${item.status}: ${item.failureReason.trim()}`));
					else out.push(`tool ${name} ${item.status}`);
				}
				return out;
			}
			case "userShell": {
				const out: string[] = [];
				if (!state.seen) {
					state.seen = true;
					out.push(compactOneLine(`shell ${item.commandText?.trim() || "(command)"}`));
				}
				if (terminal && !state.done) {
					state.done = true;
					out.push(item.exitCode === undefined ? `shell ${item.status}` : `shell exit ${item.exitCode}`);
				}
				return out;
			}
			case "subagent": {
				const role = item.role?.trim() || "subagent";
				const out: string[] = [];
				if (!state.seen) {
					state.seen = true;
					const objective = item.objective?.trim();
					out.push(objective ? compactOneLine(`subagent ${role}: ${objective}`) : `subagent ${role}`);
				}
				if (terminal && !state.done) {
					state.done = true;
					out.push(`subagent ${role} ${item.controlStatus?.trim() || item.status}`);
				}
				return out;
			}
			case "workflow": {
				if (state.lastStatus === item.status) return [];
				state.lastStatus = item.status;
				const id = item.entryId?.trim() || item.scriptId?.trim();
				const message = item.message?.trim();
				return [compactOneLine(`workflow${id ? ` ${id}` : ""} ${item.status}${message ? `: ${message}` : ""}`)];
			}
			case "compaction": {
				if (!terminal || state.done) return [];
				state.done = true;
				const how = item.outcome?.trim() || item.reason?.trim() || item.status;
				return [`compaction ${how}`];
			}
			case "reasoning": {
				// Summaries normally stream live via `summary.N` deltas; this is the
				// fallback for items that completed before any delta was observed.
				if (!terminal || state.done || state.summarized || !item.summary?.length) return [];
				state.done = true;
				return item.summary.flatMap((part) => part.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => compactOneLine(line)));
			}
			default: {
				if (state.lastStatus === item.status) return [];
				state.lastStatus = item.status;
				const fallback = item.fallbackText?.trim();
				return [compactOneLine(`${item.kind} ${item.status}${fallback ? `: ${fallback}` : ""}`)];
			}
		}
	}
}
