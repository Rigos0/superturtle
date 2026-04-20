export interface PreparedSupervisionSnapshot {
  jobId: string;
  subturtleName: string;
  chatId: number;
  sourcePrompt: string;
  preparedAtMs: number;
  snapshotSeq: number;
  conductorSummary: string;
  workerStateJson: string;
  recentEventsJson: string;
  wakeupsJson: string;
  workerResultJson: string;
  statusOutput: string;
  stateExcerpt: string;
  gitLog: string;
  tunnelUrl: string | null;
  prepErrors: string[];
}

const MAX_PER_JOB = 20;
const MAX_TOTAL = 200;

const queue: PreparedSupervisionSnapshot[] = [];
const seqByJob = new Map<string, number>();

function nextSeq(jobId: string): number {
  const next = (seqByJob.get(jobId) || 0) + 1;
  seqByJob.set(jobId, next);
  return next;
}

function countByJob(jobId: string): number {
  let count = 0;
  for (const item of queue) {
    if (item.jobId === jobId) count++;
  }
  return count;
}

export function enqueuePreparedSnapshot(
  input: Omit<PreparedSupervisionSnapshot, "snapshotSeq">
): PreparedSupervisionSnapshot {
  while (countByJob(input.jobId) >= MAX_PER_JOB) {
    const index = queue.findIndex((item) => item.jobId === input.jobId);
    if (index === -1) break;
    queue.splice(index, 1);
  }

  while (queue.length >= MAX_TOTAL) {
    queue.shift();
  }

  const snapshot: PreparedSupervisionSnapshot = {
    ...input,
    snapshotSeq: nextSeq(input.jobId),
  };
  queue.push(snapshot);
  return snapshot;
}

export function dequeuePreparedSnapshot(): PreparedSupervisionSnapshot | undefined {
  return queue.shift();
}

export function getPreparedSnapshotCount(): number {
  return queue.length;
}

export function clearPreparedSnapshots(): void {
  queue.length = 0;
  seqByJob.clear();
}
