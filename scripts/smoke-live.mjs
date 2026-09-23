// Live smoke check against the real Meta provider: one folded turn, one
// follow-up on the same session, one aborted turn, one turn after the abort.
// It spends real provider tokens, so it is not part of `node --test`:
//
//   node scripts/smoke-live.mjs
//
import { closeHostAsync, openSessionAsync } from "../src/host.ts";
import { resolveMuseModelId } from "../src/catalog.ts";
import { runMuseTurn } from "../src/runtime.ts";

const entry = await openSessionAsync({
	key: `smoke-${process.pid}`,
	workspaceRoot: process.cwd(),
	modelId: resolveMuseModelId("muse-spark"),
	sandboxed: false,
});
console.log("session:", entry.session.sessionId, "needsFold:", entry.needsFold);

const first = await runMuseTurn({
	entry,
	prompt: "Reply with exactly: OK",
	displayText: "Reply with exactly: OK",
	thinkingLevel: "off",
	onTextDelta: (delta) => process.stdout.write(delta),
});
console.log("\n--- turn1 ---");
console.log("text:", JSON.stringify(first.text));
console.log("usage:", JSON.stringify(first.usage));
console.log("diagnostics:", JSON.stringify(first.diagnostics));

// Second turn on the same live session: no fold, just the newest message.
const second = await runMuseTurn({ entry, prompt: "Reply with exactly: TWO", displayText: "Reply with exactly: TWO", thinkingLevel: "off" });
console.log("--- turn2 ---");
console.log("text:", JSON.stringify(second.text), "folded:", second.folded);

// Abort path: a real turn, interrupted while it runs.
const controller = new AbortController();
setTimeout(() => controller.abort(), 2000);
try {
	const slow = await runMuseTurn({
		entry,
		prompt: "Count slowly from 1 to 100, one number per line.",
		displayText: "count",
		thinkingLevel: "off",
		signal: controller.signal,
	});
	console.log("--- turn3 (should have aborted) ---");
	console.log("text:", JSON.stringify(slow.text));
} catch (error) {
	console.log("--- turn3 aborted as expected:", error.message);
}

await new Promise((resolve) => setTimeout(resolve, 3000));
const after = await runMuseTurn({ entry, prompt: "Reply with exactly: AFTER", displayText: "Reply with exactly: AFTER", thinkingLevel: "off" });
console.log("--- turn4 after abort ---");
console.log("text:", JSON.stringify(after.text));

await closeHostAsync();
console.log("host closed");
process.exit(0);
