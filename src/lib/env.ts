export type PublicSupabaseEnv = {
  url: string;
  publishableKey: string;
};

function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readPublicSupabaseEnv(): PublicSupabaseEnv | null {
  const url = nonempty(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const publishableKey = nonempty(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}

export function readServiceRoleKey(): string | null {
  return nonempty(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
