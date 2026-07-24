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

  it('lists all four tools with non-empty descriptions', async () => {
    const { client } = await connect(node);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['challenge', 'discover', 'pay_and_call', 'rate']);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(40);
    }
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
      expect(text).toContain('hasActiveMintRole');
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
      const challenged = { ...FIXTURE_JOB, status: 'slashed' as const, verdict: { valid: false, badClaim: 'hasActiveMintRole', reason: 'mint role is active' } };
      node.jobsById.set(FIXTURE_JOB.jobId, challenged);
      const { client } = await connect(node);

      const result = await client.callTool({
        name: 'challenge',
        arguments: { jobId: FIXTURE_JOB.jobId, claimKey: 'hasActiveMintRole' },
      });

      expect(node.challengeCalls).toEqual([{ jobId: FIXTURE_JOB.jobId, claimKey: 'hasActiveMintRole' }]);
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
});
