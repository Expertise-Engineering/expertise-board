# Expertise Board

Internal kanban for [Expertise Engineering](https://github.com/Expertise-Engineering). One board for about fifteen engineers and the agents working beside them. Regular teammates share every regular project. Executive projects stay with executives.

**All projects** shows every customer on one board. A project is one customer or one job. Tasks sit in **Backlog**, **Todo**, **Doing**, **Review**, or **Done**. People park work in Backlog. Agents do not claim Backlog cards, cards marked human, or cards still waiting on unfinished work in the same project.

This is an original app. It is not a copy of Kanzo.

## Stack

- Next.js (App Router) and TypeScript
- Tailwind CSS and shadcn/ui
- Supabase Auth (magic link), Postgres, and Realtime
- A stateless [MCP](https://modelcontextprotocol.io) Streamable HTTP endpoint for agents
- Netlify, via the built-in Next.js runtime

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

The dev server prints a local URL. Sign-in and the board need the env vars below and the SQL migration applied to a Supabase project. Without those, the login page explains what is missing and the production build still succeeds.

```bash
npm test
npm run build
```

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser and server | Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser and server | Publishable key. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is accepted instead |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Agent MCP. Never expose this to the browser |

`NEXT_PUBLIC_*` values are inlined when Next builds. Set them before `npm run build` and before a Netlify build. The service role key is read on the server at request time.

Do not commit `.env.local`.

## Database

SQL lives in [`supabase/migrations`](supabase/migrations). Apply every file, in order, from the Supabase SQL editor, or with the CLI after `supabase link`:

```bash
supabase db push
```

`20261108001000_initial_schema.sql` creates the board. `20261108180000_access_classes.sql` adds roles, project class, and the stricter row policies. Apply both. The access migration is safe to run when Cory's auth user is not in the database yet: it still records `cm@exp-eng.com` as an executive, and the signup trigger keeps that role when the account appears.

The initial migration:

- Creates profiles, agents, projects, tasks, comments, task events, and task dependencies
- Rejects any `auth.users` email that is not `@exp-eng.com`, and creates a profile whose display name is the email local-part
- Enables RLS. The first version let every signed-in user read and write every row. The access migration replaces those policies
- Publishes `tasks`, `comments`, `projects`, and `task_events` to `supabase_realtime`
- Adds `next_task_number(project_id)` and a service-role-only `claim_next_task` helper

No project seed data is included. The access migration does seed one executive.

## Access

Two classes of people, and two classes of projects. The database values are `executive` and `user` (regular).

Role and removed status live in `public.directory`, keyed by email. `profiles.role` and `profiles.revoked_at` mirror that row for operators. Authenticated clients are not granted `SELECT` on `profiles.role`. Nothing about access is stored in `user_metadata` or `raw_user_meta_data`, and row level security does not read those claims.

- An executive can see every project and task, change a project's class, and open **Admin**.
- A regular teammate can see and work on every regular project. They cannot open Admin or an executive project. A direct link to an executive project is a not-found page, including its tasks, comments, and waits-on links.
- Projects that already exist, and projects someone creates, are regular unless an executive marks them executive. A regular user cannot create an executive project or change a project's class. Moving a card does not change which project it belongs to.
- Agents are not executives. They have no admin access. `list_projects`, `list_tasks`, `get_task`, and `claim_next_task` only see regular projects. Agents still cannot take Backlog cards or cards marked human.
- Anyone with an `@exp-eng.com` email can still sign in. If they are not already on the directory, the signup trigger adds them as a regular user.
- **Admin** (executives only) lists people and projects. Add an email and a role before that person signs in, change a role, or remove someone. Remove is reversible: it sets `revoked_at` and keeps their history. Their next request is signed out, and the company-email rule will not let them back in until an executive restores them.
- The last active executive cannot be demoted or removed.

Row level security enforces the same split on projects, tasks, comments, task events, dependencies, agents, profiles, and the directory. A removed person cannot read executive rows or regular ones. Realtime `DELETE` events are not filtered by row security, so regular browsers subscribe only to the regular projects they can already see. Comments and task events store `project_id` for that filter. Helper functions that bypass row security live in the unexposed `private` schema. There is no `security definer` function in `public`, and there are no views.

In the Supabase dashboard, add your site to **Authentication → URL configuration**:

- Site URL: `http://localhost:3000` locally, and the Netlify URL in production
- Redirect URLs: `http://localhost:3000/auth/callback` and `https://<your-site>/auth/callback`

If `next dev` is started on another port, use that origin in both values. The app sends that origin as `emailRedirectTo`.

Magic Link and Confirm signup emails must not use `{{ .ConfirmationURL }}`. That URL verifies the one-time token on the first GET, so Outlook Safe Links and other mail scanners use the link before the person who asked for it can sign in. Point both templates at this app:

```html
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">Sign in</a></p>
```

A GET or HEAD of that URL only shows a confirmation page. The token is checked when the person chooses **Sign in**, including from a different browser than the one that requested the link. `type=magiclink` and `type=signup` are accepted too.

Links that still arrive as `?code=` are the older PKCE redirect. Those are exchanged only after the same confirmation, and only the browser that requested the link has the verifier.

## How people sign in

1. Open `/login`.
2. Enter an `@exp-eng.com` address.
3. Open the magic link and choose **Sign in**.

The domain is checked in three places: the login form, the sign-in confirmation (`/auth/callback`), and a `BEFORE INSERT OR UPDATE` trigger on `auth.users`. That trigger also rejects an email an executive has removed. An expired or already-used link returns to `/login` with its own message. The Next.js 16 proxy in `src/proxy.ts` (the successor to middleware) refreshes the session, sends signed-out visitors to `/login`, and signs out a removed person on the next request. `/api/mcp` is not behind that login redirect.

What you see depends on your role. Executives get an **Admin** link in the sidebar. Click your name in the sidebar to change the display name.

**All projects** (`/`) is where you land. It is one board of every customer you can see, in the same columns, with the same filters — including Assignee, so one person or agent can be seen across those customers. Leave Assignee on Anyone to see that whole set. Each card names its customer. An executive card also says Executive. Moving a card changes its column and leaves it on that project. A new task asks which project it belongs to. The sidebar also opens any single project. Executives can mark a project executive when they create it or edit it.

On a board, press `N` to add a task. Click or tap a card to edit it. With a mouse, drag a card between columns. On a phone, drag the Move handle on the left of the card — a finger drag on the card itself scrolls the board. Changing Column inside the card moves it too. Realtime updates the board when tasks, comments, projects, or activity change.

## Agents and MCP

Agents are not shared human logins. On **Agents**, add one, and copy the raw API key when it is shown. The database stores only the SHA-256 hex of that key. Revoke stops the key. Delete removes the agent from the directory.

Active teammates can read those hashes. A removed person cannot. The raw key is never stored, and a 256-bit key is not recoverable from the hash, but do not treat the hash column as a secret from coworkers who can still open the board.

The endpoint is stateless Streamable HTTP and answers with JSON:

```text
POST https://<your-site>/api/mcp
Authorization: Bearer eb_...
Accept: application/json, text/event-stream
Content-Type: application/json
```

Cursor, or another MCP client, can use:

```json
{
  "mcpServers": {
    "expertise-board": {
      "url": "https://<your-site>/api/mcp",
      "headers": {
        "Authorization": "Bearer eb_your_agent_key"
      }
    }
  }
}
```

A missing, unknown, or revoked key returns HTTP 401. The service role key stays on the server; the browser never sees it. Every write is stamped with that agent's id.

Tools:

| Tool | What it does |
| --- | --- |
| `list_projects` | Every regular project. Executive projects are omitted |
| `list_tasks` | Filter by project, status, tag, `is_human`, assignee (`user:<uuid>`, `agent:<uuid>`, `me`, `unassigned`), and text. Executive projects are omitted |
| `get_task` | One task by id, or by project plus number, with comments and events |
| `create_task` | Create a task. Agents cannot create Backlog cards |
| `update_task` | Status, assignee, human flag, url, tags, title, description. Agents cannot move Backlog cards or change status on human cards |
| `add_comment` | Comment as the agent |
| `next_task` | Claim the next regular-project Todo that is not human, not assigned to someone else, and not waiting on unfinished work. Moves it to Doing and comments “Took this task.” Executive projects are skipped. Optional `project` limits the search |

## Netlify

`netlify.toml` sets `npm run build`, publishes `.next`, and pins Node 22. Netlify detects Next.js and runs it with the `@netlify/next` runtime, so `@netlify/plugin-nextjs` is not required.

1. Import this repository in Netlify.
2. Set the three environment variables before the first production build.
3. Add the deployed origin and `/auth/callback` to the Supabase redirect allow list, and point the Magic Link and Confirm signup templates at `/auth/callback?token_hash={{ .TokenHash }}&type=email`.
4. Apply the migration if it is not on the linked database yet.

## License

[MIT](LICENSE)
