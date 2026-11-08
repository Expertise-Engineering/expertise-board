"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/session";
import { generateApiKey, hashApiKey } from "@/lib/agents/keys";
import { actionError } from "@/lib/http/action-error";
import { createServiceClient } from "@/lib/supabase/service";
import type { Agent } from "@/lib/types";

export async function createAgentAction(
  name: string,
): Promise<{ ok: true; agent: Agent; apiKey: string } | { ok: false; error: string }> {
  try {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) {
      return { ok: false, error: "Agent name must be 1–80 characters." };
    }
    const { supabase, actor } = await requireActor();
    if (actor.kind !== "user") return { ok: false, error: "Only a teammate can add an agent." };
    const apiKey = generateApiKey();
    const service = createServiceClient();
    const { data: agentId, error } = await service.rpc("issue_agent_key", {
      p_name: trimmed,
      p_key_hash: hashApiKey(apiKey),
      p_created_by: actor.id,
    });
    if (error || typeof agentId !== "string") {
      return { ok: false, error: actionError(new Error(error?.message ?? "Could not add the agent.")) };
    }
    const { data, error: readError } = await supabase
      .from("agents")
      .select("id, name, revoked_at, created_by, created_at")
      .eq("id", agentId)
      .single();
    if (readError || !data) return { ok: false, error: actionError(new Error(readError?.message ?? "Could not add the agent.")) };
    revalidatePath("/", "layout");
    return { ok: true, agent: data as Agent, apiKey };
  } catch (error) {
    return { ok: false, error: actionError(error) };
  }
}

export async function revokeAgentAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { supabase } = await requireActor();
    const { error } = await supabase
      .from("agents")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null);
    if (error) return { ok: false, error: actionError(new Error(error.message)) };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error) };
  }
}

export async function deleteAgentAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { supabase } = await requireActor();
    const { error } = await supabase.from("agents").delete().eq("id", id);
    if (error) return { ok: false, error: actionError(new Error(error.message)) };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error) };
  }
}
