import { Suspense } from "react";
import { headers } from "next/headers";
import { AgentsAdmin } from "@/components/agents/agents-admin";

export default function AgentsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading agents…</p>}>
      <AgentsScreen />
    </Suspense>
  );
}

async function AgentsScreen() {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const mcpUrl = host ? `${proto}://${host}/api/mcp` : "/api/mcp";
  return <AgentsAdmin mcpUrl={mcpUrl} />;
}
