// One `muse serve` host per Pi process, plus one MSP session per Pi session
// file. Through 0.3.x every turn spawned `muse exec`; MSP (`@muse-code/sdk`)
// keeps the host alive instead, so a turn is a `turn/start` command on an open
// session rather than a fresh process and a cold handshake.
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

const CLIENT_NAME = "pi_muse_code_context_fold";
const CLIENT_VERSION = "0.4.0";

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
	// `muse exec --yolo` was trust + no sandbox + no approvals; serve has no
	// `--yolo`, so the three parts are spelled separately.
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
}

interface MuseHost {
	client: MuseClient;
	connection: Connection;
}

let host: MuseHost | undefined;
let hostPromise: Promise<MuseHost> | undefined;
const sessions = new Map<string, MuseSessionEntry>();

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
	if (!pending) return;
	try {
		await (await pending).client.close();
	} catch {
		// Shutdown is best-effort: Pi is going away either way.
	}
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
 * The session for this Pi conversation, resumed when a marker from an earlier
 * Pi process points at a muse session this host still has.
 */
export async function openSessionAsync(options: OpenSessionOptions): Promise<MuseSessionEntry> {
	const cached = sessions.get(options.key);
	if (cached && cached.modelId === options.modelId) return cached;
	// A different model id cannot be applied to a live session through the
	// facade (no `session/setModel`), so it starts a new one. The fold carries
	// the Pi conversation across, so context is re-sent rather than lost.
	if (cached) sessions.delete(options.key);

	const client = await ensureHostAsync(options.sandboxed);
	const marker = readSessionMarker(options.key);
	if (marker) {
		try {
			const entry: MuseSessionEntry = {
				session: await client.resumeSession({ sessionId: marker }),
				needsFold: false,
				modelId: options.modelId,
				diagnostics: [],
			};
			sessions.set(options.key, entry);
			return entry;
		} catch {
			// Stale marker: a pruned session log, or `sessionInUse` because another
			// live host still holds it. Start fresh instead of failing the turn.
		}
	}

	const entry: MuseSessionEntry = {
		session: await client.startSession({
			workspaceRoot: options.workspaceRoot,
			modelId: options.modelId,
			approvalMode: getMuseApprovalMode(options.sandboxed),
		}),
		needsFold: true,
		modelId: options.modelId,
		diagnostics: [],
	};
	writeSessionMarker(options.key, entry.session.sessionId);
	sessions.set(options.key, entry);
	return entry;
}
