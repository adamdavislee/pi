import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

const MARKER_PATTERN = /\[inline feedback · \d+ headings?\]/;
const MARKER_PATTERN_GLOBAL = /\[inline feedback · \d+ headings?\]/g;

type HeadingSection = {
	level: number;
	raw: string;
	title: string;
	body: string;
};

type AssistantResponse = {
	entryId: string;
	completed: boolean;
	text: string;
};

export function parseHeadingSections(markdown: string): HeadingSection[] {
	const lines = markdown.split("\n");
	const headings: Array<Omit<HeadingSection, "body"> & { line: number }> = [];
	let fence: { character: "`" | "~"; length: number } | undefined;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

		if (fence) {
			if (
				fenceMatch &&
				fenceMatch[1]?.[0] === fence.character &&
				fenceMatch[1].length >= fence.length &&
				/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)
			) {
				fence = undefined;
			}
			continue;
		}

		if (fenceMatch) {
			const run = fenceMatch[1]!;
			fence = { character: run[0] as "`" | "~", length: run.length };
			continue;
		}

		const headingMatch = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
		if (!headingMatch) continue;

		const level = headingMatch[1]!.length;
		const title = (headingMatch[2] ?? "")
			.trim()
			.replace(/[ \t]+#+[ \t]*$/, "")
			.trimEnd();
		if (!title) continue;

		headings.push({
			level,
			raw: `${"#".repeat(level)} ${title}`,
			title,
			line: lineIndex,
		});
	}

	return headings.map((heading, headingIndex) => {
		const nextBoundary = headings
			.slice(headingIndex + 1)
			.find((candidate) => candidate.level <= heading.level);
		const bodyLines = lines.slice(heading.line + 1, nextBoundary?.line ?? lines.length);

		while (bodyLines[0]?.trim() === "") bodyLines.shift();
		while (bodyLines.at(-1)?.trim() === "") bodyLines.pop();

		return {
			level: heading.level,
			raw: heading.raw,
			title: heading.title,
			body: bodyLines.join("\n"),
		};
	});
}

export function serializeFeedback(headings: HeadingSection[], drafts: ReadonlyMap<number, string>): string {
	return [...drafts.entries()]
		.filter(([headingIndex, feedback]) => headings[headingIndex] && feedback.trim())
		.sort(([left], [right]) => left - right)
		.map(([headingIndex, feedback]) => `> ${headings[headingIndex]!.raw}\n\n${feedback.trim()}`)
		.join("\n\n");
}

export default function inlineFeedbackExtension(pi: ExtensionAPI) {
	let sourceEntryId: string | undefined;
	let headings: HeadingSection[] = [];
	let drafts = new Map<number, string>();
	let reviewOpen = false;

	const clearState = () => {
		sourceEntryId = undefined;
		headings = [];
		drafts = new Map();
	};

	const removeMarker = (text: string) =>
		MARKER_PATTERN.test(text) ? text.replace(MARKER_PATTERN_GLOBAL, "").trimEnd() : text;

	const syncMarker = (ctx: ExtensionContext) => {
		const currentText = ctx.ui.getEditorText();
		const count = drafts.size;

		if (count === 0) {
			const nextText = removeMarker(currentText);
			if (nextText !== currentText) ctx.ui.setEditorText(nextText);
			return;
		}

		const marker = `[inline feedback · ${count} ${count === 1 ? "heading" : "headings"}]`;
		const nextText = MARKER_PATTERN.test(currentText)
			? currentText.replace(MARKER_PATTERN, marker)
			: `${currentText}${currentText ? (currentText.endsWith("\n") ? "\n" : "\n\n") : ""}${marker}`;

		if (nextText !== currentText) ctx.ui.setEditorText(nextText);
	};

	const openReview = async (ctx: ExtensionContext) => {
		if (reviewOpen || ctx.mode !== "tui") return;
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the assistant response to finish before reviewing it", "warning");
			return;
		}

		const response = latestAssistantResponse(ctx);
		if (!response) {
			ctx.ui.notify("No assistant response to review", "warning");
			return;
		}
		if (!response.completed) {
			ctx.ui.notify("The latest assistant output is not a completed response", "warning");
			return;
		}

		if (sourceEntryId !== response.entryId) {
			clearState();
			sourceEntryId = response.entryId;
			headings = parseHeadingSections(response.text);
		}

		if (headings.length === 0) {
			syncMarker(ctx);
			ctx.ui.notify("The latest assistant response has no Markdown headings", "warning");
			return;
		}

		reviewOpen = true;
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				new ReviewComponent(tui, theme, headings, drafts, headings.length - 1, done),
			);
		} finally {
			reviewOpen = false;
			syncMarker(ctx);
		}
	};

	pi.registerShortcut("alt+left", {
		description: "Review the previous Markdown heading in the latest assistant response",
		handler: openReview,
	});

	pi.registerShortcut("alt+right", {
		description: "Return from inline-feedback heading navigation",
		handler: () => {},
	});

	pi.registerCommand("inline-feedback", {
		description: "Review Markdown headings in the latest assistant response",
		handler: async (_args, ctx) => openReview(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		clearState();
		const currentText = ctx.ui.getEditorText();
		const nextText = removeMarker(currentText);
		if (nextText !== currentText) ctx.ui.setEditorText(nextText);
	});

	pi.on("session_shutdown", () => {
		clearState();
		reviewOpen = false;
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive") return { action: "continue" };

		const hasMarker = MARKER_PATTERN.test(event.text);
		if (!hasMarker) {
			clearState();
			return { action: "continue" };
		}

		const feedback = serializeFeedback(headings, drafts);
		const text = event.text.replace(MARKER_PATTERN, feedback).trimEnd();
		clearState();

		return {
			action: "transform",
			text,
			images: event.images,
		};
	});
}

