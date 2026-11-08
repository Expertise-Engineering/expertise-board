import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AdminPanel } from "@/components/admin/admin-panel";
import { canAdminister, viewerFromRole } from "@/lib/access/access";
import { getSessionUser } from "@/lib/auth/session";
import { loadAccessDirectory, loadDirectory } from "@/lib/board/load";

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading admin…</p>}>
      <AdminScreen />
    </Suspense>
  );
}

async function AdminScreen() {
  const session = await getSessionUser();
  if (!session.configured || !session.user || session.removed) notFound();
  const directory = await loadDirectory(session.user.id);
  if (!directory.profile || !canAdminister(viewerFromRole(directory.profile.role, directory.profile.revoked_at))) {
    notFound();
  }
  const people = await loadAccessDirectory();
  return <AdminPanel people={people} />;
}
