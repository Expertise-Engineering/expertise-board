"use client";

import { createContext, useContext } from "react";
import type { Agent, Profile, Project, SessionProfile } from "@/lib/types";

export type Directory = {
  profile: SessionProfile;
  profiles: Profile[];
  agents: Agent[];
  projects: Project[];
};

type BoardContextValue = Directory & {
  openNewProject: () => void;
};

const BoardContext = createContext<BoardContextValue | null>(null);

export function BoardProvider({
  value,
  children,
}: {
  value: BoardContextValue;
  children: React.ReactNode;
}) {
  return <BoardContext value={value}>{children}</BoardContext>;
}

export function useBoard() {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard must be used inside the board shell.");
  return value;
}
