// Ported from pi-muse-bridge (MIT, ferdousbhai/pi-muse-bridge). This
// package now owns the whole "muse-code" provider itself instead of
// hooking another package's provider from the outside, so it can resume a
// real muse session (see src/session.ts, src/runtime.ts) instead of
// re-sending folded history text on every turn.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMuseCatalog, type MuseCatalogModel } from "./catalog.ts";
import { buildFirstTurnPrompt, latestUserText } from "./fold.ts";
import { loadMuseSystemPrompt, runMuse } from "./runtime.ts";
import { createMuseSessionTracker } from "./session.ts";

const MUSE_API = "muse-code-cli" as Api;
const ALIAS_ID = "muse-spark";

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

// One tracker per loaded extension instance, i.e. one muse session per
// running Pi process. See src/session.ts for why that's an acceptable
// simplification rather than a bug.
const nextMuseTurn = createMuseSessionTracker();

export function streamMuse(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	yolo = true,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyMessage(model);

	void (async () => {
		let textStarted = false;
		let streamedText = "";
		const pushDelta = (delta: string) => {
			if (!delta) return;
			if (!textStarted) {
				output.content.push({ type: "text", text: "" });
				textStarted = true;
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
			}
			const block = output.content[0];
			if (!block || block.type !== "text") return;
			block.text += delta;
			streamedText += delta;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
		};

		try {
			stream.push({ type: "start", partial: output });
			const { sessionId, isFirstTurn } = nextMuseTurn();
			// First turn of this muse session: nothing to resume yet, so fold
			// the full prior Pi conversation into the prompt. Every later turn:
			// muse already remembers everything up to here via --session-id,
			// so just forward the newest user message.
			const task = (isFirstTurn ? buildFirstTurnPrompt(context.messages) : latestUserText(context.messages)).trim();
			if (!task) throw new Error("Muse provider received an empty user task");
			const prompt = `${loadMuseSystemPrompt()}\n\n---\n\n${task}`;
			const result = await runMuse({
				prompt,
				cwd: process.cwd(),
				model: model.id,
				sessionId,
				thinkingLevel: options?.reasoning,
				yolo,
				signal: options?.signal,
				onTextDelta: pushDelta,
			});

			if (result.exitCode !== 0) throw new Error(result.errorMessage || `Muse exited with code ${result.exitCode}`);
			if (!streamedText) pushDelta(result.output);
			else if (result.output.startsWith(streamedText)) pushDelta(result.output.slice(streamedText.length));
			else if (result.output !== streamedText) {
				result.diagnostics.push("Muse terminal output differed from its streamed output; preserved streamed output");
			}

			output.responseModel = result.model;
			output.usage.input = result.usage.input;
			output.usage.output = result.usage.output;
			output.usage.cacheRead = result.usage.cacheRead;
			output.usage.cacheWrite = result.usage.cacheWrite;
			output.usage.totalTokens = result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite;
			calculateCost(model, output.usage);
			if (result.usage.cost > 0) output.usage.cost.total = result.usage.cost;
			if (result.diagnostics.length > 0) {
				output.diagnostics = result.diagnostics.map((message) => ({
					type: "muse-code",
					timestamp: Date.now(),
					error: { message },
				}));
			}
			const block = output.content[0];
			if (block?.type === "text") {
				stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
			}
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function sandboxedFromEnvironment(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_MUSE_SANDBOXED?.trim() ?? "");
}

export function registerMuseProvider(pi: ExtensionAPI): void {
	pi.registerFlag("muse-sandboxed", {
		description: "Run Muse with its sandbox enabled and approval prompts disabled",
		type: "boolean",
		default: false,
	});
	pi.registerProvider("muse-code", {
		name: "Muse Code",
		baseUrl: "http://localhost",
		apiKey: "muse-code-local",
		api: MUSE_API,
		models: getMuseProviderModels(),
		streamSimple: (model, context, options) =>
			streamMuse(model, context, options, pi.getFlag("muse-sandboxed") !== true && !sandboxedFromEnvironment()),
	});
}
