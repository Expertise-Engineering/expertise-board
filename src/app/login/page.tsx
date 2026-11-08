import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { SetupGuide } from "@/components/setup-guide";
import { readPublicSupabaseEnv } from "@/lib/env";

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <Suspense fallback={<main className="p-8 text-sm text-muted-foreground">Loading sign-in…</main>}>
      <LoginContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginContent({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  if (!readPublicSupabaseEnv()) return <SetupGuide />;
  return <LoginForm errorCode={params.error} />;
}
