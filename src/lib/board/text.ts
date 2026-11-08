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

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    if (error.message.includes("agents_name_key") || error.message.includes("agents_name_unique")) {
      return "An agent with that name already exists.";
    }
    if (error.message.includes("projects_slug")) {
      return "A project with that name is already on the board.";
    }
    if (error.message.includes("cycle")) {
      return "That wait would create a cycle.";
    }
    if (error.message.includes("same project")) {
      return "A task can only wait on another task in the same project.";
    }
    return error.message;
  }
  return "Something went wrong.";
}
