import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function saveLastAssistantMessage(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+shift+x", {
    description: "Save the last assistant message as Markdown and copy its path",
    handler: async (ctx) => {
      const entry = ctx.sessionManager
        .getBranch()
        .toReversed()
        .find(
          (candidate) =>
            candidate.type === "message" &&
            candidate.message.role === "assistant" &&
            candidate.message.content.some((part) => part.type === "text" && part.text.trim()),
        );

      if (entry?.type !== "message" || entry.message.role !== "assistant") {
        ctx.ui.notify("No assistant message to save", "warning");
        return;
      }

      const markdown = entry.message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      const directory = join(homedir(), "tmp", ctx.sessionManager.getSessionId());
      const path = join(directory, `assistant-${entry.id}.md`);

      try {
        await mkdir(directory, { recursive: true });
        await writeFile(path, `${markdown}\n`, "utf8");
      } catch {
        ctx.ui.notify(`Could not save assistant message under ${directory}; check directory permissions`, "error");
        return;
      }

      try {
        await copyToClipboard(path);
      } catch {
        ctx.ui.notify(`Saved ${path}, but could not copy the path to the clipboard`, "warning");
        return;
      }

      ctx.ui.notify(`Saved ${path} and copied its path`, "info");
    },
  });
}
