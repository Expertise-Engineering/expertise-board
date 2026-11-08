"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/session";
import { actionError } from "@/lib/http/action-error";
import { readPublicSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  if (readPublicSupabaseEnv()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

export async function updateDisplayName(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const displayName = name.trim();
    if (!displayName || displayName.length > 80) {
      return { ok: false, error: "Use a display name of 80 characters or fewer." };
    }
    const { supabase, actor } = await requireActor();
    if (actor.kind !== "user") return { ok: false, error: "People rename their own profiles." };
    const { error } = await supabase.from("profiles").update({ display_name: displayName }).eq("id", actor.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error) };
  }
}
