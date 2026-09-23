// Protocol-level check against a real `muse serve` host. Uses the `echo`
// provider, so it costs nothing and never touches the network — it only needs
// the `muse` binary, and skips when that is missing.
//
// It leaves session records behind in Muse's own session log directory:
// resume needs a durable session, which is the path worth guarding.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { MuseClient, readSessionDurability, spawnMspConnection } from "@muse-code/sdk";

const hasMuse = spawnSync("muse", ["--version"], { stdio: "ignore" }).status === 0;

async function spawnHost() {
	const handshake = spawnMspConnection({ command: "muse", args: ["serve"], cwd: process.cwd() });
	const spawned = await handshake.initialize({ clientInfo: { name: "pi_muse_test", version: "0.0.0" } });
	return new MuseClient(spawned.connection, {
		durability: readSessionDurability(spawned.initializeResult),
		host: spawned,
	});
}

async function runTurn(session, text) {
	const turn = await session.sendUserTurn({ input: [{ type: "text", text }] });
	const fields = new Set();
	let streamed = "";
	const pump = (async () => {
		for await (const delta of turn.deltas()) {
			fields.add(delta.field ?? "text");
			streamed += delta.delta;
		}
	})();
	const outcome = await turn.completed;
	await pump;
	return { fields, streamed, outcome };
}

test("a served session streams an answer turn and resumes after a host restart", { skip: !hasMuse }, async () => {
	const first = await spawnHost();
	let sessionId;
	try {
		const session = await first.startSession({
			workspaceRoot: process.cwd(),
			modelId: "muse-spark",
			providerId: "echo",
			approvalMode: "allowAll",
		});
		const run = await runTurn(session, "hello muse");
		assert.equal(run.outcome.kind, "completed");
		assert.equal(run.outcome.params.terminal, "completed");
		assert.ok(run.streamed.length > 0, "expected streamed answer text");
		assert.deepEqual([...run.fields], ["text"], "answer text streams on the 'text' field");
		// A live host holds its sessions: resume only works once it is gone, which
		// is exactly the Pi-restart case this marker exists for.
		sessionId = session.sessionId;
	} finally {
		await first.close();
	}

	// The marker-based resume path: a new host must load the same session. Its
	// earlier items stay on the host rather than in the client fold — snapshot
	// ingestion is not in the SDK yet — so the check is that the session is
	// usable again, not that the old items reappear.
	const revived = await spawnHost();
	try {
		const resumed = await revived.resumeSession({ sessionId });
		const followUp = await runTurn(resumed, "second turn");
		assert.equal(followUp.outcome.kind, "completed");
		assert.ok(followUp.streamed.length > 0, "expected the resumed session to answer");
	} finally {
		await revived.close();
	}
});
