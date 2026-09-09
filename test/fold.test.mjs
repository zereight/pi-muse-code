import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_MESSAGE_CHARS,
	MAX_PRIOR_CHARS,
	MAX_PRIOR_TURNS,
	PRIOR_MARKER,
	SESSION_MARKER_PREFIX,
	foldMuseContext,
} from "../src/fold.mjs";

test("first user turn is left alone", () => {
	assert.equal(foldMuseContext([{ role: "user", content: "hello" }]), undefined);
});

test("folds grok history into the latest user turn", () => {
	const out = foldMuseContext([
		{ role: "user", content: "what is foo" },
		{
			role: "assistant",
			provider: "cursor",
			model: "grok-4.6",
			content: [{ type: "text", text: "foo is a placeholder" }],
		},
		{ role: "user", content: "continue that" },
	]);
	assert.ok(out);
	assert.equal(out.length, 3);
	assert.match(out[2].content, new RegExp(PRIOR_MARKER));
	assert.match(out[2].content, /Assistant \(cursor\/grok-4\.6\):\nfoo is a placeholder/);
	assert.match(out[2].content, /Current request:\ncontinue that/);
	assert.equal(out[0].content, "what is foo");
});

test("does not wrap twice", () => {
	const once = foldMuseContext([
		{ role: "user", content: "a" },
		{ role: "assistant", content: [{ type: "text", text: "b" }] },
		{ role: "user", content: "c" },
	]);
	assert.equal(foldMuseContext(once), undefined);
});

test("truncates old turns to the configured bounds", () => {
	const messages = [];
	for (let i = 0; i < MAX_PRIOR_TURNS + 5; i++) {
		messages.push({ role: "user", content: `q${i}` });
		messages.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
	}
	messages.push({ role: "user", content: "final" });
	const out = foldMuseContext(messages);
	assert.ok(out);
	const folded = out[out.length - 1].content;
	assert.match(folded, /Older turns truncated/);
	assert.doesNotMatch(folded, /\nq0\n/);
});

test("caps a single oversized prior message instead of letting it crowd out the rest", () => {
	// A giant tool result (e.g. a workflow dump) sitting right before the
	// switch to muse must not eat the whole MAX_PRIOR_CHARS budget and
	// evict the actual conversation that led up to it.
	const hugeToolOutput = "x".repeat(MAX_PRIOR_CHARS * 2);
	const out = foldMuseContext([
		{ role: "user", content: "explain nitro modules" },
		{ role: "assistant", content: [{ type: "text", text: "nitro modules use JSI directly" }] },
		{ role: "toolResult", toolName: "workflow", content: hugeToolOutput },
		{ role: "user", content: "now switch to muse" },
	]);
	assert.ok(out);
	const folded = out[out.length - 1].content;
	assert.match(folded, /message truncated/);
	// The actual conversation survives the cap, not just the raw tool dump.
	assert.match(folded, /nitro modules use JSI directly/);
	const toolLine = folded.split("\n\n").find((line) => line.startsWith("Tool workflow:"));
	assert.ok(toolLine);
	assert.ok(toolLine.length < MAX_MESSAGE_CHARS + 200);
});

test("skips the full fold and only attaches the session marker once seeded", () => {
	const messages = [
		{ role: "user", content: "earlier turn" },
		{ role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
		{ role: "user", content: "resumed turn" },
	];
	const out = foldMuseContext(messages, { museSessionId: "test-uuid", seeded: true });
	assert.ok(out);
	const folded = out[out.length - 1].content;
	assert.match(folded, new RegExp(`${SESSION_MARKER_PREFIX}test-uuid`));
	assert.doesNotMatch(folded, new RegExp(PRIOR_MARKER));
	assert.match(folded, /resumed turn$/);
});

test("folds full history and attaches the session marker on the first (unseeded) turn", () => {
	const out = foldMuseContext(
		[
			{ role: "user", content: "earlier turn" },
			{ role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
			{ role: "user", content: "switch to muse" },
		],
		{ museSessionId: "test-uuid", seeded: false },
	);
	assert.ok(out);
	const folded = out[out.length - 1].content;
	assert.match(folded, new RegExp(`${SESSION_MARKER_PREFIX}test-uuid`));
	assert.match(folded, new RegExp(PRIOR_MARKER));
	assert.match(folded, /earlier answer/);
});
