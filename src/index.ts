import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldMuseContext } from "./fold.mjs";

export default function museCodeContextFold(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		if (ctx.model?.provider !== "muse-code") return;
		const messages = foldMuseContext(event.messages);
		if (messages) return { messages };
	});
}
