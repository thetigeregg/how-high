import { logger } from "./logger.js";

// Measuring a route can take minutes, so it runs in the background and
// reports how far it has got. Jobs live in memory only: one lost to a restart
// has to be started again, which keeps half-made entries out of the database.

export interface Progress {
  /** What is happening now, in a few words. */
  stage: string;
  /** Pieces finished and pieces in all, when the work comes in pieces. */
  done?: number;
  total?: number;
}

/** Handed to a task so it can say how far it has got and find out whether it was canceled. */
export interface JobControls {
  report: (progress: Progress) => void;
  canceled: () => boolean;
}

/** Thrown inside a task to stop it once it sees it has been canceled. */
export class Canceled extends Error {
  constructor() {
    super("canceled");
  }
}

export interface Job {
  id: number;
  /** Which sidebar list the result belongs to. */
  kind: "hike" | "route";
  label: string;
  /** The entry being measured again, or null when this adds a new one. */
  reanalysisOf: number | null;
  state: "queued" | "running" | "done" | "failed";
  stage: string;
  done: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** The entry that resulted, once done. */
  analysisId: number | null;
}

interface Entry {
  job: Job;
  task: (controls: JobControls) => Promise<number>;
  canceled: boolean;
}

/** Finished jobs stay listed this long, so a page that polls is sure to see how they ended. */
const KEEP_FINISHED_MS = 60_000;

const entries: Entry[] = [];
let nextId = 1;
let running = false;

const finished = (job: Job) => job.state === "done" || job.state === "failed";

function prune() {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { job } = entries[i];
    // A failure stays until it is dismissed: its reason has to be read by someone.
    if (job.state === "done" && job.finishedAt && Date.parse(job.finishedAt) < cutoff) entries.splice(i, 1);
  }
}

/** One at a time: measuring is heavy on the processor, and the map servers limit how fast they may be asked. */
async function pump() {
  if (running) return;
  running = true;
  for (let entry = entries.find((e) => e.job.state === "queued"); entry; entry = entries.find((e) => e.job.state === "queued")) {
    const { job } = entry;
    const current = entry;
    job.state = "running";
    job.stage = "Starting";
    job.startedAt = new Date().toISOString();
    try {
      job.analysisId = await entry.task({
        report: ({ stage, done, total }) => {
          job.stage = stage;
          if (done !== undefined) job.done = done;
          if (total !== undefined) job.total = total;
        },
        canceled: () => current.canceled,
      });
      job.state = "done";
      job.stage = "Done";
    } catch (err) {
      if (err instanceof Canceled) {
        entries.splice(entries.indexOf(entry), 1);
        continue;
      }
      logger.error({ job: job.id, err }, "background job failed");
      job.state = "failed";
      job.error = (err as Error).message;
    }
    job.finishedAt = new Date().toISOString();
  }
  running = false;
}

/** Queues a task and returns its job at once. The task resolves to the id of the entry it made or re-measured. */
export function enqueue(
  info: Pick<Job, "kind" | "label" | "reanalysisOf">,
  task: (controls: JobControls) => Promise<number>,
): Job {
  const job: Job = {
    ...info,
    id: nextId++,
    state: "queued",
    stage: "Queued",
    done: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    analysisId: null,
  };
  entries.push({ job, task, canceled: false });
  // Started on the next turn, so the caller gets the job back as queued before any work begins.
  setImmediate(() => void pump());
  return job;
}

export function listJobs(): Job[] {
  prune();
  return entries.map((e) => e.job);
}

/** Whether an entry is being measured again right now or is waiting to be. */
export function isBeingReanalyzed(analysisId: number): boolean {
  return entries.some((e) => e.job.reanalysisOf === analysisId && !finished(e.job));
}

/**
 * Removes a job from the list. One that is waiting is dropped; one that is
 * running is asked to stop and goes once it does; one that has finished or
 * failed is simply cleared. Returns false if there is no such job.
 */
export function dismiss(id: number): boolean {
  const index = entries.findIndex((e) => e.job.id === id);
  if (index < 0) return false;
  const entry = entries[index];
  if (entry.job.state === "running") {
    entry.canceled = true;
    entry.job.stage = "Stopping";
  } else {
    entries.splice(index, 1);
  }
  return true;
}

/** For tests: resolves once nothing is queued or running. */
export async function idle(): Promise<void> {
  while (entries.some((e) => !finished(e.job))) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** For tests: forgets every job. */
export function reset() {
  entries.length = 0;
}
