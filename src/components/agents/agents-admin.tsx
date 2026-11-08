"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAgentAction, deleteAgentAction, revokeAgentAction } from "@/actions/agents";
import { useBoard } from "@/components/shell/board-context";
import { formatStamp } from "@/lib/board/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AgentsAdmin({ mcpUrl }: { mcpUrl: string }) {
  const { agents, profiles } = useBoard();
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [issued, setIssued] = useState<{ name: string; apiKey: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function onCreate(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createAgentAction(name);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setName("");
      setCopied(false);
      setIssued({ name: result.agent.name, apiKey: result.apiKey });
      router.refresh();
    });
  }

  async function copyKey() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.apiKey);
      setCopied(true);
    } catch {
      toast.error("Could not copy. Select the key and copy it manually.");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6">
      <div className="grid gap-2">
        <h1 className="text-4xl font-medium tracking-tight">Agents</h1>
        <p className="max-w-2xl text-muted-foreground">
          Each agent is its own actor, with its own API key. The key is shown once. Connect it to the MCP endpoint with a bearer token. Revoked keys stop working immediately.
        </p>
      </div>

      <section className="rounded-2xl border bg-card p-4" aria-labelledby="mcp-heading">
        <h2 id="mcp-heading" className="text-lg font-medium">MCP connection</h2>
        <dl className="mt-3 grid gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">URL</dt>
            <dd className="mt-1 font-mono text-xs break-all">{mcpUrl}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Header</dt>
            <dd className="mt-1 font-mono text-xs">Authorization: Bearer eb_…</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="add-agent-heading">
        <h2 id="add-agent-heading" className="text-lg font-medium">Add an agent</h2>
        <form onSubmit={onCreate} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="intake"
              required
              maxLength={80}
            />
          </div>
          <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add agent"}</Button>
        </form>
      </section>

      <section aria-labelledby="agent-list-heading">
        <h2 id="agent-list-heading" className="text-lg font-medium">Directory</h2>
        {agents.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No agents yet. Add one, copy the key, and add the MCP server in your client.
          </p>
        ) : (
          <ul className="mt-3 divide-y rounded-2xl border bg-card">
            {agents.map((agent) => {
              const creator = profiles.find((profile) => profile.id === agent.created_by);
              return (
                <li key={agent.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">
                      {agent.name}
                      {agent.revoked_at ? <span className="ml-2 text-xs text-destructive">Revoked</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added {formatStamp(agent.created_at)}
                      {creator ? ` by ${creator.display_name}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {agent.revoked_at ? null : (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          startTransition(async () => {
                            const result = await revokeAgentAction(agent.id);
                            if (!result.ok) toast.error(result.error);
                            else router.refresh();
                          });
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        if (!window.confirm(`Delete ${agent.name}? Tasks they were assigned stay on the board.`)) return;
                        startTransition(async () => {
                          const result = await deleteAgentAction(agent.id);
                          if (!result.ok) toast.error(result.error);
                          else router.refresh();
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog open={issued !== null} onOpenChange={(open) => { if (!open) setIssued(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API key for {issued?.name}</DialogTitle>
            <DialogDescription>
              Copy this key now. Expertise Board stores only a hash, so it cannot show the key again.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg border bg-muted px-3 py-2 font-mono text-xs break-all">{issued?.apiKey}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void copyKey()}>
              {copied ? "Copied" : "Copy key"}
            </Button>
            <Button type="button" onClick={() => setIssued(null)}>I have saved this key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
