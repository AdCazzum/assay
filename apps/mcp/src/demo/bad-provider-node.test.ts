import { describe, expect, it } from 'vitest';
import { PayDeclinedError } from '@assay/core';
import {
  BAD_PROVIDER_NAME,
  BAD_PROVIDER_RECORD,
  createBadProviderDemoNode,
  DemoFixtureNotSupportedError,
} from './bad-provider-node.js';

describe('createBadProviderDemoNode (issue #24 declared fixture)', () => {
  describe('discover', () => {
    it('returns the fabricated bad ProviderRecord plus a real assessProvider read over it', async () => {
      const node = createBadProviderDemoNode();

      const { provider, assessment } = await node.discover(BAD_PROVIDER_NAME);

      expect(provider).toEqual(BAD_PROVIDER_RECORD);
      // real production assessProvider, not a hand-rolled summary: a 4/12
      // slash ratio should read as a "concern", not a "caution".
      const trackRecord = assessment.signals.find((s) => s.key === 'trackRecord');
      expect(trackRecord?.severity).toBe('concern');
      const collateral = assessment.signals.find((s) => s.key === 'collateral');
      expect(collateral?.severity).toBe('concern');
    });

    it('rejects any other capabilityId: this fixture only knows one fabricated provider', async () => {
      const node = createBadProviderDemoNode();
      await expect(node.discover('something-else.assay.eth')).rejects.toThrow(DemoFixtureNotSupportedError);
    });
  });

  describe('payAndCall', () => {
    it('declines without paying via the real evaluatePayDecision policy floor (force: false)', async () => {
      const node = createBadProviderDemoNode();

      const error = await node.payAndCall(BAD_PROVIDER_NAME, '0xTOKEN').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PayDeclinedError);
      expect((error as PayDeclinedError).providerName).toBe(BAD_PROVIDER_NAME);
      expect((error as PayDeclinedError).violations.length).toBeGreaterThan(0);
    });

    it('still refuses on force: true, since this fixture has no real rail behind it', async () => {
      const node = createBadProviderDemoNode();
      await expect(node.payAndCall(BAD_PROVIDER_NAME, '0xTOKEN', true)).rejects.toThrow(
        DemoFixtureNotSupportedError,
      );
    });

    it('rejects any other capabilityId', async () => {
      const node = createBadProviderDemoNode();
      await expect(node.payAndCall('something-else.assay.eth', '0xTOKEN')).rejects.toThrow(
        DemoFixtureNotSupportedError,
      );
    });
  });

  describe('challenge and rate', () => {
    it('challenge refuses: no job was ever served against this fixture', async () => {
      const node = createBadProviderDemoNode();
      await expect(node.challenge('job-1', 'liquidityUsd')).rejects.toThrow(DemoFixtureNotSupportedError);
    });

    it('rate refuses: no job was ever served against this fixture', async () => {
      const node = createBadProviderDemoNode();
      await expect(node.rate('job-1', true)).rejects.toThrow(DemoFixtureNotSupportedError);
    });
  });
});
