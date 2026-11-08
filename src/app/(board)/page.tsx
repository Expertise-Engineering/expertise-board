import { Suspense } from "react";
import { Board, EmptyBoard } from "@/components/board/board";
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
  if (!session.configured || !session.user) return null;
  const { projects } = await loadDirectory(session.user.id);
  if (projects.length === 0) return <EmptyBoard />;
  const board = await loadCompanyBoard();
  return (
    <Board
      project={null}
      initialTasks={board.tasks}
      initialDependencies={board.dependencies}
    />
  );
}
