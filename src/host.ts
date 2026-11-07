// One `muse serve` host per Pi process. File-backed Pi sessions keep one MSP
// session per Pi session file (resumed across restarts through markers).
// Ephemeral sessions (workflow children) have no file, so each distinct
// transcript gets its own MSP session instead: concurrent turns on one
// session hang, and a shared "ephemeral" key would funnel every child into
// the same stale session. The host stays alive, so a turn is a `turn/start`
// command on an open session rather than a fresh process and a cold handshake.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MuseClient,
	MuseHostDiedError,
	type Connection,
	type Session,
	readSessionDurability,
	spawnMspConnection,
} from "@muse-code/sdk";

const CLIENT_NAME = "pi_muse_code";
const CLIENT_VERSION = "1.0.0";

export type MuseApprovalMode = "allowAll" | "onRequest";

export function isSandboxed(flagValue: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	return flagValue === true || /^(1|true|yes)$/i.test(env.PI_MUSE_SANDBOXED?.trim() ?? "");
}

/**
 * Sandbox posture is fixed for the host's lifetime (`muse serve --help`), so
 * it is picked once, at spawn. Approval mode is per-session and goes on the
 * wire in `openSessionAsync`.
 */
export function getMuseServeArgs(sandboxed: boolean): string[] {
	// Trust + no sandbox + no approvals, spelled separately: serve has no
	// `--yolo` flag.
	const args = ["serve", "--trust-workspace"];
	if (!sandboxed) args.push("--disable-sandbox");
	return args;
}

export function getMuseApprovalMode(sandboxed: boolean): MuseApprovalMode {
	return sandboxed ? "onRequest" : "allowAll";
}

export interface MuseSessionEntry {
	session: Session;
	/** Fold the whole Pi conversation on this turn: there is nothing to resume yet. */
	needsFold: boolean;
	modelId: string;
	/** Approval/submit failures worth surfacing on the next turn's result. */
	diagnostics: string[];
	/** Turns currently executing on this entry. */
	inflight: number;
	/** Serializes turns on one entry: concurrent same-session turns hang the host. */
	turnQueue: Promise<void>;
	/** Transcript fingerprint at the last routed turn (ephemeral entries only). */
	transcriptHashes: string[];
	/** Last route time, for LRU eviction (ephemeral entries only). */
	lastUsed: number;
}

function newEntry(session: Session, modelId: string, needsFold: boolean): MuseSessionEntry {
	return { session, needsFold, modelId, diagnostics: [], inflight: 0, turnQueue: Promise.resolve(), transcriptHashes: [], lastUsed: 0 };
}

interface MuseHost {
	client: MuseClient;
	connection: Connection;
}

let host: MuseHost | undefined;
let hostPromise: Promise<MuseHost> | undefined;
const sessions = new Map<string, MuseSessionEntry>();
/** Ephemeral (file-less) entries, routed by transcript instead of a shared key. */
const ephemeralSessions: MuseSessionEntry[] = [];
const MAX_EPHEMERAL_SESSIONS = 16;

/** `MuseClient.spawn` with the connection kept: `turn/interrupt` is not on the facade. */
async function spawnHostAsync(sandboxed: boolean): Promise<MuseHost> {
	const handshake = spawnMspConnection({
		command: process.env.PI_MUSE_BINARY?.trim() || "muse",
		args: getMuseServeArgs(sandboxed),
		cwd: process.cwd(),
	});
	let spawned;
	try {
		spawned = await handshake.initialize({
			clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
		});
	} catch (error) {
		// A failed handshake must not leak the process it already spawned.
		await handshake.close().catch(() => undefined);
		throw error;
	}
	return {
		connection: spawned.connection,
		client: new MuseClient(spawned.connection, {
			durability: readSessionDurability(spawned.initializeResult),
			host: spawned,
		}),
	};
}

export async function ensureHostAsync(sandboxed: boolean): Promise<MuseClient> {
	if (host) return host.client;
	hostPromise ??= spawnHostAsync(sandboxed).then(
		(spawned) => {
			host = spawned;
			return spawned;
		},
		(error) => {
			hostPromise = undefined;
			throw error;
		},
	);
	return (await hostPromise).client;
}

