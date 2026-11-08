# Expertise Board

Internal kanban for [Expertise Engineering](https://github.com/Expertise-Engineering). One shared board for about fifteen engineers and the agents working beside them. The point is to see who is doing what, not to wall projects off from each other.

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

SQL lives in [`supabase/migrations/20261108001000_initial_schema.sql`](supabase/migrations/20261108001000_initial_schema.sql). Apply it from the Supabase SQL editor, or with the CLI after `supabase link`:

```bash
supabase db push
```

The migration:

- Creates profiles, agents, projects, tasks, comments, task events, and task dependencies
- Rejects any `auth.users` email that is not `@exp-eng.com`, and creates a profile whose display name is the email local-part
- Enables RLS. Signed-in users can select, insert, update, and delete every row. Anonymous access is revoked
- Publishes `tasks`, `comments`, `projects`, and `task_events` to `supabase_realtime`
- Adds `next_task_number(project_id)` and a service-role-only `claim_next_task` helper

No seed data is included.

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

The domain is checked in three places: the login form, the sign-in confirmation (`/auth/callback`), and a `BEFORE INSERT OR UPDATE` trigger on `auth.users`. An expired or already-used link returns to `/login` with its own message. The Next.js 16 proxy in `src/proxy.ts` (the successor to middleware) refreshes the session and sends signed-out visitors to `/login`. `/api/mcp` is not behind that login redirect.

Everyone who is signed in can see and edit the whole board. Click your name in the sidebar to change the display name.

**All projects** (`/`) is where you land. It is one board of every customer's tasks, in the same columns, with the same filters — including Assignee, so one person or agent can be seen across every customer. Leave Assignee on Anyone to see the whole company. Each card names its customer. Moving a card changes its column and leaves it on that project. A new task asks which project it belongs to. The sidebar also opens any single project.

On a board, press `N` to add a task. Click or tap a card to edit it. With a mouse, drag a card between columns. On a phone, drag the Move handle on the left of the card — a finger drag on the card itself scrolls the board. Changing Column inside the card moves it too. Realtime updates the board when tasks, comments, projects, or activity change.

## Agents and MCP

Agents are not shared human logins. On **Agents**, create one, and copy the raw API key when it is shown. The database stores only the SHA-256 hex of that key. Revoke stops the key. Delete removes the agent from the directory.

Signed-in teammates can read those hashes. The board is shared on purpose: row security allows every authenticated person to read and write every table, including `agents`. The raw key is never stored, and a 256-bit key is not recoverable from the hash, but do not treat the hash column as a secret from coworkers.

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
| `list_projects` | Every project |
| `list_tasks` | Filter by project, status, tag, `is_human`, assignee (`user:<uuid>`, `agent:<uuid>`, `me`, `unassigned`), and text |
| `get_task` | One task by id, or by project plus number, with comments and events |
| `create_task` | Create a task. Agents cannot create Backlog cards |
| `update_task` | Status, assignee, human flag, url, tags, title, description. Agents cannot move Backlog cards or change status on human cards |
| `add_comment` | Comment as the agent |
| `next_task` | Claim the next Todo that is not human, not assigned to someone else, and not waiting on unfinished work. Moves it to Doing and comments “Took this task.” Optional `project` limits the search |

## Netlify

`netlify.toml` sets `npm run build`, publishes `.next`, and pins Node 22. Netlify detects Next.js and runs it with the `@netlify/next` runtime, so `@netlify/plugin-nextjs` is not required.

1. Import this repository in Netlify.
2. Set the three environment variables before the first production build.
3. Add the deployed origin and `/auth/callback` to the Supabase redirect allow list, and point the Magic Link and Confirm signup templates at `/auth/callback?token_hash={{ .TokenHash }}&type=email`.
4. Apply the migration if it is not on the linked database yet.

## License

[MIT](LICENSE)
