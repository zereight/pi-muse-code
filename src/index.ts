import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMuseProvider } from "./provider.ts";

export default function museCode(pi: ExtensionAPI): void {
	registerMuseProvider(pi);
}
