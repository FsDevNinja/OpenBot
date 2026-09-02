import type { ReactNode } from "react";
import { ActiveBotProvider } from "@/lib/agent/active-bot";
import { CloudAgentTools } from "@/lib/agent/cloud-agent-tools";
import { ComputerTools } from "@/lib/agent/computer-tools";
import { EscalationTool } from "@/lib/agent/escalation-tool";
import { GalleryTools } from "@/lib/agent/gallery-tools";
import { HandoffTool } from "@/lib/agent/handoff-tool";
import { SandboxedTools } from "@/lib/agent/sandboxed-tools";
import { RuntimeProvider } from "./provider";

/** One native AG-UI registry for the authenticated application. */
export function RuntimeAppProvider({ children }: { children: ReactNode }) {
  return (
    <RuntimeProvider>
      <ActiveBotProvider>
        <ComputerTools />
        <CloudAgentTools />
        <HandoffTool />
        <EscalationTool />
        <GalleryTools />
        <SandboxedTools />
        {children}
      </ActiveBotProvider>
    </RuntimeProvider>
  );
}
