import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function changeThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext, offset: number) {
  const currentIndex = thinkingLevels.indexOf(pi.getThinkingLevel());
  const nextIndex = Math.max(0, Math.min(thinkingLevels.length - 1, currentIndex + offset));
  pi.setThinkingLevel(thinkingLevels[nextIndex]);
  ctx.ui.notify(`Thinking: ${pi.getThinkingLevel()}`, "info");
}

export default function thinkingLevelShortcuts(pi: ExtensionAPI) {
  pi.registerShortcut("alt+t", {
    description: "Increase thinking level",
    handler: (ctx: ExtensionContext) => changeThinkingLevel(pi, ctx, 1),
  });

  pi.registerShortcut("alt+shift+t", {
    description: "Decrease thinking level",
    handler: (ctx: ExtensionContext) => changeThinkingLevel(pi, ctx, -1),
  });
}
