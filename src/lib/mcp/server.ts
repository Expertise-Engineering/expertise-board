import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { hashApiKey } from "@/lib/agents/keys";
import { canSeeProject } from "@/lib/access/access";
import { isWaiting } from "@/lib/board/filters";
import { BoardError, addComment, createTask, resolveProject, updateTask } from "@/lib/board/mutate";
import { errorMessage, isStatus, isUuid, parseAssignee, postgrestIlikeOr } from "@/lib/board/text";
import { createServiceClient } from "@/lib/supabase/service";
import type { Actor, Agent, Project, Status, Task, TaskDependency } from "@/lib/types";

const statusSchema = z.enum(["backlog", "todo", "doing", "review", "done"]);

type Db = SupabaseClient;

export type AgentPrincipal = {
  id: string;
  name: string;
};

export async function authenticateAgent(authorization: string | null): Promise<AgentPrincipal | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match?.[1]) return null;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, revoked_at")
    .eq("key_hash", hashApiKey(match[1]))
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  return { id: data.id as string, name: data.name as string };
}

function text(value: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  return text(errorMessage(error), true);
}

async function projectMap(supabase: Db, tasks: Task[]) {
  const ids = [...new Set(tasks.map((task) => task.project_id))];
  if (ids.length === 0) return new Map<string, Project>();
  const { data, error } = await supabase.from("projects").select("*").in("id", ids);
  if (error) throw new BoardError(error.message);
  return new Map(((data ?? []) as Project[]).map((project) => [project.id, project]));
}

async function dependenciesFor(supabase: Db, taskIds: string[]): Promise<TaskDependency[]> {
  if (taskIds.length === 0) return [];
  const { data, error } = await supabase
    .from("task_dependencies")
    .select("task_id, waits_on_task_id")
    .in("task_id", taskIds);
  if (error) throw new BoardError(error.message);
  return (data ?? []) as TaskDependency[];
}

