"use server";

import { revalidatePath } from "next/cache";
import {
  LAST_EXECUTIVE_ERROR,
  planDirectoryAction,
  viewerFromRole,
  type AccessRole,
  type DirectoryRecord,
} from "@/lib/access/access";
import { requireActor } from "@/lib/auth/session";
import { loadAccessDirectory } from "@/lib/board/load";
import { errorMessage } from "@/lib/board/text";

type AdminResult = { ok: true } | { ok: false; error: string };

async function changeDirectory(
  action:
    | { type: "add"; email: string; role: AccessRole }
    | { type: "set-role"; email: string; role: AccessRole }
    | { type: "remove"; email: string }
    | { type: "restore"; email: string },
): Promise<AdminResult> {
  try {
    const { supabase, actor } = await requireActor();
    if (actor.kind !== "user" || actor.role !== "executive") {
      return { ok: false, error: "Only an executive can change access." };
    }
    const rows = await loadAccessDirectory();
    const people: DirectoryRecord[] = rows.map((row) => ({
      email: row.email,
      role: row.role,
      revokedAt: row.revoked_at,
    }));
    const plan = planDirectoryAction(viewerFromRole(actor.role, null), people, action);
    if (!plan.ok) return plan;

    const existing = people.find((person) => person.email === plan.email);
    let error: { message: string } | null = null;
    if (action.type === "add" && !existing) {
      ({ error } = await supabase.from("directory").insert({
        email: plan.email,
        role: plan.role,
        revoked_at: null,
      }));
    } else if (action.type === "add" || action.type === "restore") {
      ({ error } = await supabase
        .from("directory")
        .update({ role: plan.role, revoked_at: null })
        .eq("email", plan.email));
    } else if (action.type === "set-role") {
      ({ error } = await supabase.from("directory").update({ role: plan.role }).eq("email", plan.email));
    } else {
      ({ error } = await supabase
        .from("directory")
        .update({ revoked_at: new Date().toISOString() })
        .eq("email", plan.email));
    }
    if (error) return { ok: false, error: friendlyAccessError(error.message) };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, error: friendlyAccessError(message) };
  }
}

function friendlyAccessError(message: string): string {
  if (/last executive/i.test(message)) return LAST_EXECUTIVE_ERROR;
  if (/row-level security|permission denied|not allowed|do not have access/i.test(message)) {
    return "Only an executive can change access.";
  }
  return errorMessage(new Error(message));
}

export async function addPersonAction(input: { email: string; role: AccessRole }): Promise<AdminResult> {
  return changeDirectory({ type: "add", email: input.email, role: input.role });
}

export async function setPersonRoleAction(input: { email: string; role: AccessRole }): Promise<AdminResult> {
  return changeDirectory({ type: "set-role", email: input.email, role: input.role });
}

export async function removePersonAction(email: string): Promise<AdminResult> {
  return changeDirectory({ type: "remove", email });
}

export async function restorePersonAction(email: string): Promise<AdminResult> {
  return changeDirectory({ type: "restore", email });
}
