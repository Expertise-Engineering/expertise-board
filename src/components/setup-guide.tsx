export function SetupGuide() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-primary uppercase">Expertise Board</p>
      <h1 className="text-4xl font-medium tracking-tight">Connect Supabase before anyone signs in</h1>
      <p className="text-lg leading-relaxed text-muted-foreground">
        This board keeps one shared view of customer work for Expertise Engineering. It does not ship with a
        database of its own. Add the public Supabase URL and a publishable or anon key, apply the SQL migration,
        then restart or rebuild.
      </p>
      <ul className="grid gap-2 text-sm leading-6">
        <li><code className="rounded bg-muted px-1.5 py-0.5">NEXT_PUBLIC_SUPABASE_URL</code></li>
        <li>
          <code className="rounded bg-muted px-1.5 py-0.5">NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>
          {" or "}
          <code className="rounded bg-muted px-1.5 py-0.5">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
        </li>
        <li>
          <code className="rounded bg-muted px-1.5 py-0.5">SUPABASE_SERVICE_ROLE_KEY</code>
          {" stays on the server, for the agent MCP endpoint and for adding an agent."}
        </li>
      </ul>
      <p className="text-sm text-muted-foreground">
        Public keys are read when the app is built. Set them in the environment before <code>npm run build</code> or a Netlify deploy. The README lists the auth redirect URL and the migration path.
      </p>
    </main>
  );
}

export function MissingProfile({ email }: { email: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-4xl font-medium tracking-tight">Your profile is missing</h1>
      <p className="text-lg leading-relaxed text-muted-foreground">
        {email} is signed in, but there is no row in <code>profiles</code>. Apply{" "}
        <code>supabase/migrations</code> so the signup trigger can create profiles, then sign in again.
      </p>
    </main>
  );
}
