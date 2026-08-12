import {
	CustomEditor,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

const COMMAND = "assistant-history";
const WIDGET_KEY = "assistant-history";

type Direction = "next" | "previous";

type HistoryItem = {
	entryId: string;
	assistantText: string;
	userText: string;
};

type HistoryState = {
	items: HistoryItem[];
	originLeafId: string;
	index: number;
};

export default function assistantHistoryExtension(pi: ExtensionAPI) {
	let history: HistoryState | undefined;
	let navigating = false;
	let viewerOpen = false;

	const clearHistory = (ctx: ExtensionContext) => {
		history = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	const showUserBanner = (ctx: ExtensionContext, text: string) => {
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new UserBanner(text, theme));
	};

	const ensureHistory = (ctx: ExtensionCommandContext): HistoryState | undefined => {
		if (history) {
			const expectedLeafId =
				history.index === history.items.length
					? history.originLeafId
					: history.items[history.index]?.entryId;
			if (ctx.sessionManager.getLeafId() === expectedLeafId) return history;
			clearHistory(ctx);
		}

		const originLeafId = ctx.sessionManager.getLeafId();
		if (!originLeafId) return undefined;

		let userText = "";
		const items: HistoryItem[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;

			if (entry.message.role === "user") {
				userText = messageText(entry.message.content);
				continue;
			}

			if (entry.message.role !== "assistant") continue;
			const assistantText = entry.message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n\n")
				.trim();
			if (!assistantText) continue;

			items.push({ entryId: entry.id, assistantText, userText });
		}

		history = { items, originLeafId, index: items.length };
		return history;
	};

	const navigate = async (
		direction: Direction,
		ctx: ExtensionCommandContext,
	): Promise<"live" | HistoryItem | undefined> => {
		const state = ensureHistory(ctx);
		if (!state || state.items.length === 0) {
			ctx.ui.notify("No assistant output in this session", "warning");
			return;
		}

		const nextIndex = state.index + (direction === "previous" ? -1 : 1);
		if (nextIndex < 0) {
			ctx.ui.notify("Already at the first assistant output", "info");
			return;
		}
		if (nextIndex > state.items.length) {
			ctx.ui.notify("Already at the current session tip", "info");
			return;
		}

		const targetId =
			nextIndex === state.items.length ? state.originLeafId : state.items[nextIndex]!.entryId;
		navigating = true;
		try {
			const result = await ctx.navigateTree(targetId, { summarize: false });
			if (result.cancelled) return;
		} finally {
			navigating = false;
		}

		state.index = nextIndex;
		if (nextIndex === state.items.length) {
			clearHistory(ctx);
			return "live";
		}

		const item = state.items[nextIndex]!;
		showUserBanner(ctx, item.userText);
		return item;
	};

	const openViewer = async (direction: Direction, ctx: ExtensionCommandContext) => {
		if (viewerOpen) return;
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the assistant to finish before navigating history", "warning");
			return;
		}

		const item = await navigate(direction, ctx);
		if (!item || item === "live" || !history) return;

		viewerOpen = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new AssistantHistoryViewer(
						tui,
						theme,
						history!,
						async (nextDirection) => {
							const nextItem = await navigate(nextDirection, ctx);
							if (nextItem === "live") {
								done();
								return false;
							}
							return nextItem !== undefined;
						},
						done,
					),
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-left",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
				},
			);
		} finally {
			viewerOpen = false;
		}
	};
	pi.registerCommand(COMMAND, {
		description: "Navigate assistant output history",
		handler: async (args, ctx) => {
			const direction = args.trim();
			if (direction !== "previous" && direction !== "next") {
				ctx.ui.notify(`Usage: /${COMMAND} previous|next`, "warning");
				return;
			}
			await openViewer(direction, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearHistory(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new AssistantHistoryEditor(tui, theme, keybindings),
		);
	});
	pi.on("session_shutdown", (_event, ctx) => clearHistory(ctx));
	pi.on("session_tree", (_event, ctx) => {
		if (!navigating) clearHistory(ctx);
	});
	pi.on("input", (event, ctx) => {
		if (event.source === "interactive") clearHistory(ctx);
		return { action: "continue" };
	});
	pi.on("model_select", (_event, ctx) => clearHistory(ctx));
	pi.on("thinking_level_select", (_event, ctx) => clearHistory(ctx));
}

class AssistantHistoryEditor extends CustomEditor {
	override handleInput(data: string): void {
		if (matchesKey(data, Key.alt("v"))) {
			this.onSubmit?.(`/${COMMAND} previous`);
			return;
		}
		if (matchesKey(data, Key.ctrl("v"))) {
			this.onSubmit?.(`/${COMMAND} next`);
			return;
		}
		super.handleInput(data);
	}
}

class AssistantHistoryViewer implements Component {
	private scrollOffset = 0;
	private moving = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private history: HistoryState,
		private navigate: (direction: Direction) => Promise<boolean>,
		private done: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.alt("v"))) {
			this.move("previous");
			return;
		}
		if (matchesKey(data, Key.ctrl("v"))) {
			this.move("next");
			return;
		}

		const pageSize = Math.max(1, this.tui.terminal.rows - 6);
		if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, Key.down)) this.scrollOffset++;
		else if (matchesKey(data, Key.pageUp)) this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) this.scrollOffset += pageSize;
		else if (matchesKey(data, Key.home)) this.scrollOffset = 0;
		else return;

		this.tui.requestRender();
	}

	render(width: number): string[] {
		const item = this.history.items[this.history.index]!;
		const renderWidth = Math.max(1, width);
		const body = new Markdown(item.assistantText, 1, 0, getMarkdownTheme()).render(renderWidth);
		const help = this.theme.fg(
			"dim",
			truncateToWidth(" opt-v/ctrl-v navigate · ↑/↓/pgup/pgdn scroll · esc close", renderWidth, ""),
		);
		const bodyBudget = Math.max(1, this.tui.terminal.rows - 2);
		const maxOffset = Math.max(0, body.length - bodyBudget);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + bodyBudget);

		return [...visibleBody, "", help];
	}

	invalidate(): void {}

	private move(direction: Direction): void {
		if (this.moving) return;
		this.moving = true;
		void this.navigate(direction).finally(() => {
			this.moving = false;
			this.scrollOffset = 0;
			this.tui.requestRender();
		});
	}
}

class UserBanner implements Component {
	constructor(
		private text: string,
		private theme: Theme,
	) {}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const wrappedLines = wrapTextWithAnsi(this.text || " ", Math.max(1, renderWidth - 1));
		const visibleLines = wrappedLines.slice(0, 3);
		if (wrappedLines.length > 3) {
			visibleLines[2] = truncateToWidth(`${visibleLines[2]} …`, renderWidth - 1, "…");
		}

		return visibleLines.map((line) =>
			this.theme.bg(
				"userMessageBg",
				this.theme.fg("userMessageText", truncateToWidth(` ${line}`, renderWidth, "…")),
			),
		);
	}

	invalidate(): void {}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"),
		)
		.map((part) => part.text)
		.join("\n");
}
