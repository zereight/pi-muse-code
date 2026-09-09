import assert from "node:assert/strict";
import test from "node:test";
import { createMuseSessionTracker } from "../src/session.ts";

test("first call reports isFirstTurn:true, later calls false, same sessionId throughout", () => {
	let n = 0;
	const nextTurn = createMuseSessionTracker(() => `uuid-${++n}`);

	const first = nextTurn();
	assert.equal(first.isFirstTurn, true);
	assert.equal(first.sessionId, "uuid-1");

	const second = nextTurn();
	assert.equal(second.isFirstTurn, false);
	assert.equal(second.sessionId, "uuid-1");

	const third = nextTurn();
	assert.equal(third.isFirstTurn, false);
	assert.equal(third.sessionId, "uuid-1");
});

test("separate trackers get separate session ids", () => {
	const trackerA = createMuseSessionTracker();
	const trackerB = createMuseSessionTracker();
	assert.notEqual(trackerA().sessionId, trackerB().sessionId);
});
