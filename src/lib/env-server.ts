import "server-only";

function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readServiceRoleKey(): string | null {
  return nonempty(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
