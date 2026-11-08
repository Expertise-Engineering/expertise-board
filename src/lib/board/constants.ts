import type { Status } from "@/lib/types";

export const STATUS_META: Record<Status, { label: string; hint: string }> = {
  backlog: {
    label: "Backlog",
    hint: "Parked for people. Agents do not pick these up.",
  },
  todo: {
    label: "Todo",
    hint: "Ready. Agents may claim these.",
  },
  doing: {
    label: "Doing",
    hint: "Someone is on it.",
  },
  review: {
    label: "Review",
    hint: "Needs a look before it is done.",
  },
  done: {
    label: "Done",
    hint: "Finished work.",
  },
};

export const STATUS_ORDER: Status[] = ["backlog", "todo", "doing", "review", "done"];
