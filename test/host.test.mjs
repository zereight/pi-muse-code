import assert from "node:assert/strict";
import test from "node:test";
import {
	getMuseApprovalMode,
	getMuseServeArgs,
	isSandboxed,
	openSessionAsync,
} from "../src/host.ts";
import {
	isAnswerTextDelta,
	museThinkingLevel,
	pickFinalAnswerText,
	readTurnUsage,
} from "../src/runtime.ts";

test("host args reproduce what `muse exec --yolo` used to mean", () => {
	assert.deepEqual(getMuseServeArgs(false), ["serve", "--trust-workspace", "--disable-sandbox"]);
	assert.deepEqual(getMuseServeArgs(true), ["serve", "--trust-workspace"]);
	assert.equal(getMuseApprovalMode(false), "allowAll");
	assert.equal(getMuseApprovalMode(true), "onRequest");
});

test("sandboxed comes from the flag or the env, and only truthy values count", () => {
	assert.equal(isSandboxed(true), true);
	assert.equal(isSandboxed(undefined, { PI_MUSE_SANDBOXED: "yes" }), true);
	assert.equal(isSandboxed(undefined, { PI_MUSE_SANDBOXED: "1" }), true);
	assert.equal(isSandboxed(false, {}), false);
	assert.equal(isSandboxed(undefined, { PI_MUSE_SANDBOXED: "0" }), false);
});

test("thinking levels map to MSP tiers at both ends", () => {
	assert.equal(museThinkingLevel("off"), "none");
	assert.equal(museThinkingLevel("max"), "ultra");
	assert.equal(museThinkingLevel("high"), "high");
	assert.equal(museThinkingLevel(undefined), undefined);
});

test("only text-field deltas reach the assistant message", () => {
	assert.equal(isAnswerTextDelta(undefined), true);
	assert.equal(isAnswerTextDelta("text"), true);
	assert.equal(isAnswerTextDelta("summary.0"), false);
	assert.equal(isAnswerTextDelta("output"), false);
});

test("turn usage comes from the turn's own counters", () => {
	assert.deepEqual(readTurnUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 });
	assert.deepEqual(readTurnUsage({ inputTokens: 100, outputTokens: 20, cachedTokens: 80 }), {
		input: 100,
		output: 20,
		cacheRead: 80,
		cacheWrite: 0,
		contextTokens: 120,
		turns: 1,
	});
	assert.deepEqual(readTurnUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		contextTokens: 3,
		turns: 1,
	});
});

test("the final answer text skips non-message and empty items", () => {
	const items = new Map([
		["reason", { kind: "reasoning", text: "thinking" }],
		["empty", { kind: "agentMessage", text: "  " }],
		["answer", { kind: "agentMessage", text: "hello" }],
	]);
	const get = (itemId) => items.get(itemId);
	assert.equal(pickFinalAnswerText(get, ["reason", "empty", "answer"]), "hello");
	assert.equal(pickFinalAnswerText(get, ["reason", "empty"]), undefined);
	assert.equal(pickFinalAnswerText(get, []), undefined);
});

test("openSessionAsync refuses to start without a muse binary", async () => {
	const previous = process.env.PI_MUSE_BINARY;
	process.env.PI_MUSE_BINARY = "/nonexistent/muse-binary";
	try {
		await assert.rejects(
			openSessionAsync({ key: "test-missing-binary", workspaceRoot: process.cwd(), modelId: "muse-spark", sandboxed: false }),
			(error) => error instanceof Error,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_MUSE_BINARY;
		else process.env.PI_MUSE_BINARY = previous;
	}
});
