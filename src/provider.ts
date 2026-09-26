// The `muse-code` provider, driven over MSP against a persistent `muse serve`
// host (src/host.ts). The host's approval requests are answered through Pi's
// own UI.
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMuseCatalog, resolveMuseModelId, type MuseCatalogModel } from "./catalog.ts";
import { buildCatchUpPrompt, buildFirstTurnPrompt, latestUserText } from "./fold.ts";
import {
	closeHostAsync,
	isSandboxed,
	openSessionAsync,
	type MuseSessionEntry,
} from "./host.ts";
import { loadMuseSystemPrompt, runMuseTurn } from "./runtime.ts";

const MUSE_API = "muse-code-cli" as Api;
const ALIAS_ID = "muse-spark";
const EPHEMERAL_KEY = "ephemeral";

const FALLBACK_MODEL: MuseCatalogModel = {
	id: ALIAS_ID,
	name: "Muse Spark",
	isDefault: true,
	isCurrent: true,
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function modelDefinition(model: MuseCatalogModel, id = model.id, name = model.name) {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: { off: "off", xhigh: "xhigh", max: "max" },
		input: ["text"] as Array<"text" | "image">,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function getMuseProviderModels() {
	try {
		const catalog = getMuseCatalog();
		const defaultModel = catalog.models.find((model) => model.id === catalog.defaultId) ?? FALLBACK_MODEL;
		return [
			modelDefinition(defaultModel, ALIAS_ID, "Muse Spark (catalog default)"),
			...catalog.models
				.filter((model) => model.id !== ALIAS_ID)
				.map((model) => modelDefinition(model)),
		];
	} catch {
		// Keep Pi usable before Muse is installed or logged in; execution reports the catalog error.
		return [modelDefinition(FALLBACK_MODEL)];
	}
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

// One Pi session per process in practice, but `/new` and `/resume` swap the
// session file under a live extension instance, so the key is read per turn.
let currentContext: ExtensionContext | undefined;

function currentSessionKey(): string {
	try {
		return currentContext?.sessionManager.getSessionFile() ?? EPHEMERAL_KEY;
	} catch {
		return EPHEMERAL_KEY;
	}
}

/** Sessions whose approval/diagnostic handlers are already wired. */
const wired = new WeakSet<MuseSessionEntry>();

/** Structural slices of the MSP approval events this package renders. */
interface MuseApprovalChoice {
	choiceId: string;
	label: string;
	decision: string;
}

interface MuseApprovalRequest {
	approvalId: string;
	availableChoices: MuseApprovalChoice[];
	toolName?: string;
	subject?: { kind?: string; target?: string; command?: string; path?: string };
}

interface MuseApprovalFailure {
	kind: string;
	approvalId: string;
}

function approvalTarget(request: MuseApprovalRequest): string {
	const subject = request.subject;
	return subject?.target ?? subject?.command ?? subject?.path ?? subject?.kind ?? "tool use";
}

function fallbackChoiceId(request: MuseApprovalRequest): string | undefined {
	// No UI, or the user dismissed the prompt: prefer a denial the server
	// offered; the router refuses a choice the request never offered.
	const denied = request.availableChoices.find((choice) => choice.decision.startsWith("denied"));
	return denied?.choiceId ?? request.availableChoices[0]?.choiceId;
}

async function answerApprovalAsync(request: MuseApprovalRequest): Promise<{ choiceId: string }> {
	const choices = request.availableChoices;
	const fallback = fallbackChoiceId(request);
	if (!fallback) return { choiceId: "" };
	const ui = currentContext?.hasUI ? currentContext.ui : undefined;
	if (!ui) return { choiceId: fallback };
	const label = (choice: MuseApprovalChoice) => `${choice.label} (${choice.decision})`;
	const picked = await ui.select(`Muse approval: ${request.toolName || "tool"} — ${approvalTarget(request)}`, choices.map(label));
	const index = picked === undefined ? -1 : choices.findIndex((choice) => label(choice) === picked);
	return { choiceId: index >= 0 ? choices[index].choiceId : fallback };
}

function wireSession(entry: MuseSessionEntry): void {
	if (wired.has(entry)) return;
	wired.add(entry);
	entry.session.onApproval((request) => answerApprovalAsync(request));
	entry.session.onApprovalError((failure: MuseApprovalFailure) => {
		entry.diagnostics.push(`Muse approval failed (${failure.kind}): ${failure.approvalId}`);
	});
	entry.session.onGapError((error: { message: string }) => {
		entry.diagnostics.push(`Muse view gap fill failed: ${error.message}`);
	});
}

export function streamMuse(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	sandboxed: boolean,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyMessage(model);

	void (async () => {
		let textIndex: number | undefined;
		let streamedText = "";
		// Block indexes are assigned lazily: progress (thinking) normally
		// arrives before the answer, but either order must stay consistent.
		const pushDelta = (delta: string) => {
			if (!delta) return;
			if (textIndex === undefined) {
				textIndex = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
			}
			const block = output.content[textIndex];
			if (!block || block.type !== "text") return;
			block.text += delta;
			streamedText += delta;
			stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
		};

		let thinkingIndex: number | undefined;
		let thinkingText = "";
		const pushThinking = (delta: string) => {
			if (!delta) return;
			if (thinkingIndex === undefined) {
				thinkingIndex = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
			}
			const block = output.content[thinkingIndex];
			if (!block || block.type !== "thinking") return;
			block.thinking += delta;
			thinkingText += delta;
			stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
		};
		const endThinking = () => {
			if (thinkingIndex === undefined) return;
			stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinkingText, partial: output });
			thinkingIndex = undefined;
		};

		const ui = currentContext?.hasUI ? currentContext.ui : undefined;
		const setWorking = (message?: string) => {
			try {
				ui?.setWorkingMessage(message);
			} catch {
				// Progress display must never fail the turn.
			}
		};

		try {
			stream.push({ type: "start", partial: output });
			setWorking("Muse is working...");
			const entry = await openSessionAsync({
				key: currentSessionKey(),
				workspaceRoot: process.cwd(),
				// The Pi-facing alias `muse-spark` is the catalog default, not a muse id.
				modelId: resolveMuseModelId(model.id),
				sandboxed,
			});
			wireSession(entry);

			// First turn of this muse session: nothing to resume yet, so fold the
			// full prior Pi conversation into the prompt. Every later turn: the
			// session already remembers everything up to here, so forward the
			// newest user message plus whatever other models did in the meantime.
			const task = (entry.needsFold ? buildFirstTurnPrompt(context.messages) : latestUserText(context.messages)).trim();
			if (!task) throw new Error("Muse provider received an empty user task");
			const catchUp = entry.needsFold ? undefined : buildCatchUpPrompt(context.messages);
			const systemPrompt = loadMuseSystemPrompt();
			const prompt = [systemPrompt, catchUp, task].filter(Boolean).join("\n\n---\n\n");
			const result = await runMuseTurn({
				entry,
				prompt,
				displayText: task,
				thinkingLevel: options?.reasoning,
				signal: options?.signal,
				onTextDelta: pushDelta,
				onThinkingDelta: pushThinking,
				onProgress: (line) => {
					pushThinking(`${line}\n`);
					setWorking(`Muse: ${line.slice(0, 80)}`);
				},
			});

			if (!streamedText) pushDelta(result.text);
			else if (result.text.startsWith(streamedText)) pushDelta(result.text.slice(streamedText.length));
			else if (result.text !== streamedText) {
				result.diagnostics.push("Muse final text differed from its streamed output; preserved streamed output");
			}

			output.responseModel = model.id;
			output.usage.input = result.usage.input;
			output.usage.output = result.usage.output;
			output.usage.cacheRead = result.usage.cacheRead;
			output.usage.cacheWrite = result.usage.cacheWrite;
			output.usage.totalTokens = result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite;
			calculateCost(model, output.usage);
			if (result.diagnostics.length > 0) {
				output.diagnostics = result.diagnostics.map((message) => ({
					type: "muse-code",
					timestamp: Date.now(),
					error: { message },
				}));
			}
			endThinking();
			setWorking();
			const block = textIndex === undefined ? undefined : output.content[textIndex];
			if (block?.type === "text" && textIndex !== undefined) {
				stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
			}
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			endThinking();
			setWorking();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export function registerMuseProvider(pi: ExtensionAPI): void {
	pi.registerFlag("muse-sandboxed", {
		description: "Run Muse with its sandbox enabled and approval prompts routed through Pi",
		type: "boolean",
		default: false,
	});
	pi.on("session_start", (_event, context) => {
		currentContext = context;
	});
	pi.on("session_shutdown", async () => {
		currentContext = undefined;
		await closeHostAsync();
	});
	pi.registerProvider("muse-code", {
		name: "Muse Code",
		baseUrl: "http://localhost",
		apiKey: "muse-code-local",
		api: MUSE_API,
		models: getMuseProviderModels(),
		streamSimple: (model, context, options) =>
			streamMuse(model, context, options, isSandboxed(pi.getFlag("muse-sandboxed") === true)),
	});
}
