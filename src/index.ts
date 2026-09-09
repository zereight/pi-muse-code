import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldMuseContext } from "./fold.mjs";
import { getMuseSession } from "./session-store.mjs";

// Skipping the full fold on an already-seeded turn only pays off if the
// active pi-muse-bridge build reads the `pi-muse-session-id` marker and
// resumes that muse session with `muse exec --session-id`. Stock
// pi-muse-bridge 0.3.0 does not, so trust `seeded` only once the bridge
// patch is confirmed in place (set this once that lands upstream).
const TRUST_BRIDGE_RESUME = process.env.PI_MUSE_BRIDGE_RESUMES_SESSION === "1";

export default function museCodeContextFold(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		if (ctx.model?.provider !== "muse-code") return;
		const piSessionId = ctx.sessionManager?.getSessionId?.();
		// Undefined when sessionManager can't report an id (e.g. ephemeral run).
		// foldMuseContext then falls back to folding every turn, same as before
		// this session-id support existed.
		const session = piSessionId ? getMuseSession(piSessionId) : undefined;
		const options = session
			? { museSessionId: session.museSessionId, seeded: TRUST_BRIDGE_RESUME ? session.seeded : false }
			: undefined;
		const messages = foldMuseContext(event.messages, options);
		if (messages) return { messages };
	});
}
