import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ponytail: a flat JSON file is enough here. Usage is one read+write per
// Pi context call, single local user, no real concurrency to design for.
const STORE_DIR = join(homedir(), ".local", "state", "pi-muse-code-context-fold");
const STORE_PATH = join(STORE_DIR, "sessions.json");

export function storePathForTest() {
	return STORE_PATH;
}

function readStore(storePath) {
	try {
		return JSON.parse(readFileSync(storePath, "utf8"));
	} catch {
		return {};
	}
}

function writeStore(storePath, store) {
	mkdirSync(dirname(storePath), { recursive: true });
	const tmp = `${storePath}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(store), "utf8");
	renameSync(tmp, storePath);
}

/**
 * Map a Pi session id to a stable muse `--session-id`, creating it on
 * first use. Reports `seeded: false` exactly once per Pi session, on the
 * call that first learns about it, so the caller knows to run the
 * one-time full-history fold on that turn only.
 */
export function getMuseSession(piSessionId, storePath = STORE_PATH) {
	if (!piSessionId) return undefined;
	const store = readStore(storePath);
	const existing = store[piSessionId];
	if (existing?.museSessionId) {
		if (existing.seeded) return { museSessionId: existing.museSessionId, seeded: true };
		store[piSessionId] = { ...existing, seeded: true };
		writeStore(storePath, store);
		return { museSessionId: existing.museSessionId, seeded: false };
	}
	const museSessionId = randomUUID();
	store[piSessionId] = { museSessionId, seeded: true };
	writeStore(storePath, store);
	return { museSessionId, seeded: false };
}
