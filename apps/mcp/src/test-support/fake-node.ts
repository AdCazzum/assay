import type { Job, Manifest, ProviderRecord, Reputation } from '@assay/core';
import type { AssayNodePort } from '../node-port.js';

/**
 * Test double for `AssayNodePort`. This is NOT `@assay/core`'s
 * `createAssayNode` (that lands in a sibling issue, #20/#21): it returns
 * pre-programmed fixtures instead of resolving ENS, paying on Hedera, or
 * running a capability, so the MCP tool layer can be unit tested without any
 * of that. Named obviously as a fake so it is never mistaken for the real
 * node.
 */
export class FakeAssayNode implements AssayNodePort {
  readonly discoverCalls: string[] = [];
  readonly payAndCallCalls: Array<{ capabilityId: string; request: unknown }> = [];
  readonly challengeCalls: Array<{ jobId: string; claimKey: string }> = [];
  readonly rateCalls: Array<{ jobId: string; satisfied: boolean; comment?: string }> = [];

  providerByCapability = new Map<string, ProviderRecord>();
  jobsById = new Map<string, Job>();

  /** If set, `discover` throws this instead of looking up `providerByCapability`. */
  discoverError?: Error;
  /** If set, `payAndCall` throws this instead of returning a job. */
  payAndCallError?: Error;
  /** If set, `challenge` throws this instead of returning a job. */
  challengeError?: Error;
  /** If set, `rate` throws this instead of returning a job. */
  rateError?: Error;

  async discover(capabilityId: string): Promise<ProviderRecord> {
    this.discoverCalls.push(capabilityId);
    if (this.discoverError) throw this.discoverError;
    const record = this.providerByCapability.get(capabilityId);
    if (!record) {
      throw new Error(`FakeAssayNode: no provider fixture registered for "${capabilityId}"`);
    }
    return record;
  }

  async payAndCall(capabilityId: string, request: unknown): Promise<Job> {
    this.payAndCallCalls.push({ capabilityId, request });
    if (this.payAndCallError) throw this.payAndCallError;
    const job = this.jobsById.get(`${capabilityId}:${String(request)}`);
    if (!job) {
      throw new Error(
        `FakeAssayNode: no job fixture registered for "${capabilityId}:${String(request)}"`,
      );
    }
    return job;
  }

  async challenge(jobId: string, claimKey: string): Promise<Job> {
    this.challengeCalls.push({ jobId, claimKey });
    if (this.challengeError) throw this.challengeError;
    const job = this.jobsById.get(jobId);
    if (!job) throw new Error(`FakeAssayNode: no job fixture registered for "${jobId}"`);
    return job;
  }

  async rate(jobId: string, satisfied: boolean, comment?: string): Promise<Job> {
    this.rateCalls.push({ jobId, satisfied, comment });
    if (this.rateError) throw this.rateError;
    const job = this.jobsById.get(jobId);
    if (!job) throw new Error(`FakeAssayNode: no job fixture registered for "${jobId}"`);
    return job;
  }
}

export const FIXTURE_MANIFEST: Manifest = {
  capabilityId: 'rugscore',
  description: 'Scores ERC-20 rug-pull risk from live token signals.',
  priceHbar: 5,
  endpoint: 'https://provider.example/rugscore',
  bondRef: 'bond-1',
  verifierHash: '0xverifierhash',
};

export const FIXTURE_REPUTATION: Reputation = {
  score: 92,
  jobs: 14,
  slashes: 1,
  bondHbar: 50,
};

export const FIXTURE_PROVIDER_RECORD: ProviderRecord = {
  name: 'rugscore.assay.eth',
  manifest: FIXTURE_MANIFEST,
  reputation: FIXTURE_REPUTATION,
};

export const FIXTURE_JOB: Job = {
  jobId: 'job-1',
  provider: 'rugscore.assay.eth',
  request: '0xTOKEN',
  paymentTx: '0.0.9695801@1234567890.000000001',
  result: { score: 12 },
  claims: [
    { k: 'top10Pct', v: 62, atBlock: 1000 },
    { k: 'liquidityUsd', v: 4200, atBlock: 1000 },
    { k: 'hasActiveMintRole', v: true, atBlock: 1000 },
  ],
  status: 'served',
};
