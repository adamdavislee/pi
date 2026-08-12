import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ROOT = path.join(os.tmpdir(), "pi-subagents");
const RUNNING_DIR = path.join(ROOT, "running");
const COMPLETED_DIR = path.join(ROOT, "completed");
const SOCKETS_DIR = path.join(ROOT, "sockets");
const POLL_INTERVAL_MS = 2000;

interface JobMetadata {
	version: 1;
	id: string;
	name: string;
	model: string;
	thinkingLevel: string;
	goalFile: string;
	cwd: string;
	startedAt: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	socket: string;
}

interface JobRecord {
	id: string;
	name: string;
	state: "running" | "succeeded" | "failed";
	outputLog: string;
	socket: string;
	artifactDirectory: string;
	parentSession: {
		id: string;
		file: string | null;
	};
	childSessionDirectory: string;
	cwd: string;
	model: string;
	thinkingLevel: string;
	startedAt: string;
	exitCode?: number;
}

function ensureDirectories(): void {
	for (const dir of [RUNNING_DIR, COMPLETED_DIR, SOCKETS_DIR]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}

function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "agent";
}

function readExitCode(jobDir: string): number | undefined {
	try {
		const value = Number.parseInt(fs.readFileSync(path.join(jobDir, "exit-code"), "utf8").trim(), 10);
		return Number.isNaN(value) ? undefined : value;
	} catch {
		return undefined;
	}
}

function readJobsFrom(directory: string, completed: boolean): JobRecord[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}

	const jobs: JobRecord[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const jobDir = path.join(directory, entry.name);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(jobDir, "metadata.json"), "utf8")) as JobMetadata;
			const exitCode = completed ? readExitCode(jobDir) : undefined;
			jobs.push({
				id: metadata.id,
				name: metadata.name,
				state: completed ? (exitCode === 0 ? "succeeded" : "failed") : "running",
				outputLog: path.join(jobDir, "events.jsonl"),
				socket: metadata.socket,
				artifactDirectory: jobDir,
				parentSession: {
					id: metadata.parentSessionId,
					file: metadata.parentSessionFile,
				},
				childSessionDirectory: path.join(jobDir, "session"),
				cwd: metadata.cwd,
				model: metadata.model,
				thinkingLevel: metadata.thinkingLevel,
				startedAt: metadata.startedAt,
				...(exitCode === undefined ? {} : { exitCode }),
			});
		} catch {
			// A job can be observed between directory creation and metadata write.
		}
	}
	return jobs;
}

function listJobs(): JobRecord[] {
	ensureDirectories();
	return [...readJobsFrom(RUNNING_DIR, false), ...readJobsFrom(COMPLETED_DIR, true)].sort((a, b) =>
		a.startedAt.localeCompare(b.startedAt),
	);
}

function writeJson(filePath: string, value: unknown): void {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function completionMessage(job: JobRecord): string {
	return [
		`Subagent ${JSON.stringify(job.name)} completed.`,
		"",
		JSON.stringify(
			{
				name: job.name,
				state: job.state,
				outputLog: job.outputLog,
				socket: job.socket,
				parentSession: job.parentSession,
				childSessionDirectory: job.childSessionDirectory,
			},
			null,
			2,
		),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let interval: ReturnType<typeof setInterval> | undefined;
	let currentContext: ExtensionContext | undefined;
	let polling = false;

	const updateStatus = (ctx: ExtensionContext, jobs: JobRecord[] = listJobs()) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionJobs = jobs.filter((job) => job.parentSession.id === sessionId);
		const running = sessionJobs.filter((job) => job.state === "running").length;
		const ran = sessionJobs.length - running;
		ctx.ui.setStatus("subagents", sessionJobs.length === 0 ? undefined : `subagents: ${running} running, ${ran} ran`);
	};

	const poll = async () => {
		const ctx = currentContext;
		if (!ctx || polling) return;
		polling = true;
		try {
			const jobs = listJobs();
			updateStatus(ctx, jobs);
			if (!ctx.isIdle()) return;

			const sessionId = ctx.sessionManager.getSessionId();
			for (const job of jobs) {
				if (job.state === "running" || job.parentSession.id !== sessionId) continue;
				const injectedMarker = path.join(job.artifactDirectory, "injected");
				if (fs.existsSync(injectedMarker)) continue;

				pi.sendMessage({
					customType: "subagent-completion",
					content: completionMessage(job),
					display: true,
					details: job,
				});
				fs.writeFileSync(injectedMarker, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
			}
		} finally {
			polling = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		ensureDirectories();
		await poll();
		interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (interval) clearInterval(interval);
		interval = undefined;
		currentContext = undefined;
		ctx.ui.setStatus("subagents", undefined);
	});

	pi.registerTool({
		name: "spawn-subagent",
		label: "Spawn subagent",
		description:
			"Spawn a detached Pi subagent. Use only in accordance with the user's suggestions. The job survives this Pi process and writes a JSONL event log under /tmp/pi-subagents.",
		parameters: Type.Object({
			name: Type.String({ description: "Short human-readable name for the subagent" }),
			model: Type.String({ description: "Pi model name or provider/model selector" }),
			thinkingLevel: StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
				description: "Thinking level for the subagent",
			}),
			goal: Type.String({ description: "Focused goal for the subagent" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ensureDirectories();
			const id = `${slugify(params.name)}-${randomUUID().slice(0, 8)}`;
			const jobDir = path.join(RUNNING_DIR, id);
			const sessionDir = path.join(jobDir, "session");
			const goalFile = path.join(jobDir, "task.md");
			const socket = path.join(SOCKETS_DIR, id);
			fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			fs.writeFileSync(goalFile, `${params.goal}\n`, { encoding: "utf8", mode: 0o600 });

			const metadata: JobMetadata = {
				version: 1,
				id,
				name: params.name,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				goalFile,
				cwd: ctx.cwd,
				startedAt: new Date().toISOString(),
				parentSessionId: ctx.sessionManager.getSessionId(),
				parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
				socket,
			};
			writeJson(path.join(jobDir, "metadata.json"), metadata);

			const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-subagent");
			const args = [
				"-n",
				socket,
				runner,
				jobDir,
				COMPLETED_DIR,
				"pi",
				"--mode",
				"json",
				"-p",
				"--name",
				`subagent: ${params.name}`,
				"--model",
				params.model,
				"--thinking",
				params.thinkingLevel,
				"--session-dir",
				sessionDir,
				`@${goalFile}`,
			];
			const result = await pi.exec("dtach", args, { signal, timeout: 5000 });
			if (result.code !== 0) {
				fs.rmSync(jobDir, { recursive: true, force: true });
				throw new Error(`dtach failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
			}

			const record = readJobsFrom(RUNNING_DIR, false).find((job) => job.id === id);
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: JSON.stringify(record ?? { id, name: params.name, state: "running" }, null, 2) }],
				details: record ?? { id, name: params.name, state: "running" },
			};
		},
	});

	pi.registerTool({
		name: "list-subagents",
		label: "List subagents",
		description:
			"List detached Pi subagents, including state, JSONL output log, dtach socket, and the session that spawned each job.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const jobs = listJobs();
			updateStatus(ctx, jobs);
			return {
				content: [{ type: "text", text: jobs.length === 0 ? "No subagents." : JSON.stringify(jobs, null, 2) }],
				details: { jobs },
			};
		},
	});
}
