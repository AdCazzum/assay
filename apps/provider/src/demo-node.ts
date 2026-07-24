/**
 * Builds the `AssayNode` `index.ts`'s demo mode runs the provider service
 * against: real `@assay/core` orchestration and a real `@assay/cap-rugscore`
 * capability, wired to the named fakes in `fakes.ts` instead of live
 * Hedera/ENS/Graph credentials, so the whole loop is rehearsable offline.
 *
 * Wiring the real adapters (`@assay/registry`, `@assay/payments`,
 * `@assay/graph`) is out of scope for issue #8: the ENS parent name is not
 * registered yet (see AGENTS.md), so a live registry round trip cannot be
 * proven today regardless. That wiring is a follow-up once registration
 * lands.
 */

import { createAssayNode, createCapabilityRegistry, type AssayNode, type Manifest } from '@assay/core';
import { createRugScoreCapability } from '@assay/cap-rugscore';
import { FakeGraphPort, FakePaymentsPort, FakeRegistryPort } from './fakes.js';

export const DEMO_PROVIDER_NAME = 'rugscore.assay.eth';

export const DEMO_MANIFEST: Manifest = {
  capabilityId: 'rugscore',
  description: 'Rug-pull risk score for an ERC-20 token, derived from The Graph Token API signals.',
  priceHbar: 5,
  endpoint: 'http://localhost:8787/serve',
  bondRef: 'demo-bond',
  verifierHash: '0xdemo',
};

export type DemoNode = {
  node: AssayNode;
  registry: FakeRegistryPort;
  payments: FakePaymentsPort;
  graph: FakeGraphPort;
};

/** Builds a fully-wired, offline `AssayNode` for `index.ts`'s demo mode (and available to scripts/tests that want the same setup). */
export function buildDemoNode(): DemoNode {
  const registry = new FakeRegistryPort().seed(DEMO_PROVIDER_NAME, {
    manifest: DEMO_MANIFEST,
    reputation: { score: 80, jobs: 0, slashes: 0, bondHbar: 50 },
  });
  const payments = new FakePaymentsPort();
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(createRugScoreCapability({ graph }));

  const node = createAssayNode({ registry, payments, graph, capabilities });
  return { node, registry, payments, graph };
}
