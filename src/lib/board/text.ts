import { STATUSES, type Status } from "../types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "project";
}

export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function normalizeTags(values: string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const pieces = value.split(/[,\s]+/);
    for (const piece of pieces) {
      const tag = piece.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!tag || !TAG_PATTERN.test(tag) || tags.includes(tag)) continue;
      tags.push(tag);
      if (tags.length >= 12) return tags;
    }
  }
  return tags;
}

export function cleanUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("URL must start with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://.");
  }
  return url.toString();
}

export type AssigneeRef = {
  userId: string | null;
  agentId: string | null;
};

export function parseAssignee(value: string | null | undefined): AssigneeRef {
  if (!value || value === "none" || value === "unassigned") {
    return { userId: null, agentId: null };
  }
  if (value.startsWith("user:")) {
    const userId = value.slice(5);
    if (!isUuid(userId)) throw new Error("Assignee user id is not a uuid.");
    return { userId, agentId: null };
  }
  if (value.startsWith("agent:")) {
    const agentId = value.slice(6);
    if (!isUuid(agentId)) throw new Error("Assignee agent id is not a uuid.");
    return { userId: null, agentId: agentId };
  }
  throw new Error("Assignee must be user:<id>, agent:<id>, or unassigned.");
}

export function assigneeValue(userId: string | null, agentId: string | null): string {
  if (userId) return `user:${userId}`;
  if (agentId) return `agent:${agentId}`;
  return "";
}

export function formatStamp(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = match[1] ?? "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] ?? "";
  const minute = match[5] ?? "";
  const monthName = months[month - 1] ?? match[2];
  return `${day} ${monthName} ${year}, ${hour}:${minute} UTC`;
}

/**
 * Build a PostgREST `or` filter that matches any column with ilike.
 * The value is quoted and `%`, `_`, and `\` are escaped so the filter stays one clause.
 */
export function postgrestIlikeOr(columns: readonly string[], raw: string): string | null {
  const cleaned = raw.replace(/["(),]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const escaped = cleaned.replace(/\\/g, "\\\\").replace(/[%_]/g, (char) => `\\${char}`);
  const pattern = `"%${escaped}%"`;
  return columns.map((column) => `${column}.ilike.${pattern}`).join(",");
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (!raw) return "Something went wrong.";
  const mapped = knownConstraintMessage(raw);
  if (mapped) {
    if (mapped !== raw) logDriver(raw);
    return mapped;
  }
  if (looksLikeDriverText(raw)) {
    logDriver(raw);
    return "Something went wrong.";
  }
  return raw;
}

function knownConstraintMessage(raw: string): string | null {
  if (raw.includes("agents_name_key") || raw.includes("agents_name_unique")) {
    return "An agent with that name already exists.";
  }
  if (raw.includes("projects_slug")) return "A project with that name is already on the board.";
  if (/last executive/i.test(raw)) return "The last executive cannot be demoted or removed.";
  if (/cycle/i.test(raw)) return "That wait would create a cycle.";
  if (/same project/i.test(raw)) return "A task can only wait on another task in the same project.";
  if (/schema cache|could not find the function|does not exist/i.test(raw)) {
    return "The database schema is not ready. Apply the SQL migrations, then reload.";
  }
  if (/row-level security|permission denied|42501/i.test(raw)) return "You do not have access to that.";
  return null;
}

function looksLikeDriverText(raw: string): boolean {
  return /violates|duplicate key|PGRST|syntax error|invalid input|JWT|SQLSTATE|\bat\s+\//i.test(raw);
}

function logDriver(raw: string) {
  if (typeof window === "undefined") console.error(raw);
}
