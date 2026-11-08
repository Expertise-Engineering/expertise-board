import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { normalizeRole, sessionAccess, type AccessRole } from "@/lib/access/access";
import { isAllowedEmail } from "@/lib/auth/email";
import { readPublicSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { Actor } from "@/lib/types";

export type SessionState =
  | { configured: false }
  | { configured: true; user: null; removed?: boolean }
  | { configured: true; user: { id: string; email: string; role: AccessRole }; removed?: false };

type AccessRow = { role: string; revoked_at: string | null } | null;

export const loadOwnAccess = cache(async (userId: string): Promise<AccessRow> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("directory")
    .select("role, revoked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (/relation|schema cache|could not find/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  return data;
});

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
  const access = await loadOwnAccess(id);
  const decision = sessionAccess(
    access ? { role: normalizeRole(access.role), revokedAt: access.revoked_at } : null,
  );
  if (decision.state === "removed") return { configured: true, user: null, removed: true };
  const role = decision.state === "active" ? decision.role : "user";
  return { configured: true, user: { id, email, role } };
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
  const access = await loadOwnAccess(data.user.id);
  const decision = sessionAccess(
    access ? { role: normalizeRole(access.role), revokedAt: access.revoked_at } : null,
  );
  if (decision.state === "removed") {
    await supabase.auth.signOut({ scope: "global" });
    redirect("/login?error=removed");
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
    actor: {
      kind: "user",
      id: data.user.id,
      name: displayName,
      role: decision.state === "active" ? decision.role : "user",
    },
  };
}
