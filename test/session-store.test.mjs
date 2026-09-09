import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getMuseSession } from "../src/session-store.mjs";

test("returns undefined for a missing pi session id", () => {
	assert.equal(getMuseSession(undefined), undefined);
});

test("creates a stable muse session id and reports seeded:false exactly once", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-session-store-"));
	const storePath = join(dir, "sessions.json");
	try {
		const first = getMuseSession("pi-session-a", storePath);
		assert.ok(first);
		assert.equal(first.seeded, false);

		const second = getMuseSession("pi-session-a", storePath);
		assert.equal(second.museSessionId, first.museSessionId);
		assert.equal(second.seeded, true);

		const third = getMuseSession("pi-session-a", storePath);
		assert.equal(third.seeded, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("different pi sessions get different muse session ids", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-session-store-"));
	const storePath = join(dir, "sessions.json");
	try {
		const a = getMuseSession("pi-session-a", storePath);
		const b = getMuseSession("pi-session-b", storePath);
		assert.notEqual(a.museSessionId, b.museSessionId);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
