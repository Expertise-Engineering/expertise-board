"use client";

import { createBrowserClient } from "@supabase/ssr";
import { readPublicSupabaseEnv } from "@/lib/env";

export function createClient() {
  const env = readPublicSupabaseEnv();
  if (!env) {
    throw new Error("Supabase is not configured.");
  }
  return createBrowserClient(env.url, env.publishableKey);
}
