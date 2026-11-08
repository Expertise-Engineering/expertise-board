"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Bot, LogOut, Menu, Plus, Shield } from "lucide-react";
import { toast } from "sonner";
import { updateDisplayName, signOut } from "@/actions/account";
import { createProjectAction } from "@/actions/board";
import { BoardProvider, useBoard, type Directory } from "@/components/shell/board-context";
import { realtimeSubscriptions, viewerFromRole, type ProjectClass } from "@/lib/access/access";
import { readPublicSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function AppShell({ directory, children }: { directory: Directory; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [live, setLive] = useState<"connecting" | "live" | "offline">(() =>
    readPublicSupabaseEnv() ? "connecting" : "offline",
  );
  const [navPath, setNavPath] = useState(pathname);
  if (pathname !== navPath) {
    setNavPath(pathname);
    setNavOpen(false);
  }

  const subscriptionKey = `${directory.profile.role}:${directory.profile.revoked_at ?? ""}:${directory.projects.map((project) => project.id).join(",")}`;
  useEffect(() => {
    if (!readPublicSupabaseEnv()) return;
    const supabase = createClient();
    let timer = 0;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => router.refresh(), 300);
    };
    const viewer = viewerFromRole(directory.profile.role, directory.profile.revoked_at);
    let channel = supabase.channel("expertise-board");
    for (const subscription of realtimeSubscriptions(viewer, directory.projects.map((project) => project.id))) {
      channel = channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: subscription.table,
          ...(subscription.filter ? { filter: subscription.filter } : {}),
        },
        refresh,
      );
    }
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setLive("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setLive("offline");
    });
    return () => {
      window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [router, subscriptionKey, directory.profile.role, directory.profile.revoked_at, directory.projects]);

  const contextValue = useMemo(
    () => ({ ...directory, openNewProject: () => setProjectOpen(true) }),
    [directory],
  );

  return (
    <BoardProvider value={contextValue}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
          <SidebarBody
            pathname={pathname}
            live={live}
            onNewProject={() => setProjectOpen(true)}
            onRename={() => setNameOpen(true)}
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b bg-card px-4 py-3 lg:hidden">
            <Button type="button" variant="outline" size="sm" onClick={() => setNavOpen(true)} aria-label="Open projects">
              <Menu />
              Projects
            </Button>
            <LiveDot live={live} tone="plain" />
          </header>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-xs">
          <SheetHeader className="sr-only">
            <SheetTitle>Projects</SheetTitle>
          </SheetHeader>
          <SidebarBody
            pathname={pathname}
            live={live}
            onNewProject={() => {
              setNavOpen(false);
              setProjectOpen(true);
            }}
            onRename={() => {
              setNavOpen(false);
              setNameOpen(true);
            }}
          />
        </SheetContent>
      </Sheet>
      <ProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
      <NameDialog open={nameOpen} onOpenChange={setNameOpen} current={directory.profile.display_name} />
    </BoardProvider>
  );
}

