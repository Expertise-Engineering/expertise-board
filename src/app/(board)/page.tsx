import { Suspense } from "react";
import { Board, EmptyBoard } from "@/components/board/board";
import { viewerFromRole } from "@/lib/access/access";
import { getSessionUser } from "@/lib/auth/session";
import { loadCompanyBoard, loadDirectory } from "@/lib/board/load";

export default function HomePage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading tasks…</p>}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const session = await getSessionUser();
  if (!session.configured || !session.user || session.removed) return null;
  const { projects, profile } = await loadDirectory(session.user.id);
  if (!profile || profile.revoked_at) return null;
  const viewer = viewerFromRole(profile.role, profile.revoked_at);
  const board = await loadCompanyBoard(viewer, projects);
  if (board.projects.length === 0) return <EmptyBoard />;
  return (
    <Board
      project={null}
      initialTasks={board.tasks}
      initialDependencies={board.dependencies}
    />
  );
}
