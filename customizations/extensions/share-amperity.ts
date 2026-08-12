import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const REPOSITORY = join(homedir(), "pi-sessions");
const SESSIONS_DIRECTORY = join(REPOSITORY, "pi-sessions");
const BRANCH = "pi-sessions";
const PAGES_URL = "https://redesigned-enigma-qwmrpl7.pages.github.io";

export default function shareAmperity(pi: ExtensionAPI) {
	pi.registerCommand("share-amperity", {
		description: "Export this session to private Amperity Pages and copy the URL",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot share an in-memory session", "error");
				return;
			}

			const targetId = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message")?.id;
			const filename = `pi-session-${basename(sessionFile, ".jsonl")}.html`;
			const outputPath = join(SESSIONS_DIRECTORY, filename);

			try {
				const userEmail = (await run(pi, "jj", ["config", "get", "user.email"], REPOSITORY)).trim();
				await run(pi, "jj", ["git", "fetch"], REPOSITORY);
				await run(pi, "jj", ["new", `${BRANCH}@origin`], REPOSITORY);
				await mkdir(SESSIONS_DIRECTORY, { recursive: true });
				await run(pi, "pi", ["--export", sessionFile, outputPath]);
				await customizeExport(outputPath, userEmail);
				await run(pi, "jj", ["describe", "-m", `Publish ${filename}`], REPOSITORY);
				await run(pi, "jj", ["bookmark", "move", BRANCH, "--to", "@"], REPOSITORY);
				await run(pi, "jj", ["git", "push", "--bookmark", BRANCH], REPOSITORY);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Share failed: ${message}`, "error");
				return;
			}

			const url = `${PAGES_URL}/pi-sessions/${filename}${targetId ? `?targetId=${targetId}` : ""}`;
			try {
				await run(pi, "osascript", [
					"-e",
					"on run argv",
					"-e",
					"set the clipboard to item 1 of argv",
					"-e",
					"end run",
					url,
				]);
				ctx.ui.notify(`Shared and copied URL: ${url}`, "info");
			} catch {
				ctx.ui.notify(`Shared URL (clipboard copy failed): ${url}`, "warning");
			}
		},
	});
}

async function run(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<string> {
	const result = await pi.exec(command, args, { cwd, timeout: 120_000 });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `${command} exited with code ${result.code}`);
	}
	return result.stdout;
}

async function customizeExport(path: string, userEmail: string): Promise<void> {
	let html = await readFile(path, "utf8");
	const dataPattern = /(<script id="session-data" type="application\/json">)([^<]+)(<\/script>)/;
	const match = html.match(dataPattern);
	if (!match) throw new Error("Could not find session data in HTML export");

	const data = JSON.parse(Buffer.from(match[2]!, "base64").toString("utf8"));
	const removedParents = new Map<string, string | null>
		(data.entries
			.filter((entry: any) => entry.type === "custom" && entry.customType === "share-amperity")
			.map((entry: any) => [entry.id, entry.parentId]));
	const retainedEntries = data.entries.filter((entry: any) => !removedParents.has(entry.id));
	const retainedParent = (id: string | null): string | null => {
		while (id && removedParents.has(id)) id = removedParents.get(id) ?? null;
		return id;
	};
	for (const entry of retainedEntries) entry.parentId = retainedParent(entry.parentId);
	data.entries = retainedEntries;
	data.leafId = retainedParent(data.leafId);

	const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
	html = html.replace(dataPattern, `$1${encoded}$3`);
	const defaultFilter = "let filterMode = 'default';";
	if (!html.includes(defaultFilter)) throw new Error("Could not find default sidebar filter");
	html = html.replace(defaultFilter, "let filterMode = 'no-tools';");
	const dateRow = '<div class="info-item"><span class="info-label">Date:</span>';
	if (!html.includes(dateRow)) throw new Error("Could not find export metadata block");
	const userRow = `<div class="info-item"><span class="info-label">User:</span><span class="info-value">${escapeHtml(userEmail)}</span></div>`;
	html = html.replace(dateRow, `${userRow}\n              ${dateRow}`);
	await writeFile(path, html, "utf8");
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character]!);
}