function latestAssistantResponse(ctx: ExtensionContext): AssistantResponse | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex--) {
		const entry = branch[entryIndex]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		return {
			entryId: entry.id,
			completed: entry.message.stopReason === "stop" || entry.message.stopReason === "length",
			text: entry.message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n\n"),
		};
	}

	return undefined;
}

class ReviewComponent implements Component, Focusable {
	private selectedIndex: number;
	private editing = false;
	private editor: Editor;
	private _focused = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private headings: HeadingSection[],
		private drafts: Map<number, string>,
		initialIndex: number,
		private done: () => void,
	) {
		this.selectedIndex = initialIndex;

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		this.editor = new Editor(tui, editorTheme);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.editing;
	}

	handleInput(data: string): void {
		if (this.editing) {
			if (matchesKey(data, Key.escape)) {
				this.saveFeedback();
				this.editing = false;
				this.editor.focused = false;
				this.refresh();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				this.editor.handleInput("\n");
			} else {
				this.editor.handleInput(data);
			}
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.alt("left"))) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.alt("right"))) {
			if (this.selectedIndex === this.headings.length - 1) {
				this.done();
			} else {
				this.selectedIndex++;
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.editing = true;
			this.editor.setText(this.drafts.get(this.selectedIndex) ?? "");
			this.editor.focused = this._focused;
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) this.done();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const heading = this.headings[this.selectedIndex]!;
		const draft = this.drafts.get(this.selectedIndex);
		const title = `─ inline feedback · heading ${this.selectedIndex + 1}/${this.headings.length} · ${this.drafts.size} saved `;
		const header = this.theme.fg("border", truncateToWidth(title + "─".repeat(renderWidth), renderWidth, ""));
		const headingLines = new Markdown(heading.raw, 1, 0, getMarkdownTheme()).render(renderWidth);
		const feedbackLines = this.editing
			? this.editor.render(renderWidth)
			: draft
				? [this.feedbackPreview(draft, renderWidth)]
				: [];
		const bodyLines = heading.body
			? new Markdown(heading.body, 1, 0, getMarkdownTheme()).render(renderWidth)
			: [
				this.theme.fg(
					"dim",
					truncateToWidth("  (no content in this section)", renderWidth, ""),
				),
			];
		const helpText = this.editing
			? "enter newline · esc save and return to heading"
			: "enter edit · opt-←/→ navigate · esc close";
		const help = this.theme.fg("dim", truncateToWidth(`  ${helpText}`, renderWidth, ""));
		const prefix = [header, "", ...headingLines, ...feedbackLines, ""];
		const suffix = ["", help];
		const maxLines = Math.max(12, this.tui.terminal.rows - 4);
		const bodyBudget = Math.max(0, maxLines - prefix.length - suffix.length);
		let visibleBody = bodyLines.slice(0, bodyBudget);

		if (visibleBody.length < bodyLines.length && bodyBudget > 0) {
			visibleBody = visibleBody.slice(0, -1);
			visibleBody.push(
				this.theme.fg(
					"dim",
					truncateToWidth("  … section clipped …", renderWidth, ""),
				),
			);
		}

		return [...prefix, ...visibleBody, ...suffix];
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private saveFeedback(): void {
		const feedback = this.editor.getExpandedText().trim();
		if (feedback) {
			this.drafts.set(this.selectedIndex, feedback);
		} else {
			this.drafts.delete(this.selectedIndex);
		}
	}

	private feedbackPreview(feedback: string, width: number): string {
		const lines = feedback.split("\n");
		const firstLine = lines.find((line) => line.trim())?.trim() ?? "";
		const extra = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
		return this.theme.fg(
			"muted",
			truncateToWidth(`  ↳ feedback: ${firstLine}${extra}`, width, "…"),
		);
	}

	private refresh(): void {
		this.tui.requestRender();
	}
}
