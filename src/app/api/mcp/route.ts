import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { connection } from "next/server";
import { readServiceRoleKey } from "@/lib/env-server";
import { readPublicSupabaseEnv } from "@/lib/env";
import { authenticateAgent, createExpertiseMcpServer } from "@/lib/mcp/server";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status: number, message: string) {
  return withCors(
    Response.json(
      { jsonrpc: "2.0", id: null, error: { code: status === 401 ? -32001 : -32000, message } },
      {
        status,
        headers: status === 401 ? { "WWW-Authenticate": 'Bearer realm="expertise-board"' } : {},
      },
    ),
  );
}

async function handle(request: Request): Promise<Response> {
  await connection();
  if (!readPublicSupabaseEnv() || !readServiceRoleKey()) {
    return jsonError(503, "Expertise Board MCP is not configured. Set the Supabase URL and service role key.");
  }

  let agent: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    agent = await authenticateAgent(request.headers.get("authorization"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not validate the agent key.";
    return jsonError(503, message);
  }
  if (!agent) {
    return jsonError(401, "Missing, unknown, or revoked agent API key. Send Authorization: Bearer <key>.");
  }

  const server = createExpertiseMcpServer(agent);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  return withCors(response);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}

export function DELETE(request: Request) {
  return handle(request);
}
