// MSP turn execution for the `muse-code` provider. The host stays up (see
// src/host.ts), so a turn is a `turn/start` command on an open session and
// the events arrive typed.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { forgetDeadHost, interruptMuseTurnAsync, type MuseSessionEntry } from "./host.ts";

export type MuseThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The MSP `ReasoningEffort` vocabulary for the subset this provider can ask for. */
export type MuseReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface MuseUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextTokens: number;
	turns: number;
}

/** Structural slice of the MSP `TokenUsage` this package reads. */
export interface MuseTokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cachedTokens?: number;
}

export interface MuseTurnRequest {
	entry: MuseSessionEntry;
	/** The full prompt for this turn, system prompt and any folded history included. */
	prompt: string;
	/** What the session transcript should show in place of `prompt`. */
	displayText?: string;
	thinkingLevel?: MuseThinkingLevel;
	signal?: AbortSignal;
	onTextDelta?: (delta: string) => void;
}

export interface MuseTurnResult {
	/** The finished reply, from the session's own item store. */
	text: string;
	/** What was streamed live, so the caller can send only the remainder. */
	streamed: string;
	/** True when this turn carried the folded Pi conversation. */
	folded: boolean;
	usage: MuseUsage;
	diagnostics: string[];
}

const EMPTY_USAGE: MuseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
/** Pi's thinking levels to MSP `ReasoningEffort`; the tiers differ at both ends. */
export function museThinkingLevel(level: MuseThinkingLevel | undefined): MuseReasoningEffort | undefined {
	if (level === "off") return "none";
	if (level === "max") return "ultra";
	return level;
}

/**
 * Is this `item/delta` part of the answer? `agentMessage.text` streams with no
 * field; reasoning summaries stream as `summary.N` and tool output as `output`,
 * and neither belongs in Pi's assistant message.
 */
export function isAnswerTextDelta(field: string | undefined): boolean {
	return field === undefined || field === "text";
}

export function readTurnUsage(usage: MuseTokenUsage | undefined): MuseUsage {
	if (!usage) return { ...EMPTY_USAGE };
	const input = usage.inputTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	return {
		input,
		output,
		cacheRead: usage.cacheReadTokens ?? usage.cachedTokens ?? 0,
		cacheWrite: usage.cacheWriteTokens ?? 0,
		contextTokens: input + output,
		turns: 1,
	};
}

/** `turn/completed` carries an aggregate, but it is absent on some hosts. */
function hasUsage(usage: MuseTokenUsage | undefined): boolean {
	return Boolean(usage && ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0));
}

/** The session's counted-once usage, but only when it belongs to this turn. */
function sessionTurnUsage(entry: MuseSessionEntry, turnId: string): MuseTokenUsage | undefined {
	const state = entry.session.fold.sessionState.get("session/tokenUsage") as unknown as
		| ({ turnId?: string; usage?: MuseTokenUsage })
		| undefined;
	return state?.turnId === turnId ? state.usage : undefined;
}

/** An `agentMessage` item's final text; the delta stream may have saturated it. */
function answerTextOf(item: unknown): string | undefined {
	if (!item || typeof item !== "object") return undefined;
	const record = item as { kind?: unknown; text?: unknown };
	if (record.kind !== "agentMessage" || typeof record.text !== "string") return undefined;
	return record.text.trim() === "" ? undefined : record.text;
}

/** The last streamed answer item's final text, which the delta stream may have saturated. */
export function pickFinalAnswerText(getItem: (itemId: string) => unknown, itemIds: readonly string[]): string | undefined {
	for (let index = itemIds.length - 1; index >= 0; index -= 1) {
		const text = answerTextOf(getItem(itemIds[index]));
		if (text !== undefined) return text;
	}
	return undefined;
}

export function getBundledAgentPath(): string {
	return fileURLToPath(new URL("../agents/muse-spark.md", import.meta.url));
}

export function loadMuseSystemPrompt(): string {
	const filePath = getBundledAgentPath();
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(fs.readFileSync(filePath, "utf8"));
	if (frontmatter.name !== "muse-spark" || !frontmatter.description || !body.trim()) {
		throw new Error(`Invalid bundled Muse agent definition: ${filePath}`);
	}
	return body.trim();
}

export async function runMuseTurn(request: MuseTurnRequest): Promise<MuseTurnResult> {
	const { entry } = request;
	const folded = entry.needsFold;
	let aborted = request.signal?.aborted === true;
	let abortTurn: (() => void) | undefined;
	const abort = () => {
		aborted = true;
		abortTurn?.();
	};
	request.signal?.addEventListener("abort", abort, { once: true });

	let streamed = "";
	const answerItemIds: string[] = [];

	try {
		const turn = await entry.session.sendUserTurn({
			input: [{ type: "text", text: request.prompt }],
			displayText: request.displayText ?? request.prompt,
			reasoningEffort: museThinkingLevel(request.thinkingLevel),
		});
		entry.needsFold = false;

		abortTurn = () => {
			void interruptMuseTurnAsync(entry, turn.turnId).catch(() => undefined);
		};
		if (aborted) abortTurn();

		const pump = (async () => {
			for await (const delta of turn.deltas()) {
				if (aborted || !delta.delta || !isAnswerTextDelta(delta.field)) continue;
				answerItemIds.push(delta.itemId);
				streamed += delta.delta;
				request.onTextDelta?.(delta.delta);
			}
		})();

		const outcome = await turn.completed;
		if (aborted) {
			// The interrupt stops the work on the host; this reader just detaches.
			void pump.catch(() => undefined);
			throw new Error("Muse run was aborted");
		}
		await pump;

		if (outcome.kind !== "completed") throw new Error(`Muse turn was ${outcome.kind} before it could run`);
		const terminal = outcome.params;
		if (terminal.terminal === "failed") {
			throw new Error(terminal.error?.message || terminal.reason || "Muse turn failed");
		}

		return {
			text: pickFinalAnswerText((itemId) => entry.session.fold.items.get(itemId), answerItemIds) ?? streamed,
			streamed,
			folded,
			usage: readTurnUsage(hasUsage(terminal.usage) ? terminal.usage : sessionTurnUsage(entry, turn.turnId)),
			diagnostics: entry.diagnostics.splice(0),
		};
	} catch (error) {
		forgetDeadHost(error);
		throw error;
	} finally {
		request.signal?.removeEventListener("abort", abort);
	}
}
