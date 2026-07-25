/**
 * A hybrid node for the "good provider" leg of the pay/decline demo (issue
 * #24). Companion to `bad-provider-node.ts`, in the opposite direction: this
 * time the requester agent is expected to decide the provider IS worth
 * paying, on the same prompt, same capability id, same token.
 *
 * Why this is a hybrid rather than either the pure live node or a pure
 * fixture: when it was written there was exactly one live Assay provider
 * registered on Sepolia, `rugscore.assay.eth`, and its live reputation at
 * the time posted a bond far too small relative to its price for any careful
 * agent to rationally pay. That was a real, disclosed fact about the state
 * of that record then, not a bug here. Standing up a second,
 * well-collateralized live name looked like it needed a brand-new subname
 * with its own resolver first; it does not, and two live names exist now
 * (see `bad-provider-node.ts`'s doc comment). This leg is kept as the
 * harness its committed transcript was captured with.
 *
 * So: only `registry.resolveProvider` is a declared fixture here, returning
 * a fabricated but well-collateralized `ProviderRecord`. Everything
 * downstream of that read is real, unmodified production code: `payments` is
 * `@assay/payments`'s real Hedera testnet adapter (a real payment, confirmed
 * on the real mirror node), `graph` is `@assay/graph`'s real Token API
 * adapter (mainnet), and the capability is the real, unmodified rug-score
 * capability. If the agent decides to pay, it spends real testnet HBAR and
 * gets a real rug-score result for real -- only the reputation record that
 * led to that decision is staged, and staged specifically to be a clear pay
 * decision (10x bond/price, a long, mostly-clean record), not a hairline
 * case, mirroring `bad-provider-node.ts`'s `BAD_REPUTATION` in the opposite
 * direction.
 */

import {
  createCapabilityRegistry,
  type Manifest,
  type ProviderRecord,
  type RegistryPort,
  type Reputation,
} from '@assay/core';
import { createRugScoreCapability } from '@assay/cap-rugscore';
import {
  createHederaPaymentsPort,
  createHederaSdkTransferClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';
import { createGraphAdapter } from '@assay/graph';
import { createLiveAssayNode } from '../live-node.js';
import type { AssayNodePort } from '../node-port.js';

export const GOOD_PROVIDER_NAME = 'rugscore.assay.eth';

const GOOD_MANIFEST: Manifest = {
  capabilityId: 'rugscore',
  description: 'Rug-pull risk score for an ERC-20 token, derived from The Graph Token API signals.',
  priceHbar: 5,
  endpoint: 'http://localhost:8787/serve',
  bondRef: 'demo-good-provider-bond',
  verifierHash: '0xdemo-good-provider',
};

/** Fabricated on purpose; see module doc comment for why and for the deliberately wide margin. */
const GOOD_REPUTATION: Reputation = {
  score: 92,
  jobs: 30,
  slashes: 1,
  bondHbar: 50,
};

export const GOOD_PROVIDER_RECORD: ProviderRecord = {
  name: GOOD_PROVIDER_NAME,
  manifest: GOOD_MANIFEST,
  reputation: GOOD_REPUTATION,
};

/**
 * Declared fixture `RegistryPort`: resolves only the one fabricated good
 * record above. Exported (rather than kept private) so it can be unit
 * tested directly without needing real Hedera/Graph credentials.
 */
export class FixtureGoodRegistryPort implements RegistryPort {
  async resolveProvider(name: string): Promise<ProviderRecord> {
    if (name !== GOOD_PROVIDER_NAME) {
      throw new Error(
        `FixtureGoodRegistryPort: only resolves the fabricated "${GOOD_PROVIDER_NAME}" record for ` +
          `this demo (see good-provider-node.ts's doc comment), not "${name}".`,
      );
    }
    return GOOD_PROVIDER_RECORD;
  }

  async publishManifest(): Promise<{ txHash: string }> {
    throw new Error('FixtureGoodRegistryPort: publishManifest is not used by this demo.');
  }

  async updateReputation(): Promise<{ txHash: string; reputation: Reputation }> {
    throw new Error(
      'FixtureGoodRegistryPort: updateReputation is not used by this demo (the agent is only asked ' +
        'to discover and pay_and_call, never rate or challenge).',
    );
  }
}

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

/**
 * Thrown by `buildGoodProviderDemoNode` when required env is missing. Note
 * the missing-var set is smaller than `index.ts`'s `buildLiveNodeFromEnv`:
 * no `SEPOLIA_*` or `ENS_PARENT_NAME`, since this demo's registry read is a
 * declared fixture, not a live ENS resolve.
 */
export class MissingConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: string[]) {
    super(
      `good-provider demo: missing required env var(s): ${missing.join(', ')}. Copy .env.example to ` +
        '.env at the repo root and fill them in (see AGENTS.md "Networks & secrets").',
    );
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

function requireEnv(names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name] as string]));
}

/**
 * Builds the hybrid `AssayNodePort`: real Hedera payments, real Graph
 * queries, real rug-score capability, over the declared fixture registry
 * above. See the module doc comment for exactly what is real and what is
 * staged.
 */
export function buildGoodProviderDemoNode(): AssayNodePort {
  const env = requireEnv(['HEDERA_OPERATOR_ID', 'HEDERA_OPERATOR_KEY', 'GRAPH_API_KEY']);
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const keyType = process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined;

  const transferClient = createHederaSdkTransferClient({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network,
    keyType,
  });

  // Same disclosed single-operator simplification `index.ts`'s
  // `buildLiveNodeFromEnv` makes: no second funded testnet account exists,
  // so pay-to and bond-escrow default to the operator's own account.
  const payToAccountId = process.env.HEDERA_PAY_TO_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const mirrorNodeBaseUrl = process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network];

  const payments = createHederaPaymentsPort({
    client: transferClient,
    payToAccountId,
    bondAccountId,
    mirrorNodeBaseUrl,
    fetchImpl: fetch,
  });

  const graph = createGraphAdapter({ apiKey: env.GRAPH_API_KEY });

  const capabilities = createCapabilityRegistry();
  capabilities.register(createRugScoreCapability({ graph }));

  return createLiveAssayNode({
    registry: new FixtureGoodRegistryPort(),
    payments,
    graph,
    capabilities,
  });
}
