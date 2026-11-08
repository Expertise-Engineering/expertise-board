import "server-only";

import { createClient } from "@supabase/supabase-js";
import { readPublicSupabaseEnv, readServiceRoleKey } from "@/lib/env";

export function createServiceClient() {
  const env = readPublicSupabaseEnv();
  const serviceRoleKey = readServiceRoleKey();
  if (!env || !serviceRoleKey) {
    throw new Error("Supabase service role is not configured.");
  }
  return createClient(env.url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