export async function closeHostAsync(): Promise<void> {
	const pending = hostPromise;
	host = undefined;
	hostPromise = undefined;
	sessions.clear();
	ephemeralSessions.length = 0;
	if (!pending) return;
	try {
		await (await pending).client.close();
	} catch {
		// Shutdown is best-effort: Pi is going away either way.
	}
}

/**
 * Drops one file-backed entry without touching the host. Safe while other
 * sessions are mid-turn: in-flight turns hold their own entry reference, and
 * only the host close can orphan them.
 */
export function releaseSessionFile(key: string): void {
	sessions.delete(key);
}

/**
 * A dead host cannot serve another turn, so the next one respawns it and
 * reopens the session. Durable muse sessions resume; the fold covers the rest.
 */
export function forgetDeadHost(error: unknown): boolean {
	if (!(error instanceof MuseHostDiedError)) return false;
	host = undefined;
	hostPromise = undefined;
	sessions.clear();
	return true;
}

/** Stops the muse turn itself, so an aborted Pi turn is not still editing files. */
export async function interruptMuseTurnAsync(entry: MuseSessionEntry, turnId: string): Promise<void> {
	const spawned = host;
	if (!spawned) return;
	await spawned.connection.command("turn/interrupt", {
		sessionId: entry.session.sessionId,
		turnId,
	});
}

function sessionMarkerPath(key: string): string {
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return path.join(os.homedir(), ".pi", "agent", "muse-code-sessions", digest);
}

