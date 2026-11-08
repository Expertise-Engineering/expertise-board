import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { MissingProfile, SetupGuide } from "@/components/setup-guide";
import { getSessionUser } from "@/lib/auth/session";
import { loadDirectory } from "@/lib/board/load";

export default function BoardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<BoardFallback />}>
      <Frame>{children}</Frame>
    </Suspense>
  );
}

async function Frame({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session.configured) return <SetupGuide />;
  if (!session.user) redirect("/login");
  const directory = await loadDirectory(session.user.id);
  if (!directory.profile) return <MissingProfile email={session.user.email} />;
  return (
    <AppShell directory={{ ...directory, profile: directory.profile }}>
      {children}
    </AppShell>
  );
}

function BoardFallback() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[18rem_1fr]">
      <div className="hidden bg-sidebar lg:block" />
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading the board…</p>
        <div className="mt-6 flex gap-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-64 w-64 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      </div>
    </div>
  );
}