function SidebarBody({
  pathname,
  live,
  onNewProject,
  onRename,
}: {
  pathname: string;
  live: "connecting" | "live" | "offline";
  onNewProject: () => void;
  onRename: () => void;
}) {
  const { projects, profile } = useBoard();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 px-4 py-5">
        <div>
          <Link href="/" className="font-display text-xl leading-none text-sidebar-foreground">Expertise Board</Link>
          <p className="mt-2 text-xs text-sidebar-foreground/70">Who is doing what</p>
        </div>
        <LiveDot live={live} />
      </div>
      <div className="px-3">
        <Button type="button" className="w-full" onClick={onNewProject}>
          <Plus />
          New project
        </Button>
      </div>
      <nav aria-label="Projects" className="mt-4 flex-1 overflow-y-auto px-2 pb-4">
        <ul className="grid gap-1">
          <li>
            <Link
              href="/"
              aria-current={pathname === "/" ? "page" : undefined}
              className={`block rounded-lg px-2 py-2 text-sm ${pathname === "/" ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/70"}`}
            >
              <span className="block font-medium">All projects</span>
              <span className="mt-0.5 block text-xs text-sidebar-foreground/65">Every customer</span>
            </Link>
          </li>
        </ul>
        <p className="px-2 pt-4 pb-2 text-xs tracking-wide text-sidebar-foreground/60 uppercase">Projects</p>
        {projects.length === 0 ? (
          <p className="px-2 text-sm text-sidebar-foreground/70">No projects yet.</p>
        ) : (
          <ul className="grid gap-1">
            {projects.map((project) => {
              const href = `/projects/${project.slug}`;
              const active = pathname === href;
              return (
                <li key={project.id}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-2 py-2 text-sm ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/70"}`}
                  >
                    <span className="block font-medium">{project.name}</span>
                    {project.access_class === "executive" ? (
                      <span className="mt-0.5 block text-[10px] tracking-wide text-sidebar-foreground/60 uppercase">Executive</span>
                    ) : null}
                    {project.description ? (
                      <span className="mt-0.5 block truncate text-xs text-sidebar-foreground/65">{project.description}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      <div className="border-t border-sidebar-border p-3">
        {profile.role === "executive" ? (
          <Link
            href="/admin"
            aria-current={pathname === "/admin" ? "page" : undefined}
            className={`mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${pathname === "/admin" ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}
          >
            <Shield className="size-4" />
            Admin
          </Link>
        ) : null}
        <Link
          href="/agents"
          aria-current={pathname === "/agents" ? "page" : undefined}
          className={`mb-3 flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${pathname === "/agents" ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}
        >
          <Bot className="size-4" />
          Agents
        </Link>
        <button type="button" onClick={onRename} className="block w-full rounded-lg px-2 py-1 text-left hover:bg-sidebar-accent/70">
          <span className="block text-sm font-medium">{profile.display_name}</span>
          <span className="block truncate text-xs text-sidebar-foreground/65">{profile.email}</span>
        </button>
        <form action={signOut} className="mt-2">
          <Button type="submit" variant="ghost" className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <LogOut />
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}

function LiveDot({
  live,
  tone = "inverse",
}: {
  live: "connecting" | "live" | "offline";
  tone?: "inverse" | "plain";
}) {
  const label = live === "live" ? "Live updates on" : live === "offline" ? "Live updates off" : "Connecting live updates";
  const color = live === "live" ? "bg-emerald-500" : live === "offline" ? "bg-amber-500" : "bg-current/40";
  const text = tone === "inverse" ? "text-sidebar-foreground/80" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${text}`} title={label}>
      <span className={`size-2 rounded-full ${color}`} aria-hidden />
      <span className="sr-only">{label}</span>
      <span aria-hidden>{live === "live" ? "Live" : live === "offline" ? "Offline" : "…"}</span>
    </span>
  );
}

function ProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { profile } = useBoard();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [accessClass, setAccessClass] = useState<ProjectClass>("user");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setAccessClass("user");
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createProjectAction({
        name,
        description,
        accessClass: profile.role === "executive" ? accessClass : "user",
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setName("");
      setDescription("");
      setAccessClass("user");
      onOpenChange(false);
      router.push(`/projects/${result.data.slug}`);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A project is one customer or one job. Tasks on its board stay together.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </div>
          {profile.role === "executive" ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div>
                <Label htmlFor="project-class">Executive project</Label>
                <p className="text-xs text-muted-foreground">Regular teammates and agents cannot see it.</p>
              </div>
              <Switch
                id="project-class"
                checked={accessClass === "executive"}
                onCheckedChange={(checked) => setAccessClass(checked ? "executive" : "user")}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NameDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(current);
  const [pending, startTransition] = useTransition();
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setName(current);
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateDisplayName(name);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Your name</DialogTitle>
          <DialogDescription>This is how you appear on cards, comments, and activity.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="display-name">Display name</Label>
            <Input id="display-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save name"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
