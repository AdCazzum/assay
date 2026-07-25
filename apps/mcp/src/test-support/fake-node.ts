import {
  assessProvider,
  type Job,
  type Manifest,
  type ProviderRecord,
  type RegisterProgress,
  type Reputation,
} from '@assay/core';
import type {
  AssayNodePort,
  DiscoverResult,
  ProviderListItem,
  RegisterProviderResult,
  VerifyClaimResult,
} from '../node-port.js';

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
  readonly payAndCallCalls: Array<{ capabilityId: string; request: unknown; force?: boolean }> = [];
  readonly challengeCalls: Array<{ jobId: string; claimKey: string }> = [];
  readonly rateCalls: Array<{ jobId: string; satisfied: boolean; comment?: string }> = [];
  readonly verifyClaimCalls: Array<{ jobId: string; claimKey: string }> = [];
  readonly registerProviderCalls: Array<{
    label: string;
    manifest: Omit<Manifest, 'bondRef'>;
    bondHbar: number;
  }> = [];
  listProvidersCalls = 0;
  readonly getJobCalls: string[] = [];
  listJobsCalls = 0;

  providerByCapability = new Map<string, ProviderRecord>();
  jobsById = new Map<string, Job>();
  /** Backing fixture for `listJobs`, separate from `jobsById` (whose keys are sometimes `capabilityId:request`, not always a bare jobId — see `payAndCall` below). */
  jobsList: Job[] = [];

  /** If set, `discover` throws this instead of looking up `providerByCapability`. */
  discoverError?: Error;
  /** If set, `payAndCall` throws this instead of returning a job. */
  payAndCallError?: Error;
  /** If set, `challenge` throws this instead of returning a job. */
  challengeError?: Error;
  /** If set, `rate` throws this instead of returning a job. */
  rateError?: Error;
  /** If set, `verifyClaim` throws this instead of returning a fixture result. */
  verifyClaimError?: Error;
  /** Keyed `${jobId}:${claimKey}`; what `verifyClaim` returns absent `verifyClaimError`. */
  verifyClaimResults = new Map<string, VerifyClaimResult>();
  /** If set, `registerProvider` throws this instead of returning `registerProviderResult`. */
  registerProviderError?: Error;
  registerProviderResult?: RegisterProviderResult;
  /** `registerProvider` invokes its `onProgress` callback once per tick here, in order, before resolving/rejecting. */
  registerProviderProgressTicks: RegisterProgress[] = [];
  /** If set, `listProviders` throws this instead of returning `listProvidersResult`. */
  listProvidersError?: Error;
  listProvidersResult: ProviderListItem[] = [];
  /** If set, `getJob` throws this instead of looking up `jobsById`. */
  getJobError?: Error;

  async discover(capabilityId: string): Promise<DiscoverResult> {
    this.discoverCalls.push(capabilityId);
    if (this.discoverError) throw this.discoverError;
    const record = this.providerByCapability.get(capabilityId);
    if (!record) {
      throw new Error(`FakeAssayNode: no provider fixture registered for "${capabilityId}"`);
    }
    return { provider: record, assessment: assessProvider(record) };
  }

  async payAndCall(capabilityId: string, request: unknown, force?: boolean): Promise<Job> {
    this.payAndCallCalls.push({ capabilityId, request, force });
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

  async verifyClaim(jobId: string, claimKey: string): Promise<VerifyClaimResult> {
    this.verifyClaimCalls.push({ jobId, claimKey });
    if (this.verifyClaimError) throw this.verifyClaimError;
    const result = this.verifyClaimResults.get(`${jobId}:${claimKey}`);
    if (!result) {
      throw new Error(`FakeAssayNode: no verifyClaim fixture registered for "${jobId}:${claimKey}"`);
    }
    return result;
  }

  async registerProvider(
    label: string,
    manifest: Omit<Manifest, 'bondRef'>,
    bondHbar: number,
    onProgress?: (progress: RegisterProgress) => void,
  ): Promise<RegisterProviderResult> {
    this.registerProviderCalls.push({ label, manifest, bondHbar });
    for (const tick of this.registerProviderProgressTicks) onProgress?.(tick);
    if (this.registerProviderError) throw this.registerProviderError;
    if (!this.registerProviderResult) {
      throw new Error('FakeAssayNode: no registerProviderResult fixture registered');
    }
    return this.registerProviderResult;
  }

  async listProviders(): Promise<ProviderListItem[]> {
    this.listProvidersCalls += 1;
    if (this.listProvidersError) throw this.listProvidersError;
    return this.listProvidersResult;
  }

  async getJob(jobId: string): Promise<Job> {
    this.getJobCalls.push(jobId);
    if (this.getJobError) throw this.getJobError;
    const job = this.jobsById.get(jobId);
    if (!job) throw new Error(`FakeAssayNode: no job fixture registered for "${jobId}"`);
    return job;
  }

  async listJobs(): Promise<Job[]> {
    this.listJobsCalls += 1;
    return this.jobsList;
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

/** The real, pure `assessProvider` over `FIXTURE_PROVIDER_RECORD` — not hand-rolled, so it can't drift from what `assessProvider` actually does. */
export const FIXTURE_ASSESSMENT = assessProvider(FIXTURE_PROVIDER_RECORD);

export const FIXTURE_JOB: Job = {
  jobId: 'job-1',
  provider: 'rugscore.assay.eth',
  capabilityId: 'rugscore',
  request: '0xTOKEN',
  paymentTx: '0.0.9695801@1234567890.000000001',
  result: { score: 12 },
  claims: [
    { k: 'liquidityUsd', v: 4200, atBlock: 1000 },
    { k: 'topPoolConcentrationPct', v: 62, atBlock: 1000 },
    { k: 'ageBlocks', v: 500, atBlock: 1000 },
  ],
  status: 'served',
};
