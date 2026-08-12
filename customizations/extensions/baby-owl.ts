import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const BLINK_MIN_MS = 3000;
const BLINK_MAX_MS = 8000;
const BLINK_DURATION_MS = 180;
const WORKING_HARD_THRESHOLD = 33;
const EXHAUSTED_THRESHOLD = 66;
const BURNED_OUT_THRESHOLD = 91.7;
const WIDGET_KEY = "baby-owl";

type OwlMode = "normal" | "thinking" | "working-hard" | "exhausted" | "burned-out";

export default function babyOwlExtension(pi: ExtensionAPI) {
	let enabled = true;
	let thinking = false;
	let panel: BabyOwlPanel | null = null;

	const syncOwl = (ctx: ExtensionContext) => {
		const percent = ctx.getContextUsage()?.percent ?? null;
		const mode: OwlMode =
			percent !== null && percent >= BURNED_OUT_THRESHOLD ? "burned-out"
			: percent !== null && percent >= EXHAUSTED_THRESHOLD ? "exhausted"
			: percent !== null && percent >= WORKING_HARD_THRESHOLD ? "working-hard"
			: thinking ? "thinking"
			: "normal";

		panel?.setMode(mode);
	};

	const hideOwl = (ctx: ExtensionContext) => {
		panel = null;
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	const showOwl = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) return;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			panel = new BabyOwlPanel(tui, theme);
			syncOwl(ctx);
			return panel;
		});
	};

	pi.on("session_start", (_event, ctx) => {
		thinking = false;
		hideOwl(ctx);
		showOwl(ctx);
		syncOwl(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		hideOwl(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		thinking = true;
		syncOwl(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		thinking = false;
		syncOwl(ctx);
	});

	pi.on("message_end", (_event, ctx) => {
		syncOwl(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		syncOwl(ctx);
	});

	pi.registerCommand("owl", {
		description: "Toggle the baby owl perched above the editor",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			enabled = !enabled;

			if (enabled) {
				showOwl(ctx);
				syncOwl(ctx);
				ctx.ui.notify("Baby owl companion enabled", "info");
			} else {
				hideOwl(ctx);
				ctx.ui.notify("Baby owl companion hidden", "info");
			}
		},
	});
}

class BabyOwlPanel {
	private blinkTimeout: ReturnType<typeof setTimeout> | null = null;
	private reopenTimeout: ReturnType<typeof setTimeout> | null = null;
	private blinking = false;
	private mode: OwlMode = "normal";

	constructor(
		private tui: { requestRender: () => void },
		private theme: Theme,
	) {
		this.scheduleBlink();
	}

	setMode(mode: OwlMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const sweaty = this.mode === "working-hard";
		const eyes = this.blinking ? this.blinkFaceForMode() : this.faceForMode();
		const owl = [
			th.fg("accent", sweaty ? "  ,_," : " ,_,"),
			th.fg("text", eyes),
			th.fg("muted", sweaty ? " (   )" : "(   )"),
			th.fg("dim", sweaty ? '  " "' : ' " "'),
		];

		return this.rightAlignBlock(owl, width);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.blinkTimeout) clearTimeout(this.blinkTimeout);
		if (this.reopenTimeout) clearTimeout(this.reopenTimeout);
	}

	private faceForMode(): string {
		switch (this.mode) {
			case "thinking":
				return "(¬,¬)";
			case "working-hard":
				return "'(•,•)";
			case "exhausted":
				return "(._.)";
			case "burned-out":
				return "(x,x)";
			default:
				return "(•,•)";
		}
	}

	private blinkFaceForMode(): string {
		return this.mode === "working-hard" ? "'(-,-)" : "(-,-)";
	}


	private scheduleBlink(): void {
		const delay = randomInt(BLINK_MIN_MS, BLINK_MAX_MS);
		this.blinkTimeout = setTimeout(() => {
			this.blinking = true;
			this.tui.requestRender();
			this.reopenTimeout = setTimeout(() => {
				this.blinking = false;
				this.tui.requestRender();
				this.scheduleBlink();
			}, BLINK_DURATION_MS);
		}, delay);
	}

	private rightAlignBlock(lines: string[], width: number): string[] {
		const rightGutter = 2;
		const blockWidth = Math.max(...lines.map((line) => stripAnsi(line).length));
		const leftPad = Math.max(0, width - blockWidth - rightGutter);

		return lines.map((line) => {
			const clean = stripAnsi(line);
			const rightPad = Math.max(0, width - leftPad - clean.length);
			return " ".repeat(leftPad) + line + " ".repeat(rightPad);
		});
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function randomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}
