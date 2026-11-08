import "server-only";

import { redirect } from "next/navigation";
import { isAllowedEmail } from "@/lib/auth/email";
import { readPublicSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { Actor } from "@/lib/types";

export type SessionState =
  | { configured: false }
  | { configured: true; user: null }
  | { configured: true; user: { id: string; email: string } };

export async function getSessionUser(): Promise<SessionState> {
  if (!readPublicSupabaseEnv()) return { configured: false };
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const id = typeof data?.claims?.sub === "string" ? data.claims.sub : null;
  let email = typeof data?.claims?.email === "string" ? data.claims.email : "";
  if (id && !email) {
    const userResult = await supabase.auth.getUser();
    email = userResult.data.user?.email ?? "";
  }
  if (!id || !isAllowedEmail(email)) return { configured: true, user: null };
  return { configured: true, user: { id, email } };
}

export async function requireActor(): Promise<{ supabase: Awaited<ReturnType<typeof createClient>>; actor: Actor }> {
  if (!readPublicSupabaseEnv()) {
    throw new Error("Supabase is not configured.");
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email || !isAllowedEmail(data.user.email)) {
    redirect("/login");
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", data.user.id)
    .maybeSingle();
  const displayName =
    typeof profile?.display_name === "string" && profile.display_name
      ? profile.display_name
      : data.user.email.split("@")[0] || "Teammate";
  return {
    supabase,
    actor: { kind: "user", id: data.user.id, name: displayName },
  };
}
