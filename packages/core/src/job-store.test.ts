import { describe, expect, it } from 'vitest';
import {
  createJobStore,
  IllegalJobTransitionError,
  UnknownJobError,
  type JobStore,
} from './job-store.js';
import type { Claim } from './types.js';

const claims: Claim[] = [{ k: 'hasActiveMintRole', v: false, atBlock: 42 }];

function seedJob(store: JobStore) {
  return store.create({
    provider: 'rugscore.assay.eth',
    request: '0xTOKEN',
    paymentTx: '0xpay1',
    result: { score: 12 },
    claims,
  });
}

describe('createJobStore', () => {
  it('creates a job already in served status, with the claims it was given', () => {
    const store = createJobStore();
    const job = seedJob(store);

    expect(job.status).toBe('served');
    expect(job.claims).toEqual(claims);
    expect(job.verdict).toBeUndefined();
    expect(store.get(job.jobId)).toEqual(job);
    expect(store.has(job.jobId)).toBe(true);
  });

  it('moves served -> challenged -> slashed', () => {
    const store = createJobStore();
    const job = seedJob(store);

    const challenged = store.transition(job.jobId, 'challenged');
    expect(challenged.status).toBe('challenged');

    const slashed = store.transition(job.jobId, 'slashed', {
      verdict: { valid: false, badClaim: 'hasActiveMintRole' },
    });
    expect(slashed.status).toBe('slashed');
    expect(slashed.verdict).toEqual({ valid: false, badClaim: 'hasActiveMintRole' });
  });

  it('moves served -> challenged -> settled', () => {
    const store = createJobStore();
    const job = seedJob(store);

    store.transition(job.jobId, 'challenged');
    const settled = store.transition(job.jobId, 'settled', { verdict: { valid: true } });

    expect(settled.status).toBe('settled');
    expect(settled.verdict).toEqual({ valid: true });
  });

  it('rejects an illegal transition (served -> slashed, skipping challenged) instead of silently ignoring it', () => {
    const store = createJobStore();
    const job = seedJob(store);

    expect(() => store.transition(job.jobId, 'slashed')).toThrow(IllegalJobTransitionError);
    // the rejected attempt must not have mutated the job
    expect(store.get(job.jobId).status).toBe('served');
  });

  it('rejects a transition back to served', () => {
    const store = createJobStore();
    const job = seedJob(store);
    store.transition(job.jobId, 'challenged');

    expect(() => store.transition(job.jobId, 'served')).toThrow(IllegalJobTransitionError);
  });

  it('rejects any transition out of a terminal state (slashed, settled)', () => {
    const store = createJobStore();

    const slashedJob = seedJob(store);
    store.transition(slashedJob.jobId, 'challenged');
    store.transition(slashedJob.jobId, 'slashed');
    expect(() => store.transition(slashedJob.jobId, 'settled')).toThrow(IllegalJobTransitionError);
    expect(() => store.transition(slashedJob.jobId, 'challenged')).toThrow(
      IllegalJobTransitionError,
    );

    const settledJob = seedJob(store);
    store.transition(settledJob.jobId, 'challenged');
    store.transition(settledJob.jobId, 'settled');
    expect(() => store.transition(settledJob.jobId, 'slashed')).toThrow(IllegalJobTransitionError);
  });

  it('names the failing transition on the error', () => {
    const store = createJobStore();
    const job = seedJob(store);

    try {
      store.transition(job.jobId, 'settled');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalJobTransitionError);
      const e = err as IllegalJobTransitionError;
      expect(e.jobId).toBe(job.jobId);
      expect(e.from).toBe('served');
      expect(e.to).toBe('settled');
      expect(e.allowed).toEqual(['challenged']);
    }
  });

  it('throws UnknownJobError for get/transition on a job id that was never created', () => {
    const store = createJobStore();

    expect(() => store.get('nope')).toThrow(UnknownJobError);
    expect(() => store.transition('nope', 'challenged')).toThrow(UnknownJobError);
  });

  it('returns independent copies, so mutating a fetched job cannot bypass the state machine', () => {
    const store = createJobStore();
    const job = seedJob(store);

    const fetched = store.get(job.jobId);
    fetched.status = 'slashed';

    expect(store.get(job.jobId).status).toBe('served');
  });

  it('lists every job created in that store, and each store instance is independent', () => {
    const storeA = createJobStore();
    const storeB = createJobStore();

    const a1 = seedJob(storeA);
    const a2 = seedJob(storeA);
    seedJob(storeB);

    expect(storeA.list().map((j) => j.jobId).sort()).toEqual([a1.jobId, a2.jobId].sort());
    expect(storeA.list()).toHaveLength(2);
    // each store has its own id sequence and its own jobs map: storeB never
    // sees storeA's second job even though ids can coincide across instances
    expect(storeB.list()).toHaveLength(1);
    expect(storeA.has(a1.jobId)).toBe(true);
    expect(storeA.has(a2.jobId)).toBe(true);
  });
});
