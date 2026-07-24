/**
 * The in-memory job store: the off-chain job lifecycle from SPEC.md §5, §7.
 * Persistence beyond process memory is a deliberate scope cut (SPEC.md §17),
 * not an oversight.
 *
 * A job is only ever created already `served`: SPEC.md §12 puts the payment
 * gate in `serve()` (see node.ts), and a job that failed the gate never
 * reaches this store at all. So `served` is the one legal starting state.
 * From there a job can take one of two forward paths:
 *
 *  - **Adversarial**: `served -> challenged` (see `node.ts`'s `challenge()`),
 *    then `challenged -> slashed` or `challenged -> settled` depending on the
 *    verifier's verdict (`node.ts`'s `settle()`).
 *  - **Non-adversarial**: `served -> settled` directly, with no `verdict`.
 *    This is the close-out for a served job nobody disputed (`apps/mcp`'s
 *    `rate` tool surfaced this gap: without it, an accepted-and-rated job had
 *    no terminal status and stayed `served` forever, which is not honest —
 *    "nobody challenged this" is itself a real, terminal fact about the job).
 *    Reusing `settled` rather than inventing a fifth status is deliberate:
 *    both paths mean the same thing at the state-machine level ("closed,
 *    provider not slashed"); `verdict` being present or absent is exactly
 *    what already distinguishes "the challenge failed" from "nobody
 *    challenged it".
 *
 * `slashed` and `settled` are both terminal. Every other move (skipping
 * straight to `slashed` without a challenge, moving out of a terminal state,
 * moving "backwards") is rejected with a named, catchable error instead of
 * being silently ignored.
 */

import type { Job, JobStatus } from './types.js';

const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  served: ['challenged', 'settled'],
  challenged: ['slashed', 'settled'],
  slashed: [],
  settled: [],
};

/** Thrown when a job id was never created (or was created by a different store instance). */
export class UnknownJobError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Unknown job "${jobId}".`);
    this.name = 'UnknownJobError';
    this.jobId = jobId;
  }
}

/** Thrown when a transition is not reachable from the job's current status. */
export class IllegalJobTransitionError extends Error {
  readonly jobId: string;
  readonly from: JobStatus;
  readonly to: JobStatus;
  readonly allowed: readonly JobStatus[];

  constructor(jobId: string, from: JobStatus, to: JobStatus) {
    const allowed = ALLOWED_TRANSITIONS[from];
    const allowedText = allowed.length > 0 ? allowed.join(', ') : '(none: terminal status)';
    super(
      `Job "${jobId}" cannot move from "${from}" to "${to}". Allowed from "${from}": ${allowedText}.`,
    );
    this.name = 'IllegalJobTransitionError';
    this.jobId = jobId;
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/** Everything needed to create a job, i.e. everything but `jobId` (assigned by the store) and `status` (always `served`, see above). */
export type CreateJobInput = Omit<Job, 'jobId' | 'status' | 'verdict'>;

export interface JobStore {
  /** Creates a job already in `served` status. This is the only way a job enters the store. */
  create(input: CreateJobInput): Job;
  /** Reads a job by id. Throws `UnknownJobError` if it does not exist. */
  get(jobId: string): Job;
  /** True iff `jobId` was created in this store. */
  has(jobId: string): boolean;
  /** All jobs created in this store, in creation order. */
  list(): Job[];
  /**
   * Moves `jobId` to `to`, merging `patch` (e.g. a `verdict`) onto the job as
   * part of the same move. Throws `UnknownJobError` if `jobId` does not
   * exist, or `IllegalJobTransitionError` if `to` is not reachable from the
   * job's current status.
   */
  transition(jobId: string, to: JobStatus, patch?: Partial<Pick<Job, 'verdict'>>): Job;
}

/** Creates an empty, in-memory job store. Each instance has its own job-id sequence and its own jobs. */
export function createJobStore(): JobStore {
  const jobs = new Map<string, Job>();
  let seq = 0;

  function requireJob(jobId: string): Job {
    const job = jobs.get(jobId);
    if (!job) {
      throw new UnknownJobError(jobId);
    }
    return job;
  }

  return {
    create(input) {
      seq += 1;
      const jobId = `job-${seq}`;
      const job: Job = { ...input, jobId, status: 'served' };
      jobs.set(jobId, job);
      return { ...job };
    },

    get(jobId) {
      return { ...requireJob(jobId) };
    },

    has(jobId) {
      return jobs.has(jobId);
    },

    list() {
      return [...jobs.values()].map((job) => ({ ...job }));
    },

    transition(jobId, to, patch) {
      const job = requireJob(jobId);
      const allowed = ALLOWED_TRANSITIONS[job.status];
      if (!allowed.includes(to)) {
        throw new IllegalJobTransitionError(jobId, job.status, to);
      }
      const updated: Job = { ...job, ...patch, status: to };
      jobs.set(jobId, updated);
      return { ...updated };
    },
  };
}