function presentTask(
  task: Task,
  projects: Map<string, Project>,
  dependencies: TaskDependency[],
  tasks: Task[],
) {
  const project = projects.get(task.project_id);
  return {
    id: task.id,
    project_id: task.project_id,
    project_slug: project?.slug ?? null,
    project_name: project?.name ?? null,
    number: task.number,
    title: task.title,
    description: task.description,
    status: task.status,
    is_human: task.is_human,
    url: task.url,
    tags: task.tags,
    position: task.position,
    assignee_user_id: task.assignee_user_id,
    assignee_agent_id: task.assignee_agent_id,
    waiting: isWaiting(task.id, tasks, dependencies),
    waits_on: dependencies
      .filter((dependency) => dependency.task_id === task.id)
      .map((dependency) => dependency.waits_on_task_id),
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

async function loadTasks(supabase: Db, ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from("tasks").select("*").in("id", ids);
  if (error) throw new BoardError(error.message);
  return (data ?? []) as Task[];
}

export function createExpertiseMcpServer(agent: AgentPrincipal) {
  const server = new McpServer({
    name: "expertise-board",
    version: "1.0.0",
  });
  const actor: Actor = { kind: "agent", id: agent.id, name: agent.name };

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List every regular customer or job project. Executive projects are not visible to agents.",
      inputSchema: {},
    },
    async () => {
      try {
        const supabase = createServiceClient();
        const { data, error } = await supabase
          .from("projects")
          .select("id, name, slug, description, access_class, sort_order, created_at")
          .eq("access_class", "user")
          .order("sort_order", { ascending: true });
        if (error) return failure(error);
        const projects = ((data ?? []) as Project[]).filter((project) => canSeeProject(actor, project.access_class));
        return text({
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            slug: project.slug,
            description: project.description,
            sort_order: project.sort_order,
            created_at: project.created_at,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks. Filter by project slug or id, status, tag, is_human, assignee (user:<uuid>, agent:<uuid>, me, or unassigned), and free text. Pages are applied in the database. next_offset is null on the last page.",
      inputSchema: {
        project: z.string().optional().describe("Project slug or id"),
        status: statusSchema.optional(),
        tag: z.string().optional(),
        is_human: z.boolean().optional(),
        assignee: z.string().optional().describe("user:<uuid>, agent:<uuid>, me, or unassigned"),
        query: z.string().optional().describe("Case-insensitive match against title and description"),
        limit: z.number().int().min(1).max(100).optional().describe("Page size. Defaults to 50."),
        offset: z.number().int().min(0).optional().describe("Rows to skip. Defaults to 0."),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        let projectId: string | null = null;
        if (args.project) {
          projectId = (await resolveProject(supabase, actor, args.project)).id;
        }
        let visibleProjects = projectId ? [projectId] : [];
        if (!projectId) {
          const { data: projectRows, error: projectError } = await supabase
            .from("projects")
            .select("id")
            .eq("access_class", "user");
          if (projectError) return failure(projectError);
          visibleProjects = (projectRows ?? []).map((row) => row.id as string);
        }
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        if (visibleProjects.length === 0) return text({ tasks: [], next_offset: null });
        let assignee = args.assignee;
        if (assignee === "me") assignee = `agent:${agent.id}`;
        let query = supabase.from("tasks").select("*").in("project_id", visibleProjects);
        if (projectId) query = query.eq("project_id", projectId);
        if (args.status) query = query.eq("status", args.status);
        if (typeof args.is_human === "boolean") query = query.eq("is_human", args.is_human);
        if (args.tag) query = query.contains("tags", [args.tag.trim().toLowerCase()]);
        if (assignee === "unassigned") {
          query = query.is("assignee_user_id", null).is("assignee_agent_id", null);
        } else if (assignee) {
          const parsed = parseAssignee(assignee);
          if (parsed.userId) query = query.eq("assignee_user_id", parsed.userId);
          if (parsed.agentId) query = query.eq("assignee_agent_id", parsed.agentId);
        }
        const textFilter = args.query ? postgrestIlikeOr(["title", "description"], args.query) : null;
        if (textFilter) query = query.or(textFilter);
        const { data, error } = await query
          .order("number", { ascending: true })
          .range(offset, offset + limit);
        if (error) return failure(error);
        const page = (data ?? []) as Task[];
        const nextOffset = page.length > limit ? offset + limit : null;
        let tasks = page.slice(0, limit);
        const projects = await projectMap(supabase, tasks);
        const visibleIds = new Set(
          [...projects.values()].filter((project) => canSeeProject(actor, project.access_class)).map((project) => project.id),
        );
        tasks = tasks.filter((task) => visibleIds.has(task.project_id));
        const dependencies = (await dependenciesFor(supabase, tasks.map((task) => task.id))).filter((dependency) =>
          tasks.some((task) => task.id === dependency.waits_on_task_id),
        );
        const blockers = tasks.filter((task) =>
          dependencies.some((dependency) => dependency.waits_on_task_id === task.id),
        );
        const known = [...tasks, ...blockers];
        return text({
          tasks: tasks.map((task) => presentTask(task, projects, dependencies, known)),
          next_offset: nextOffset,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Fetch one task by id, or by project slug/id plus its per-project number, including comments and waits.",
      inputSchema: {
        task_id: z.string().optional(),
        project: z.string().optional().describe("Project slug or id, used with number"),
        number: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        let task: Task | null = null;
        if (args.task_id) {
          if (!isUuid(args.task_id)) return text("task_id must be a uuid.", true);
          const { data, error } = await supabase.from("tasks").select("*").eq("id", args.task_id).maybeSingle();
          if (error) return failure(error);
          task = (data as Task | null) ?? null;
        } else if (args.project && args.number) {
          const project = await resolveProject(supabase, actor, args.project);
          const { data, error } = await supabase
            .from("tasks")
            .select("*")
            .eq("project_id", project.id)
            .eq("number", args.number)
            .maybeSingle();
          if (error) return failure(error);
          task = (data as Task | null) ?? null;
        } else {
          return text("Pass task_id, or project and number.", true);
        }
        if (!task) return text("Task not found.", true);
        const projects = await projectMap(supabase, [task]);
        const project = projects.get(task.project_id);
        if (!project || !canSeeProject(actor, project.access_class)) return text("Task not found.", true);
        const [dependencies, commentsResult, eventsResult] = await Promise.all([
          dependenciesFor(supabase, [task.id]),
          supabase.from("comments").select("*").eq("task_id", task.id).order("created_at", { ascending: true }),
          supabase.from("task_events").select("*").eq("task_id", task.id).order("created_at", { ascending: true }),
        ]);
        if (commentsResult.error) return failure(commentsResult.error);
        if (eventsResult.error) return failure(eventsResult.error);
        const blockers = (await loadTasks(
          supabase,
          dependencies.map((dependency) => dependency.waits_on_task_id),
        )).filter((blocker) => blocker.project_id === task.project_id);
        const visibleDependencies = dependencies.filter((dependency) =>
          blockers.some((blocker) => blocker.id === dependency.waits_on_task_id),
        );
        return text({
          task: presentTask(task, projects, visibleDependencies, [task, ...blockers]),
          comments: commentsResult.data ?? [],
          events: eventsResult.data ?? [],
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task in a project. Agents cannot put new work in Backlog. Default status is todo. Assignee is user:<uuid>, agent:<uuid>, me, or unassigned.",
      inputSchema: {
        project: z.string().describe("Project slug or id"),
        title: z.string(),
        description: z.string().optional(),
        status: statusSchema.optional(),
        is_human: z.boolean().optional(),
        url: z.string().optional(),
        tags: z.array(z.string()).optional(),
        assignee: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        const project = await resolveProject(supabase, actor, args.project);
        const assignee = args.assignee === "me" ? `agent:${agent.id}` : args.assignee;
        const status = args.status && isStatus(args.status) ? (args.status as Status) : "todo";
        const task = await createTask(supabase, actor, {
          projectId: project.id,
          title: args.title,
          description: args.description,
          status,
          isHuman: args.is_human,
          url: args.url,
          tags: args.tags,
          assignee,
        });
        const projects = new Map([[project.id, project]]);
        return text({ task: presentTask(task, projects, [], [task]) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Update a task's title, description, status, human flag, url, tags, or assignee. Agents cannot move Backlog tasks or change status on human tasks. Pass null assignee fields by using assignee \"unassigned\".",
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: statusSchema.optional(),
        is_human: z.boolean().optional(),
        url: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        assignee: z.string().optional().describe("user:<uuid>, agent:<uuid>, me, or unassigned"),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        const assignee = args.assignee === "me" ? `agent:${agent.id}` : args.assignee;
        const task = await updateTask(supabase, actor, {
          id: args.task_id,
          title: args.title,
          description: args.description,
          status: args.status,
          isHuman: args.is_human,
          url: args.url,
          tags: args.tags,
          assignee,
        });
        const projects = await projectMap(supabase, [task]);
        return text({ task: presentTask(task, projects, [], [task]) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a comment on a task. The comment is stamped with this agent.",
      inputSchema: {
        task_id: z.string(),
        body: z.string(),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        const comment = await addComment(supabase, actor, { taskId: args.task_id, body: args.body });
        return text({ comment });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "next_task",
    {
      title: "Take the next task",
      description:
        "Claim the next regular-project Todo task that is not in Backlog, not marked human, not assigned to someone else, and not waiting on unfinished work. Executive projects are skipped. Moves it to Doing, assigns it to this agent, and comments that the agent took it. Optional project slug or id limits the search.",
      inputSchema: {
        project: z.string().optional().describe("Optional project slug or id"),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        let projectId: string | null = null;
        if (args.project) projectId = (await resolveProject(supabase, actor, args.project)).id;
        const { data, error } = await supabase.rpc("claim_next_task", {
          p_agent_id: agent.id,
          p_project_id: projectId,
        });
        if (error) return failure(error);
        if (!data) {
          return text({
            task: null,
            message: "No ready task. Backlog, human tasks, and tasks waiting on unfinished work were skipped.",
          });
        }
        const task = data as Task;
        const projects = await projectMap(supabase, [task]);
        const project = projects.get(task.project_id);
        if (!project || !canSeeProject(actor, project.access_class)) {
          return text({
            task: null,
            message: "No ready task. Backlog, human tasks, executive projects, and tasks waiting on unfinished work were skipped.",
          });
        }
        return text({
          task: presentTask(task, projects, [], [task]),
          message: "Took this task and moved it to Doing.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export type { Agent as ListedAgent };