function readSessionMarker(key: string): string | undefined {
	try {
		return fs.readFileSync(sessionMarkerPath(key), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function writeSessionMarker(key: string, sessionId: string): void {
	const file = sessionMarkerPath(key);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, sessionId, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Losing the marker only costs one extra fold after a Pi restart.
	}
}

export interface OpenSessionOptions {
	/** Pi session file path, or a process-lifetime key when the session is ephemeral. */
	key: string;
	workspaceRoot: string;
	modelId: string;
	sandboxed: boolean;
}

/**
 * A model switch keeps the session: `session/setModel` is durable and lands at
 * the next model-call boundary.
 */
async function switchSessionModelAsync(entry: MuseSessionEntry, modelId: string): Promise<boolean> {
	const spawned = host;
	if (!spawned) return false;
	try {
		await spawned.connection.command("session/setModel", {
			sessionId: entry.session.sessionId,
			model: { modelId },
		});
		entry.modelId = modelId;
		return true;
	} catch {
		// A host that will not take the selection (unknown id, older surface) is
		// better served by a fresh session with the conversation folded in.
		return false;
	}
}

/**
 * The session for this Pi conversation, resumed when a marker from an earlier
 * Pi process points at a muse session this host still has.
 */
export async function openSessionAsync(options: OpenSessionOptions): Promise<MuseSessionEntry> {
	const cached = sessions.get(options.key);
	if (cached) {
		if (cached.modelId === options.modelId || (await switchSessionModelAsync(cached, options.modelId))) return cached;
		sessions.delete(options.key);
	}

	const client = await ensureHostAsync(options.sandboxed);
	const marker = readSessionMarker(options.key);
	if (marker) {
		try {
			const entry = newEntry(await client.resumeSession({ sessionId: marker }), options.modelId, false);
			// A resumed session keeps the model it was last on.
			if (await switchSessionModelAsync(entry, options.modelId)) {
				sessions.set(options.key, entry);
				return entry;
			}
		} catch {
			// Stale marker: a pruned session log, or `sessionInUse` because another
			// live host still holds it. Start fresh instead of failing the turn.
		}
	}

	const entry = newEntry(
		await client.startSession({
			workspaceRoot: options.workspaceRoot,
			modelId: options.modelId,
			approvalMode: getMuseApprovalMode(options.sandboxed),
		}),
		options.modelId,
		true,
	);
	writeSessionMarker(options.key, entry.session.sessionId);
	sessions.set(options.key, entry);
	return entry;
}

/** Stable per-message hash: key order must not change the fingerprint. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

export function fingerprintTranscript(messages: readonly unknown[]): string[] {
	return messages.map((message) => createHash("sha256").update(stableStringify(message), "utf8").digest("hex").slice(0, 16));
}

/** A session rejoins when its last transcript is a prefix of this turn's. */
export function isTranscriptPrefix(known: readonly string[], current: readonly string[]): boolean {
	if (known.length > current.length) return false;
	return known.every((hash, index) => hash === current[index]);
}

export interface EphemeralCandidate {
	transcriptHashes: readonly string[];
	inflight: number;
	lastUsed: number;
}

/**
 * Index of the entry this turn belongs to: the longest idle prefix match,
 * newest on ties. -1 opens a fresh session: no prefix matched, or every
 * match is busy. Busy matches open fresh rather than queue: concurrent
 * same-session turns hang the host, so sharing is never worth the wait.
 */
export function selectEphemeralEntry(candidates: readonly EphemeralCandidate[], hashes: readonly string[]): number {
	let best = -1;
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (candidate.inflight > 0) continue;
		if (!isTranscriptPrefix(candidate.transcriptHashes, hashes)) continue;
		if (best === -1) {
			best = index;
			continue;
		}
		const current = candidates[best];
		if (
			candidate.transcriptHashes.length > current.transcriptHashes.length ||
			(candidate.transcriptHashes.length === current.transcriptHashes.length && candidate.lastUsed > current.lastUsed)
		) {
			best = index;
		}
	}
	return best;
}

function evictEphemeralSessions(): void {
	while (ephemeralSessions.length > MAX_EPHEMERAL_SESSIONS) {
		let victim = -1;
		for (let index = 0; index < ephemeralSessions.length; index++) {
			const entry = ephemeralSessions[index];
			if (entry.inflight > 0) continue;
			if (victim === -1 || entry.lastUsed < ephemeralSessions[victim].lastUsed) victim = index;
		}
		if (victim === -1) return;
		ephemeralSessions.splice(victim, 1);
	}
}

export interface OpenEphemeralSessionOptions {
	/** This turn's Pi transcript: the only identity an ephemeral turn carries. */
	messages: readonly unknown[];
	workspaceRoot: string;
	modelId: string;
	sandboxed: boolean;
}

/**
 * The session for a file-less turn. Same transcript lineage rejoins its
 * session (multi-turn memory survives); a foreign or busy lineage opens a
 * fresh one. No markers: a shared marker file would funnel every ephemeral
 * session back into one stale muse session.
 */
export async function openEphemeralSessionAsync(options: OpenEphemeralSessionOptions): Promise<MuseSessionEntry> {
	const hashes = fingerprintTranscript(options.messages);
	const now = Date.now();
	const found = selectEphemeralEntry(ephemeralSessions, hashes);
	if (found !== -1) {
		const entry = ephemeralSessions[found];
		entry.transcriptHashes = hashes;
		entry.lastUsed = now;
		if (entry.modelId === options.modelId || (await switchSessionModelAsync(entry, options.modelId))) return entry;
		ephemeralSessions.splice(found, 1);
	}
	const client = await ensureHostAsync(options.sandboxed);
	const entry = newEntry(
		await client.startSession({
			workspaceRoot: options.workspaceRoot,
			modelId: options.modelId,
			approvalMode: getMuseApprovalMode(options.sandboxed),
		}),
		options.modelId,
		true,
	);
	entry.transcriptHashes = hashes;
	entry.lastUsed = now;
	ephemeralSessions.push(entry);
	evictEphemeralSessions();
	return entry;
}

/**
 * Holds this entry's turn slot until `release` runs. Throws when the turn is
 * already aborted, or aborts while queued, without consuming the slot.
 */
export async function acquireEntryTurn(entry: MuseSessionEntry, signal: AbortSignal | undefined): Promise<() => void> {
	const previous = entry.turnQueue;
	let release!: () => void;
	entry.turnQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	if (signal?.aborted) {
		release();
		throw new Error("Muse run was aborted");
	}
	if (!signal) {
		await previous;
		return release;
	}
	await new Promise<void>((resolve, reject) => {
		let aborted = false;
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			aborted = true;
			// Keep waiting: releasing early would let a later waiter run
			// concurrently with the holder ahead of us.
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void previous.then(() => {
			signal.removeEventListener("abort", onAbort);
			release();
			if (aborted) reject(new Error("Muse run was aborted"));
			else resolve();
		});
	});
	return release;
}
