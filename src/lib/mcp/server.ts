import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { hashApiKey } from "@/lib/agents/keys";
import { isWaiting } from "@/lib/board/filters";
import { BoardError, addComment, createTask, resolveProject, updateTask } from "@/lib/board/mutate";
import { errorMessage, isStatus, isUuid, parseAssignee } from "@/lib/board/text";
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
  return text(error instanceof BoardError ? error.message : errorMessage(error), true);
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
      description: "List every customer or job project on Expertise Board.",
      inputSchema: {},
    },
    async () => {
      try {
        const supabase = createServiceClient();
        const { data, error } = await supabase
          .from("projects")
          .select("id, name, slug, description, sort_order, created_at")
          .order("sort_order", { ascending: true });
        if (error) return failure(error);
        return text({ projects: data ?? [] });
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
        "List tasks. Filter by project slug or id, status, tag, is_human, assignee (user:<uuid>, agent:<uuid>, me, or unassigned), and free text.",
      inputSchema: {
        project: z.string().optional().describe("Project slug or id"),
        status: statusSchema.optional(),
        tag: z.string().optional(),
        is_human: z.boolean().optional(),
        assignee: z.string().optional().describe("user:<uuid>, agent:<uuid>, me, or unassigned"),
        query: z.string().optional().describe("Case-insensitive match against title and description"),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        let projectId: string | null = null;
        if (args.project) {
          projectId = (await resolveProject(supabase, args.project)).id;
        }
        let assignee = args.assignee;
        if (assignee === "me") assignee = `agent:${agent.id}`;
        let query = supabase.from("tasks").select("*").limit(300);
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
        const { data, error } = await query.order("number", { ascending: true });
        if (error) return failure(error);
        let tasks = (data ?? []) as Task[];
        const needle = args.query?.trim().toLowerCase();
        if (needle) {
          tasks = tasks.filter((task) =>
            `${task.title}\n${task.description}`.toLowerCase().includes(needle),
          );
        }
        const projects = await projectMap(supabase, tasks);
        const dependencies = await dependenciesFor(supabase, tasks.map((task) => task.id));
        const blockers = await loadTasks(
          supabase,
          [...new Set(dependencies.map((dependency) => dependency.waits_on_task_id))],
        );
        const known = [...tasks, ...blockers];
        return text({
          tasks: tasks.map((task) => presentTask(task, projects, dependencies, known)),
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
          const project = await resolveProject(supabase, args.project);
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
        const [projects, dependencies, commentsResult, eventsResult] = await Promise.all([
          projectMap(supabase, [task]),
          dependenciesFor(supabase, [task.id]),
          supabase.from("comments").select("*").eq("task_id", task.id).order("created_at", { ascending: true }),
          supabase.from("task_events").select("*").eq("task_id", task.id).order("created_at", { ascending: true }),
        ]);
        if (commentsResult.error) return failure(commentsResult.error);
        if (eventsResult.error) return failure(eventsResult.error);
        const blockers = await loadTasks(
          supabase,
          dependencies.map((dependency) => dependency.waits_on_task_id),
        );
        return text({
          task: presentTask(task, projects, dependencies, [task, ...blockers]),
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
        const project = await resolveProject(supabase, args.project);
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
        "Claim the next Todo task that is not in Backlog, not marked human, not assigned to someone else, and not waiting on unfinished work. Moves it to Doing, assigns it to this agent, and comments that the agent took it. Optional project slug or id limits the search.",
      inputSchema: {
        project: z.string().optional().describe("Optional project slug or id"),
      },
    },
    async (args) => {
      try {
        const supabase = createServiceClient();
        let projectId: string | null = null;
        if (args.project) projectId = (await resolveProject(supabase, args.project)).id;
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
