export type Task = {
  id: string;
  label: string;
  duration: number;
  dependencies: string[];
  evidence: string[];
};
export type ScheduledTask = Task & {
  start: number;
  end: number;
  critical: boolean;
};
export function scheduleTasks(tasks: Task[]) {
  const map = new Map(tasks.map((t) => [t.id, t]));
  if (map.size !== tasks.length) throw new Error("Duplicate schedule task ID");
  const done = new Map<string, ScheduledTask>();
  const visiting = new Set<string>();
  function visit(id: string): ScheduledTask {
    const task = map.get(id);
    if (!task) throw new Error(`Missing dependency ${id}`);
    if (visiting.has(id)) throw new Error("Dependency cycle detected");
    if (done.has(id)) return done.get(id)!;
    if (!Number.isFinite(task.duration) || task.duration < 0)
      throw new Error("Invalid task duration");
    visiting.add(id);
    const dependencies = task.dependencies.map(visit);
    const start = Math.max(0, ...dependencies.map((t) => t.end));
    const result = {
      ...task,
      start,
      end: start + task.duration,
      critical: false,
    };
    visiting.delete(id);
    done.set(id, result);
    return result;
  }
  tasks.forEach((t) => visit(t.id));
  const end = Math.max(0, ...[...done.values()].map((t) => t.end));
  function mark(id: string) {
    const task = done.get(id)!;
    if (task.critical) return;
    task.critical = true;
    for (const dep of task.dependencies)
      if (done.get(dep)!.end === task.start) mark(dep);
  }
  for (const task of done.values()) if (task.end === end) mark(task.id);
  return {
    duration: end,
    tasks: [...done.values()].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    ),
    criticalPath: [...done.values()].filter((t) => t.critical).map((t) => t.id),
  };
}
