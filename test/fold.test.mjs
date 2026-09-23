import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MESSAGE_CHARS, MAX_PRIOR_CHARS, MAX_PRIOR_TURNS, buildCatchUpPrompt, buildFirstTurnPrompt, capText, latestUserText } from "../src/fold.ts";

test("latestUserText returns the raw text of the last user message", () => {
	assert.equal(
		latestUserText([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
			{ role: "user", content: "second" },
		]),
		"second",
	);
});

test("latestUserText throws when there is no user message", () => {
	assert.throws(() => latestUserText([{ role: "assistant", content: [{ type: "text", text: "x" }] }]));
});

test("buildFirstTurnPrompt returns just the text when there is no prior history", () => {
	assert.equal(buildFirstTurnPrompt([{ role: "user", content: "hello" }]), "hello");
});

test("buildFirstTurnPrompt folds prior turns, including other models", () => {
	const prompt = buildFirstTurnPrompt([
		{ role: "user", content: "what is foo" },
		{
			role: "assistant",
			provider: "cursor",
			model: "grok-4.6",
			content: [{ type: "text", text: "foo is a placeholder" }],
		},
		{ role: "user", content: "continue that" },
	]);
	assert.match(prompt, /Assistant \(cursor\/grok-4\.6\):\nfoo is a placeholder/);
	assert.match(prompt, /Current request:\ncontinue that/);
});

test("buildFirstTurnPrompt truncates old turns to the configured bounds", () => {
	const messages = [];
	for (let i = 0; i < MAX_PRIOR_TURNS + 5; i++) {
		messages.push({ role: "user", content: `q${i}` });
		messages.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
	}
	messages.push({ role: "user", content: "final" });
	const prompt = buildFirstTurnPrompt(messages);
	assert.match(prompt, /Older turns truncated/);
	assert.doesNotMatch(prompt, /\nq0\n/);
});

test("buildFirstTurnPrompt caps a single oversized prior message instead of letting it crowd out the rest", () => {
	// A giant tool result (e.g. a workflow dump) sitting right before the
	// switch to muse must not eat the whole MAX_PRIOR_CHARS budget and
	// evict the actual conversation that led up to it.
	const hugeToolOutput = "x".repeat(MAX_PRIOR_CHARS * 2);
	const prompt = buildFirstTurnPrompt([
		{ role: "user", content: "explain nitro modules" },
		{ role: "assistant", content: [{ type: "text", text: "nitro modules use JSI directly" }] },
		{ role: "toolResult", toolName: "workflow", content: hugeToolOutput },
		{ role: "user", content: "now switch to muse" },
	]);
	assert.match(prompt, /message truncated/);
	assert.match(prompt, /nitro modules use JSI directly/);
	const toolLine = prompt.split("\n\n").find((line) => line.startsWith("Tool workflow:"));
	assert.ok(toolLine);
	assert.ok(toolLine.length < MAX_MESSAGE_CHARS + 200);
});

test("capText leaves short text alone and truncates long text in the middle", () => {
	assert.equal(capText("short"), "short");
	const long = "a".repeat(MAX_MESSAGE_CHARS + 500);
	const capped = capText(long);
	assert.ok(capped.length < long.length);
	assert.match(capped, /message truncated, 500 chars cut/);
});

test("buildCatchUpPrompt carries turns other models ran since muse last spoke", () => {
	const prompt = buildCatchUpPrompt([
		{ role: "user", content: "open the PR" },
		{ role: "assistant", provider: "muse-code", model: "muse-spark", content: [{ type: "text", text: "opened it" }] },
		{ role: "user", content: "now fix the flaky test" },
		{ role: "assistant", provider: "cursor", model: "grok-4.6", content: [{ type: "text", text: "I pinned the clock" }] },
		{ role: "user", content: "keep going with muse" },
	]);
	assert.ok(prompt);
	assert.match(prompt, /fix the flaky test/);
	assert.match(prompt, /Assistant \(cursor\/grok-4\.6\):\nI pinned the clock/);
	assert.doesNotMatch(prompt, /keep going with muse/, "the current request is the task, not catch-up");
	assert.doesNotMatch(prompt, /opened it/, "muse's own earlier reply is already in its session");
});

test("buildCatchUpPrompt is empty when muse answered last", () => {
	assert.equal(
		buildCatchUpPrompt([
			{ role: "user", content: "first" },
			{ role: "assistant", provider: "muse-code", model: "muse-spark", content: [{ type: "text", text: "answer" }] },
			{ role: "user", content: "second" },
		]),
		undefined,
	);
	assert.equal(buildCatchUpPrompt([{ role: "user", content: "only turn" }]), undefined);
});

test("buildCatchUpPrompt bounds what it forwards", () => {
	const messages = [];
	for (let index = 0; index < MAX_PRIOR_TURNS + 5; index += 1) {
		messages.push({ role: "assistant", provider: "cursor", model: "grok-4.6", content: [{ type: "text", text: `turn ${index}` }] });
	}
	messages.push({ role: "user", content: "go" });
	const prompt = buildCatchUpPrompt(messages);
	assert.ok(prompt);
	assert.doesNotMatch(prompt, /turn 0\n/);
	assert.match(prompt, new RegExp(`turn ${MAX_PRIOR_TURNS + 4}`));
	assert.ok(prompt.length < MAX_PRIOR_CHARS + 500);
});
