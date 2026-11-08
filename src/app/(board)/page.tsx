import { Suspense } from "react";
import { redirect } from "next/navigation";
import { EmptyBoard } from "@/components/board/board";
import { getSessionUser } from "@/lib/auth/session";
import { loadDirectory } from "@/lib/board/load";

export default function HomePage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading projects…</p>}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const session = await getSessionUser();
  if (!session.configured || !session.user) return null;
  const { projects } = await loadDirectory(session.user.id);
  const first = projects[0];
  if (first) redirect(`/projects/${first.slug}`);
  return <EmptyBoard />;
}
