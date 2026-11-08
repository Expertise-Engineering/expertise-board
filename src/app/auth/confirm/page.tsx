import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { ConfirmSignIn } from "@/components/confirm-sign-in";
import { classifyAuthCallback } from "@/lib/auth/callback";
import { readPublicSupabaseEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Confirm sign-in",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export default function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<main className="p-8 text-sm text-muted-foreground">Loading sign-in…</main>}>
      <ConfirmContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ConfirmContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The token is in the query string. Wait for the real request so a build
  // cannot prerender one redirect for every visitor.
  await connection();
  const raw = await searchParams;
  if (!readPublicSupabaseEnv()) redirect("/login?error=config");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first) params.set(key, first);
  }
  const decision = classifyAuthCallback(params);
  if (decision.action !== "confirm") redirect(`/login?error=${decision.error}`);
  return <ConfirmSignIn decision={decision} />;
}
