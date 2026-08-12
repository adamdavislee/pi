import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type DisplayModeUI = ExtensionContext["ui"] & {
	getDisplayMode(): "quiet" | "verbose";
	setDisplayMode(mode: "quiet" | "verbose"): void;
};

export default function verboseMode(pi: ExtensionAPI) {
	pi.registerCommand("verbose", {
		description: "Toggle thinking and tool call display",
		handler: (_args, ctx) => {
			if (!("getDisplayMode" in ctx.ui) || !("setDisplayMode" in ctx.ui)) {
				ctx.ui.notify("Verbose mode requires Adam's Pi core patch", "error");
				return;
			}

			const ui = ctx.ui as DisplayModeUI;
			const mode = ui.getDisplayMode() === "verbose" ? "quiet" : "verbose";
			ui.setDisplayMode(mode);
			ui.notify(`Verbose mode ${mode === "verbose" ? "enabled" : "disabled"}`, "info");
		},
	});
}
