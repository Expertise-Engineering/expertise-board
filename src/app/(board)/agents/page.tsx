import { AgentsAdmin } from "@/components/agents/agents-admin";
import { readSiteUrl } from "@/lib/env";

export default function AgentsPage() {
  const origin = readSiteUrl();
  const mcpUrl = origin ? `${origin}/api/mcp` : "/api/mcp";
  return <AgentsAdmin mcpUrl={mcpUrl} />;
}
