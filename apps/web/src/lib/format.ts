export function formatAt(at: string | null): string {
  if (at === null) return 'no events recorded';
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

export function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function iterationLabel(iteration: number): string {
  return iteration === 0 ? 'I0' : `r${iteration}`;
}

export function displayCitation(recordedPath: string): string {
  return recordedPath.startsWith('/') ? '[host path withheld]' : recordedPath;
}

export function shortTaskId(taskId: string | null): string {
  if (taskId === null) return '—';
  return taskId.length <= 13 ? taskId : `${taskId.slice(0, 13)}…`;
}

export function shaPrefix(sha256: string | null): string {
  if (sha256 === null) return '—';
  return sha256.slice(0, 12);
}
