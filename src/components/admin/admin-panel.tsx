"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addPersonAction, removePersonAction, restorePersonAction, setPersonRoleAction } from "@/actions/admin";
import { setProjectClassAction } from "@/actions/board";
import { useBoard } from "@/components/shell/board-context";
import {
  activeExecutiveCount,
  personStatus,
  projectClassLabel,
  roleLabel,
  type AccessRole,
} from "@/lib/access/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const controlClass =
  "h-9 rounded-lg border border-input bg-card px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type AdminPerson = {
  email: string;
  role: AccessRole;
  revoked_at: string | null;
  user_id: string | null;
  display_name: string | null;
};

export function AdminPanel({ people }: { people: AdminPerson[] }) {
  const { projects } = useBoard();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-6 sm:px-6">
      <div className="grid gap-2">
        <h1 className="text-4xl font-medium tracking-tight">Admin</h1>
        <p className="max-w-2xl text-muted-foreground">
          Executives can see every project and this page. Regular teammates share every regular project and cannot open executive ones.
          Add someone before they sign in to choose their role. Removing them keeps history and stops the next sign-in, even with an @exp-eng.com email.
        </p>
      </div>
      <PeopleSection people={people} />
      <ProjectsSection projects={projects} />
    </main>
  );
}

function PeopleSection({ people }: { people: AdminPerson[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AccessRole>("user");
  const [pending, startTransition] = useTransition();
  const executives = activeExecutiveCount(people.map((person) => ({
    email: person.email,
    role: person.role,
    revokedAt: person.revoked_at,
  })));

  function onAdd(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await addPersonAction({ email, role });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setEmail("");
      setRole("user");
      router.refresh();
    });
  }

  return (
    <section className="grid gap-4" aria-labelledby="people-heading">
      <div>
        <h2 id="people-heading" className="text-lg font-medium">People</h2>
        <p className="mt-1 text-sm text-muted-foreground">Only @exp-eng.com addresses. The last executive cannot be demoted or removed.</p>
      </div>
      <form onSubmit={onAdd} className="grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="admin-email">Email</Label>
          <Input
            id="admin-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@exp-eng.com"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="admin-role">Role</Label>
          <select id="admin-role" className={controlClass} value={role} onChange={(event) => setRole(event.target.value as AccessRole)}>
            <option value="user">Regular</option>
            <option value="executive">Executive</option>
          </select>
        </div>
        <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add person"}</Button>
      </form>
      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one is on the list yet.</p>
      ) : (
        <ul className="grid gap-3">
          {people.map((person) => (
            <PersonCard key={person.email} person={person} soleExecutive={executives <= 1} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonCard({ person, soleExecutive }: { person: AdminPerson; soleExecutive: boolean }) {
  const router = useRouter();
  const [role, setRole] = useState(person.role);
  const [seen, setSeen] = useState(person);
  const [pending, startTransition] = useTransition();
  if (seen.role !== person.role || seen.revoked_at !== person.revoked_at || seen.display_name !== person.display_name) {
    setSeen(person);
    setRole(person.role);
  }
  const removed = Boolean(person.revoked_at);
  const locked = soleExecutive && person.role === "executive" && !removed;
  const status = personStatus({ userId: person.user_id, revokedAt: person.revoked_at });

  function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{person.display_name ?? "Has not signed in"}</p>
          <p className="truncate text-sm text-muted-foreground">{person.email}</p>
        </div>
        <p className="text-sm text-muted-foreground">{roleLabel(person.role)} · {status}</p>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="sr-only" htmlFor={`role-${person.email}`}>Role for {person.email}</label>
        <select
          id={`role-${person.email}`}
          className={controlClass}
          value={role}
          disabled={pending || removed}
          onChange={(event) => setRole(event.target.value as AccessRole)}
        >
          <option value="user" disabled={locked}>Regular</option>
          <option value="executive">Executive</option>
        </select>
        {removed ? (
          <Button type="button" variant="outline" disabled={pending} onClick={() => run(() => restorePersonAction(person.email))}>
            Restore
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={pending || role === person.role}
              onClick={() => run(() => setPersonRoleAction({ email: person.email, role }))}
            >
              Save role
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || locked}
              onClick={() => run(() => removePersonAction(person.email))}
            >
              Remove
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function ProjectsSection({ projects }: { projects: ReturnType<typeof useBoard>["projects"] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(id: string, accessClass: "executive" | "user") {
    setPendingId(id);
    startTransition(async () => {
      const result = await setProjectClassAction({
        id,
        accessClass: accessClass === "executive" ? "user" : "executive",
      });
      setPendingId(null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="grid gap-4" aria-labelledby="project-class-heading">
      <div>
        <h2 id="project-class-heading" className="text-lg font-medium">Projects</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          New projects are regular. Mark one executive when regular teammates and agents should not see it.
        </p>
      </div>
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="grid gap-3">
          {projects.map((project) => (
            <li key={project.id} className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">{project.name}</p>
                <p className="text-sm text-muted-foreground">{projectClassLabel(project.access_class)}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={pendingId === project.id}
                onClick={() => toggle(project.id, project.access_class)}
              >
                {pendingId === project.id
                  ? "Saving…"
                  : project.access_class === "executive"
                    ? "Make regular"
                    : "Make executive"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
