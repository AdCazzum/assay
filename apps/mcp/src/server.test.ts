import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PayDeclinedError, type ProviderAssessment } from '@assay/core';
import { createAssayMcpServer } from './server.js';
import {
  FakeAssayNode,
  FIXTURE_ASSESSMENT,
  FIXTURE_JOB,
  FIXTURE_PROVIDER_RECORD,
} from './test-support/fake-node.js';

/**
 * Wires a fresh `FakeAssayNode` + `Client` <-> `Server` pair over an
 * in-memory transport, so these tests exercise the real MCP request/response
 * path (schema validation included) rather than calling handlers directly.
 */
async function connect(node: FakeAssayNode) {
  const server = createAssayMcpServer(node);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('assay MCP server', () => {
  let node: FakeAssayNode;

  beforeEach(() => {
    node = new FakeAssayNode();
    node.providerByCapability.set('rugscore', FIXTURE_PROVIDER_RECORD);
    node.jobsById.set('rugscore:0xTOKEN', FIXTURE_JOB);
    node.jobsById.set(FIXTURE_JOB.jobId, FIXTURE_JOB);
  });

  it('lists all nine tools with non-empty descriptions', async () => {
    const { client } = await connect(node);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'challenge',
      'discover',
      'get_job',
      'list_jobs',
      'list_providers',
      'pay_and_call',
      'rate',
      'register_provider',
      'verify_claim',
    ]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(40);
    }
  });

  it('marks verify_claim read-only and idempotent, unlike challenge', async () => {
    const { tools } = await (await connect(node)).client.listTools();
    const verifyClaim = tools.find((t) => t.name === 'verify_claim')!;
    const challenge = tools.find((t) => t.name === 'challenge')!;
    expect(verifyClaim.annotations?.readOnlyHint).toBe(true);
    expect(verifyClaim.annotations?.idempotentHint).toBe(true);
    expect(challenge.annotations?.readOnlyHint).toBe(false);
    expect(challenge.annotations?.idempotentHint).toBe(false);
  });

  describe('discover', () => {
    it('calls through to the node and summarizes manifest + reputation', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({ name: 'discover', arguments: { capabilityId: 'rugscore' } });

      expect(node.discoverCalls).toEqual(['rugscore']);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        provider: FIXTURE_PROVIDER_RECORD,
        assessment: FIXTURE_ASSESSMENT,
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('rugscore.assay.eth');
      expect(text).toContain('5 HBAR');
      expect(text).toContain('score 92');
      // the assessment's signals must actually be in the text, generically
      // (not keyed off a hardcoded signal name), since that's the material
      // an agent is supposed to reason over, not just the raw numbers.
      for (const signal of FIXTURE_ASSESSMENT.signals) {
        expect(text).toContain(signal.detail);
      }
    });

    it('rejects a missing capabilityId without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({ name: 'discover', arguments: {} });
      expect(result.isError).toBe(true);
      expect(node.discoverCalls).toEqual([]);
    });

    it('rejects an empty capabilityId without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'discover',
        arguments: { capabilityId: '' },
      });
      expect(result.isError).toBe(true);
      expect(node.discoverCalls).toEqual([]);
    });

    it('surfaces the node error as a readable tool error instead of throwing raw', async () => {
      node.discoverError = new Error('resolver not configured for rugscore.assay.eth');
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'discover',
        arguments: { capabilityId: 'rugscore' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('resolver not configured');
    });
  });

  describe('pay_and_call', () => {
    it('calls through to the node with capabilityId and request', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'pay_and_call',
        arguments: { capabilityId: 'rugscore', request: '0xTOKEN' },
      });

      expect(node.payAndCallCalls).toEqual([{ capabilityId: 'rugscore', request: '0xTOKEN' }]);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(FIXTURE_JOB);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain(FIXTURE_JOB.jobId);
      expect(text).toContain('topPoolConcentrationPct');
    });

    it('rejects a missing request without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'pay_and_call',
        arguments: { capabilityId: 'rugscore' },
      });
      expect(result.isError).toBe(true);
      expect(node.payAndCallCalls).toEqual([]);
    });

    it('forwards force: true through to the node', async () => {
      const { client } = await connect(node);
      await client.callTool({
        name: 'pay_and_call',
        arguments: { capabilityId: 'rugscore', request: '0xTOKEN', force: true },
      });

      expect(node.payAndCallCalls).toEqual([{ capabilityId: 'rugscore', request: '0xTOKEN', force: true }]);
    });

    it('surfaces a PayDeclinedError as a useful, actionable result rather than an opaque failure', async () => {
      const assessment: ProviderAssessment = {
        providerName: 'rugscore.assay.eth',
        priceHbar: 5,
        jobs: 4,
        slashes: 2,
        slashRatio: 0.5,
        unproven: false,
        bondHbar: 50,
        bondToPriceRatio: 10,
        score: 40,
        signals: [
          { key: 'trackRecord', severity: 'concern', detail: '2 of 4 job(s) were slashed (50.0% slash ratio).' },
        ],
      };
      const violations = [assessment.signals[0]];
      node.payAndCallError = new PayDeclinedError(
        'rugscore.assay.eth',
        assessment,
        violations[0].detail,
        violations,
      );
      const { client } = await connect(node);

      const result = await client.callTool({
        name: 'pay_and_call',
        arguments: { capabilityId: 'rugscore', request: '0xTOKEN' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Declined to pay "rugscore.assay.eth"');
      expect(text).toContain('50.0% slash ratio');
      expect(text).toContain('force: true');
      expect(result.structuredContent).toMatchObject({
        declined: true,
        providerName: 'rugscore.assay.eth',
        violations,
      });
    });
  });

  describe('challenge', () => {
    it('calls through to the node with jobId and claimKey', async () => {
      const challenged = { ...FIXTURE_JOB, status: 'slashed' as const, verdict: { valid: false, badClaim: 'topPoolConcentrationPct', reason: 'the top pool concentration was understated' } };
      node.jobsById.set(FIXTURE_JOB.jobId, challenged);
      const { client } = await connect(node);

      const result = await client.callTool({
        name: 'challenge',
        arguments: { jobId: FIXTURE_JOB.jobId, claimKey: 'topPoolConcentrationPct' },
      });

      expect(node.challengeCalls).toEqual([{ jobId: FIXTURE_JOB.jobId, claimKey: 'topPoolConcentrationPct' }]);
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('invalid');
      expect(text).toContain('slashed');
    });

    it('rejects a missing claimKey without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'challenge',
        arguments: { jobId: FIXTURE_JOB.jobId },
      });
      expect(result.isError).toBe(true);
      expect(node.challengeCalls).toEqual([]);
    });
  });

  describe('rate', () => {
    it('calls through to the node with jobId, satisfied and an optional comment', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'rate',
        arguments: { jobId: FIXTURE_JOB.jobId, satisfied: true, comment: 'fast and accurate' },
      });

      expect(node.rateCalls).toEqual([
        { jobId: FIXTURE_JOB.jobId, satisfied: true, comment: 'fast and accurate' },
      ]);
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('satisfied');
    });

    it('rejects a non-boolean satisfied without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'rate',
        arguments: { jobId: FIXTURE_JOB.jobId, satisfied: 'yes' },
      });
      expect(result.isError).toBe(true);
      expect(node.rateCalls).toEqual([]);
    });

    it('accepts a missing optional comment', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'rate',
        arguments: { jobId: FIXTURE_JOB.jobId, satisfied: false },
      });
      expect(result.isError).toBeFalsy();
      expect(node.rateCalls).toEqual([{ jobId: FIXTURE_JOB.jobId, satisfied: false, comment: undefined }]);
    });
  });

  describe('verify_claim', () => {
    it('calls through to the node and reports a true verdict as no action needed', async () => {
      node.verifyClaimResults.set(`${FIXTURE_JOB.jobId}:liquidityUsd`, {
        jobId: FIXTURE_JOB.jobId,
        claimKey: 'liquidityUsd',
        claims: FIXTURE_JOB.claims,
        verdict: { valid: true },
      });
      const { client } = await connect(node);

      const result = await client.callTool({
        name: 'verify_claim',
        arguments: { jobId: FIXTURE_JOB.jobId, claimKey: 'liquidityUsd' },
      });

      expect(node.verifyClaimCalls).toEqual([{ jobId: FIXTURE_JOB.jobId, claimKey: 'liquidityUsd' }]);
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('TRUE');
      expect(text).toContain('liquidityUsd');
      expect(text).toContain('4200');
      expect(text).not.toContain('call `challenge`');
    });

    it('reports a false verdict with the claimed and chain-derived numbers, and points at challenge', async () => {
      node.verifyClaimResults.set(`${FIXTURE_JOB.jobId}:liquidityUsd`, {
        jobId: FIXTURE_JOB.jobId,
        claimKey: 'liquidityUsd',
        claims: FIXTURE_JOB.claims,
        verdict: {
          valid: false,
          badClaim: 'liquidityUsd',
          reason: 'claimed liquidityUsd=4200 at block 1000, but The Graph reports 56.51',
        },
      });
      const { client } = await connect(node);

      const result = await client.callTool({
        name: 'verify_claim',
        arguments: { jobId: FIXTURE_JOB.jobId, claimKey: 'liquidityUsd' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('FALSE');
      expect(text).toContain('4200');
      expect(text).toContain('56.51');
      expect(text).toContain('challenge');
    });

    it('rejects a missing claimKey without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'verify_claim',
        arguments: { jobId: FIXTURE_JOB.jobId },
      });
      expect(result.isError).toBe(true);
      expect(node.verifyClaimCalls).toEqual([]);
    });

    it('surfaces the node error as a readable tool error instead of throwing raw', async () => {
      node.verifyClaimError = new Error('Unknown job "no-such-job"');
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'verify_claim',
        arguments: { jobId: 'no-such-job', claimKey: 'liquidityUsd' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Unknown job');
    });
  });

  describe('register_provider', () => {
    const manifestArgs = {
      capabilityId: 'rugscore',
      description: 'Scores ERC-20 rug-pull risk from live token signals.',
      priceHbar: 5,
      endpoint: 'https://provider.example/rugscore',
      verifierHash: '0xverifierhash',
    };

    it('calls through to the node with label, manifest and bondHbar', async () => {
      node.registerProviderResult = {
        name: 'myagent.assay.eth',
        bondRef: 'bond-42',
        bondTxId: '0.0.1@111.1',
        manifestTxHash: '0xmanifest',
        reputationTxHash: '0xrep',
        reputation: { score: 0, jobs: 0, slashes: 0, bondHbar: 30 },
      };
      const { client } = await connect(node);

      const result = await client.callTool({
        name: 'register_provider',
        arguments: { label: 'myagent', bondHbar: 30, ...manifestArgs },
      });

      expect(node.registerProviderCalls).toEqual([{ label: 'myagent', manifest: manifestArgs, bondHbar: 30 }]);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(node.registerProviderResult);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('myagent.assay.eth');
      expect(text).toContain('bond-42');
    });

    it('rejects a label containing a dot without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'register_provider',
        arguments: { label: 'myagent.assay.eth', bondHbar: 30, ...manifestArgs },
      });
      expect(result.isError).toBe(true);
      expect(node.registerProviderCalls).toEqual([]);
    });

    it('rejects a non-positive bondHbar without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'register_provider',
        arguments: { label: 'myagent', bondHbar: 0, ...manifestArgs },
      });
      expect(result.isError).toBe(true);
      expect(node.registerProviderCalls).toEqual([]);
    });

    it('surfaces the node error as a readable tool error instead of throwing raw', async () => {
      node.registerProviderError = new Error('registerProvider requires "ensParentName"');
      const { client } = await connect(node);
      const result = await client.callTool({
        name: 'register_provider',
        arguments: { label: 'myagent', bondHbar: 30, ...manifestArgs },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('ensParentName');
    });
  });

  describe('list_providers', () => {
    it('reports hits and misses without erroring on the miss', async () => {
      node.listProvidersResult = [
        { name: 'rugscore.assay.eth', outcome: 'ok', provider: FIXTURE_PROVIDER_RECORD, assessment: FIXTURE_ASSESSMENT },
        { name: 'liar.assay.eth', outcome: 'miss', reason: 'resolver not configured for liar.assay.eth' },
      ];
      const { client } = await connect(node);

      const result = await client.callTool({ name: 'list_providers', arguments: {} });

      expect(node.listProvidersCalls).toBe(1);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ providers: node.listProvidersResult });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('[OK] rugscore.assay.eth');
      expect(text).toContain('[MISS] liar.assay.eth');
      expect(text).toContain('resolver not configured');
    });

    it('reports an empty candidate set without erroring', async () => {
      node.listProvidersResult = [];
      const { client } = await connect(node);

      const result = await client.callTool({ name: 'list_providers', arguments: {} });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('No candidate providers are configured');
    });
  });

  describe('get_job', () => {
    it('calls through to the node and summarizes status, claims and verdict', async () => {
      const { client } = await connect(node);

      const result = await client.callTool({ name: 'get_job', arguments: { jobId: FIXTURE_JOB.jobId } });

      expect(node.getJobCalls).toEqual([FIXTURE_JOB.jobId]);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(FIXTURE_JOB);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain(FIXTURE_JOB.jobId);
      expect(text).toContain('served');
      expect(text).toContain('liquidityUsd');
    });

    it('rejects a missing jobId without calling the node', async () => {
      const { client } = await connect(node);
      const result = await client.callTool({ name: 'get_job', arguments: {} });
      expect(result.isError).toBe(true);
      expect(node.getJobCalls).toEqual([]);
    });

    it('surfaces the node error as a readable tool error instead of throwing raw', async () => {
      node.getJobError = new Error('Unknown job "no-such-job".');
      const { client } = await connect(node);
      const result = await client.callTool({ name: 'get_job', arguments: { jobId: 'no-such-job' } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Unknown job');
    });
  });

  describe('list_jobs', () => {
    it('lists every job the node knows about', async () => {
      node.jobsList = [FIXTURE_JOB];
      const { client } = await connect(node);

      const result = await client.callTool({ name: 'list_jobs', arguments: {} });

      expect(node.listJobsCalls).toBe(1);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ jobs: [FIXTURE_JOB] });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain(FIXTURE_JOB.jobId);
    });

    it('reports no jobs without erroring', async () => {
      node.jobsList = [];
      const { client } = await connect(node);

      const result = await client.callTool({ name: 'list_jobs', arguments: {} });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('No jobs yet');
    });
  });
});
