import { describe, expect, it } from 'vitest';
import { buildLiveDemoNodes, MissingConfigError } from './live-node.js';

describe('buildLiveDemoNodes', () => {
  it('fails fast with MissingConfigError, naming every absent var, before touching any network', () => {
    const saved = { ...process.env };
    for (const key of ['HEDERA_OPERATOR_ID', 'HEDERA_OPERATOR_KEY', 'SEPOLIA_RPC_URL', 'SEPOLIA_PRIVATE_KEY', 'ENS_PARENT_NAME', 'GRAPH_API_KEY']) {
      delete process.env[key];
    }

    try {
      expect(() => buildLiveDemoNodes()).toThrow(MissingConfigError);
      try {
        buildLiveDemoNodes();
      } catch (err) {
        expect(err).toBeInstanceOf(MissingConfigError);
        const missing = (err as MissingConfigError).missing;
        expect(missing).toContain('HEDERA_OPERATOR_ID');
        expect(missing).toContain('SEPOLIA_RPC_URL');
        expect(missing).toContain('GRAPH_API_KEY');
      }
    } finally {
      process.env = saved;
    }
  });
});
