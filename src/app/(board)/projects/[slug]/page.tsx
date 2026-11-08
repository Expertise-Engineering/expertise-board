import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Board } from "@/components/board/board";
import { viewerFromRole } from "@/lib/access/access";
import { getSessionUser } from "@/lib/auth/session";
import { loadProjectBoard } from "@/lib/board/load";

export default function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading tasks…</p>}>
      <ProjectScreen params={params} />
    </Suspense>
  );
}

async function ProjectScreen({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSessionUser();
  if (!session.configured || !session.user || session.removed) notFound();
  const board = await loadProjectBoard(slug, viewerFromRole(session.user.role, null));
  if (!board) notFound();
  return (
    <Board
      project={board.project}
      initialTasks={board.tasks}
      initialDependencies={board.dependencies}
    />
  );
}
