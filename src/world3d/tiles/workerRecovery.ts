/** Release only jobs owned by the failed worker; preserve newer requests for the same tile. */
export function releaseWorkerJobs(
  worker: number,
  jobs: Map<number, { key: string; worker: number }>,
  pending: Map<string, { id: number }>,
): string[] {
  const released: string[] = [];
  for (const [id, job] of jobs) {
    if (job.worker !== worker) continue;
    jobs.delete(id);
    if (pending.get(job.key)?.id !== id) continue;
    pending.delete(job.key);
    released.push(job.key);
  }
  return released;
}
