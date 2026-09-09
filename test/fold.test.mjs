import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PRIOR_CHARS, MAX_PRIOR_TURNS, PRIOR_MARKER, foldMuseContext } from "../src/fold.mjs";

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
	const veryLong = `x`.repeat(MAX_PRIOR_CHARS + 100);
	const out2 = foldMuseContext([
		{ role: "user", content: veryLong },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "user", content: "next" },
	]);
	assert.ok(out2);
	assert.match(out2[out2.length - 1].content, /Older turns truncated/);
});
