export function placeTask<T extends { status: string; position: number }>(
  task: T,
  status: T["status"],
  position: number,
): T {
  return { ...task, status, position };
}

export function nextPosition(
  column: { id: string; position: number }[],
  beforeId: string | null,
): number {
  const sorted = [...column].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
  if (beforeId === null) {
    const last = sorted[sorted.length - 1];
    return last ? last.position + 1024 : 1024;
  }
  const index = sorted.findIndex((task) => task.id === beforeId);
  if (index < 0) {
    const last = sorted[sorted.length - 1];
    return last ? last.position + 1024 : 1024;
  }
  const next = sorted[index];
  const previous = sorted[index - 1];
  if (!next) return 1024;
  if (!previous) return next.position - 1024;
  return (previous.position + next.position) / 2;
}
