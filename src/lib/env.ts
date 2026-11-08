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

/** Canonical site origin, inlined at build time. Used for the Agents MCP URL. */
export function readSiteUrl(): string | null {
  const value = nonempty(process.env.NEXT_PUBLIC_SITE_URL);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
