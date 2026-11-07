import assert from "node:assert/strict";
import test from "node:test";
import {
	fingerprintTranscript,
	isTranscriptPrefix,
	selectEphemeralEntry,
} from "../src/host.ts";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("transcript fingerprints are stable and message-sensitive", () => {
	const a = fingerprintTranscript([user("hello")]);
	const b = fingerprintTranscript([user("hello")]);
	const c = fingerprintTranscript([user("goodbye")]);
	assert.deepEqual(a, b);
	assert.notDeepEqual(a, c);
	assert.equal(a.length, 1);
	assert.match(a[0], /^[0-9a-f]{16}$/);
});

test("a grown transcript keeps its prefix, a foreign one does not", () => {
	const turn1 = fingerprintTranscript([user("task A")]);
	const turn2 = fingerprintTranscript([user("task A"), asst("done"), user("more")]);
	const other = fingerprintTranscript([user("task B")]);
	assert.equal(isTranscriptPrefix(turn1, turn2), true);
	assert.equal(isTranscriptPrefix(turn2, turn1), false);
	assert.equal(isTranscriptPrefix(turn1, turn1), true);
	assert.equal(isTranscriptPrefix(other, turn2), false);
	assert.equal(isTranscriptPrefix([], turn2), true);
});

test("routing rejoins the session whose transcript is a prefix", () => {
	const entries = [
		{ transcriptHashes: fingerprintTranscript([user("task A")]), inflight: 0, lastUsed: 10 },
		{ transcriptHashes: fingerprintTranscript([user("task B")]), inflight: 0, lastUsed: 20 },
	];
	const grown = fingerprintTranscript([user("task B"), asst("done"), user("more")]);
	assert.equal(selectEphemeralEntry(entries, grown), 1);
});

test("routing opens a fresh session when every match is busy", () => {
	const hashes = fingerprintTranscript([user("same task")]);
	const entries = [{ transcriptHashes: hashes, inflight: 1, lastUsed: 10 }];
	assert.equal(selectEphemeralEntry(entries, hashes), -1);
});

test("routing prefers the longest idle prefix, newest on ties", () => {
	const short = fingerprintTranscript([user("same task")]);
	const grown = fingerprintTranscript([user("same task"), asst("done"), user("more")]);
	const entries = [
		{ transcriptHashes: short, inflight: 0, lastUsed: 30 },
		{ transcriptHashes: grown, inflight: 0, lastUsed: 10 },
	];
	assert.equal(selectEphemeralEntry(entries, grown), 1);
	const tied = [
		{ transcriptHashes: short, inflight: 0, lastUsed: 10 },
		{ transcriptHashes: short, inflight: 0, lastUsed: 20 },
	];
	assert.equal(selectEphemeralEntry(entries, short), 0);
	assert.equal(selectEphemeralEntry(tied, short), 1);
});

test("routing finds nothing without entries or without a prefix", () => {
	assert.equal(selectEphemeralEntry([], fingerprintTranscript([user("x")])), -1);
	const entries = [{ transcriptHashes: fingerprintTranscript([user("task A")]), inflight: 0, lastUsed: 1 }];
	assert.equal(selectEphemeralEntry(entries, fingerprintTranscript([user("task B")])), -1);
});
