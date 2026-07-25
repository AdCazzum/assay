#!/usr/bin/env tsx
/**
 * Resets the demo's opening reputation state (issue #64: "the live ENS
 * reputation is now too damaged for the demo's opening act"). Real Sepolia
 * and real Hedera testnet calls, no fakes.
 *
 *   pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
 *
 * ## What this fixes
 *
 * `rugscore.assay.eth`'s `assay:rep` is the live record SPEC.md §10's opening
 * beat depends on: the agent discovers it, judges it acceptable, and pays.
 * Two real watchdog runs (#28) have since slashed it for real, twice, so it
 * now reads `{"score":31,"jobs":5,"slashes":2,"bondHbar":0.02}` -- correctly
 * declined by the live agent (transcript in `apps/mcp/agent/transcripts/`),
 * which is the system working and also exactly the demo's problem. And every
 * rehearsal of the slash beat (issue #31 budgets three) makes it worse again.
 *
 * This script is what makes the demo's opening state a deliberate, resettable
 * choice instead of "whatever the last rehearsal left behind": see
 * `demo-state.ts` for the exact numbers and why they were picked.
 *
 * ## Why this is a legitimate write, not a hardcoded number
 *
 * `@assay/registry`'s job is real ENS reads/writes; nothing here fabricates
 * what the chain reports. Setting a provider's *opening* reputation before a
 * demo run is the same kind of operator action as `register()` initializing
 * a fresh provider to `{score:0,jobs:0,slashes:0}` (`packages/core/src/
 * node.ts`) -- a legitimate starting point the operator chooses, not a
 * pretense that verification produced it. What must never happen (and
 * doesn't, anywhere in this repo) is hardcoding a *result* the verifier or
 * the challenge/slash path is supposed to have derived.
 *
 * ## What this does, in order
 *
 *   1. Resolves the target name's current manifest (for its live `priceHbar`
 *      -- the bond is computed as a multiple of *that*, not an assumed 5).
 *   2. Posts a real Hedera bond for `computeDemoBondHbar(priceHbar)` HBAR,
 *      confirmed via mirror-node poll (a real, independently-checkable tx,
 *      not just a number typed into JSON).
 *   3. Publishes an updated manifest whose `bondRef` points at that real
 *      bond (a real Sepolia ENS write).
 *   4. Writes the full absolute reputation state from `demo-state.ts` (a
 *      second real Sepolia ENS write).
 *   5. Reads the record back independently through `resolveProvider` (a
 *      fresh read off the resolver, not the write calls' own return values)
 *      and prints it, so the printed summary is proof, not narration.
 *
 * Re-run this between every rehearsal (issue #31): it always writes the same
 * absolute target state regardless of what rehearsals left behind.
 *
 * Requires the full live `.env` (AGENTS.md "Networks & secrets"): Sepolia
 * (`SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY`, `ENS_PARENT_NAME`) and Hedera
 * (`HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, optional `HEDERA_KEY_TYPE`/
 * `HEDERA_NETWORK`).
 *
 * Optional:
 *   DEMO_PROVIDER_LABEL   subname label, defaults to "rugscore" -- the same
 *                         name `apps/mcp/agent/prompt.md` hardcodes as the
 *                         capability the live agent discovers. Override only
 *                         if the run sheet points the demo at a different
 *                         name (see issue #64's "split the good provider
 *                         from the sacrificial one": the watchdog's target,
 *                         `WATCHDOG_PROVIDER_NAME`, is separate and should
 *                         never equal this one).
 *   DEMO_BOND_MULTIPLE    overrides `DEFAULT_DEMO_BOND_MULTIPLE` (6).
 *   HEDERA_BOND_ACCOUNT_ID bond-escrow account for the real Hedera bond post,
 *                         same convention as `apps/watchdog`/`apps/mcp`.
 *                         Defaults to the operator's own account (no second
 *                         funded testnet account exists -- see those apps'
 *                         doc comments for the same disclosed simplification).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createHederaPaymentsPort, createHederaSdkTransferClient, type HederaKeyType, type HederaNetwork } from '@assay/payments';
// The capability owns its own verifier commitment (SPEC.md §5), so the hash is
// computed there rather than pasted here. This crosses a package boundary that
// `packages/registry/src/` must never cross, and only does so because this is
// operator tooling: the same reason the script already reaches for
// `@assay/payments` to post a real bond.
import { computeVerifierHash } from '@assay/cap-rugscore';
import { createEnsRegistry, type ReputationWriteProgress } from '../src/ens-registry.js';
import { EnsRegistryError } from '../src/errors.js';
import { buildDemoReputation, buildSacrificialReputation, computeDemoBondHbar, DEFAULT_DEMO_BOND_MULTIPLE } from './demo-state.js';
import type { PaymentsPort, RegistryPort, Reputation } from '@assay/core';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

/**
 * Where `apps/provider` actually listens (`apps/provider/src/index.ts`:
 * `PORT ?? 8787`, route `POST /serve`). Override with
 * `DEMO_PROVIDER_ENDPOINT` when the provider runs somewhere else.
 *
 * This is localhost because the provider runs on the demo machine, which is
 * honest: the manifest should say where the service really is, and a public
 * URL we do not serve would be a worse lie than a loopback one.
 */
const DEFAULT_PROVIDER_ENDPOINT = 'http://localhost:8787/serve';

/**
 * Kept accurate rather than aspirational: the signals come from a block-pinned
 * Uniswap v3 subgraph query through The Graph's gateway (#42), not the Token
 * API the earlier text claimed (#49 replaced that path entirely).
 */
const DEMO_DESCRIPTION =
  'Rug-pull risk score for an ERC-20 token, from block-pinned Uniswap v3 subgraph data via The Graph, verifiable at the claim block.';

/**
 * Must stay equal to `apps/mcp/src/index.ts`'s own `LYING_CAPABILITY_ID`
 * (issues #93/#94's capability-wiring fix). A package script cannot import
 * from an app (that would be a backwards dependency this repo's layering
 * never allows elsewhere), so this repeats the literal instead -- keep the
 * two in sync by hand if either ever changes.
 *
 * Why this matters: before this fix, `resetProvider`'s sacrificial-role call
 * republished `liar.<parent>`'s manifest by spreading `...before.manifest`,
 * i.e. whatever `capabilityId` was already on-chain -- which was
 * `'rugscore'`, the honest capability's own id, since nothing had ever
 * published a manifest under any other id. `apps/mcp`'s live server registers
 * exactly one capability per id (`createCapabilityRegistry.register` throws
 * `DuplicateCapabilityError` on a second registration under the same id), so
 * `liar.<parent>` had to dispatch to the honest capability -- there was no
 * live lie behind it to catch, only a rehearsed transcript of one (verified
 * by reading `apps/mcp/src/index.ts` and this file directly, not assumed).
 */
const LYING_CAPABILITY_ID = 'rugscore.v2';

const HASHSCAN_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://hashscan.io/testnet',
  mainnet: 'https://hashscan.io/mainnet',
  previewnet: 'https://hashscan.io/previewnet',
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `missing ${key}. Set it in a .env file at the repo root (see .env.example) before running this script.`,
    );
  }
  return value;
}

function logReputationProgress(info: ReputationWriteProgress): void {
  if (info.phase === 'reading') {
    console.log('[reset-demo] reputation: reading current record...');
  } else if (info.phase === 'writing') {
    console.log(`[reset-demo] reputation: writing (${info.writeState}) at ${info.elapsedMs}ms`);
  } else {
    console.log(`[reset-demo] reputation: done in ${info.elapsedMs}ms (tx ${info.txHash})`);
  }
}

/**
 * Resets one provider: real bond, then manifest, then the absolute reputation
 * target, then an independent read-back.
 *
 * Factored out because there are two providers to reset and they need
 * different opening states for different reasons. The good one has to look
 * worth paying; the sacrificial one has to have room to fall.
 */
async function resetProvider(opts: {
  name: string;
  role: string;
  buildReputation: (priceHbar: number, multiple: number) => Reputation;
  registry: RegistryPort;
  payments: PaymentsPort;
  bondMultiple: number;
  network: HederaNetwork;
  endpoint: string;
  /**
   * Overrides the republished manifest's `capabilityId` (issues #93/#94).
   * Only the sacrificial ("vantage") role passes this, and only as
   * `LYING_CAPABILITY_ID`: without it, this function's default behaviour
   * (spreading `...before.manifest`, see below) would keep whatever
   * `capabilityId` is already on-chain, which is `'rugscore'` -- the honest
   * capability's own id -- since nothing has ever published this name's
   * manifest under any other id.
   */
  capabilityId?: string;
}): Promise<boolean> {
  const { name, role, buildReputation, registry, payments, bondMultiple, network, endpoint, capabilityId } = opts;
  const tag = `[reset-demo:${role}]`;

  console.log('');
  console.log(`${tag} --- ${name} ---`);

  // 1. Resolve the current record for its live priceHbar. Also fails fast,
  // with a clear message, if the name has no manifest published yet (run
  // packages/registry/scripts/smoke.ts with SMOKE_LABEL first).
  const before = await registry.resolveProvider(name);
  console.log(`${tag} price: ${before.manifest.priceHbar} HBAR`);
  console.log(`${tag} reputation before: ${JSON.stringify(before.reputation)}`);

  const bondHbar = computeDemoBondHbar(before.manifest.priceHbar, bondMultiple);

  // 2. A real Hedera bond, confirmed via mirror node, behind the number this
  // script is about to publish. Not a claimed figure.
  console.log(`${tag} posting real bond: ${bondHbar} HBAR (${bondMultiple}x price)...`);
  const { bondRef, txId: bondTxId } = await payments.postBond(bondHbar);
  if (!(await payments.confirm(bondTxId))) {
    throw new Error(
      `bond tx ${bondTxId} did not confirm via mirror node; refusing to publish a reputation record backed by an unconfirmed bond.`,
    );
  }
  console.log(`${tag} bond tx: ${HASHSCAN_BASE_URL[network]}/transaction/${bondTxId}`);

  // 3. Republish the manifest: bondRef points at the bond just posted, and
  // endpoint/verifierHash/description carry real values rather than the
  // placeholders they used to (#67).
  const verifierHash = computeVerifierHash();
  const { txHash: manifestTxHash } = await registry.publishManifest(name, {
    ...before.manifest,
    description: DEMO_DESCRIPTION,
    bondRef,
    endpoint,
    verifierHash,
    ...(capabilityId ? { capabilityId } : {}),
  });
  console.log(`${tag} manifest tx: https://sepolia.etherscan.io/tx/${manifestTxHash}`);

  // 4. The full absolute reputation target, so the reset actually resets
  // whatever rehearsals left behind.
  const target = buildReputation(before.manifest.priceHbar, bondMultiple);
  const { txHash: reputationTxHash } = await registry.updateReputation(name, target);
  console.log(`${tag} reputation tx: https://sepolia.etherscan.io/tx/${reputationTxHash}`);

  // 5. Read it back independently, so the line below is proof rather than an
  // echo of what was sent.
  const after = await registry.resolveProvider(name);
  const matches =
    after.reputation.score === target.score &&
    after.reputation.jobs === target.jobs &&
    after.reputation.slashes === target.slashes &&
    after.reputation.bondHbar === target.bondHbar;
  console.log(`${tag} reputation after:  ${JSON.stringify(after.reputation)}`);
  console.log(`${tag} read-back matches target: ${matches ? 'OK' : 'MISMATCH'}`);
  return matches;
}

async function main(): Promise<void> {
  // --- Sepolia / ENS config ---
  const rpcUrl = requireEnv('SEPOLIA_RPC_URL');
  const sepoliaPrivateKey = requireEnv('SEPOLIA_PRIVATE_KEY');
  const parentName = requireEnv('ENS_PARENT_NAME');
  const label = process.env.DEMO_PROVIDER_LABEL ?? 'rugscore';
  const sacrificialLabel = process.env.WATCHDOG_PROVIDER_LABEL ?? 'vantage';
  const bondMultiple = Number(process.env.DEMO_BOND_MULTIPLE ?? String(DEFAULT_DEMO_BOND_MULTIPLE));

  // --- Hedera config (real bonds) ---
  const operatorId = requireEnv('HEDERA_OPERATOR_ID');
  const operatorKey = requireEnv('HEDERA_OPERATOR_KEY');
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const keyType = process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || operatorId;
  const endpoint = process.env.DEMO_PROVIDER_ENDPOINT ?? DEFAULT_PROVIDER_ENDPOINT;

  console.log(`[reset-demo] hedera network: ${network}`);
  console.log(`[reset-demo] endpoint:       ${endpoint}`);
  console.log(`[reset-demo] verifierHash:   ${computeVerifierHash()}`);

  const registry = createEnsRegistry({
    rpcUrl,
    privateKey: sepoliaPrivateKey,
    parentName,
    onReputationWriteAttempt: logReputationProgress,
  });

  const transferClient = createHederaSdkTransferClient({ operatorId, operatorKey, network, keyType });
  try {
    const payments = createHederaPaymentsPort({
      client: transferClient,
      payToAccountId: operatorId,
      bondAccountId,
      mirrorNodeBaseUrl: process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network],
      fetchImpl: fetch,
    });

    const shared = { registry, payments, bondMultiple, network, endpoint };

    // The provider the demo opens on: has to read as worth paying.
    const goodOk = await resetProvider({
      name: `${label}.${parentName}`,
      role: 'good',
      buildReputation: buildDemoReputation,
      ...shared,
    });

    // The provider the watchdog slashes: has to have room to fall. Skipped
    // with SKIP_SACRIFICIAL_RESET=1 if a run sheet only needs the opening.
    let sacrificialOk = true;
    if (process.env.SKIP_SACRIFICIAL_RESET === '1') {
      console.log('\n[reset-demo:liar] skipped (SKIP_SACRIFICIAL_RESET=1)');
    } else {
      sacrificialOk = await resetProvider({
        name: `${sacrificialLabel}.${parentName}`,
        role: 'vantage',
        buildReputation: buildSacrificialReputation,
        capabilityId: LYING_CAPABILITY_ID,
        ...shared,
      });
    }

    console.log('');
    console.log(`[reset-demo] read-back matches target: ${goodOk && sacrificialOk ? 'OK' : 'MISMATCH'}`);
    if (!(goodOk && sacrificialOk)) {
      process.exitCode = 1;
    }
  } finally {
    transferClient.close();
  }
}

main().catch((err) => {
  if (err instanceof EnsRegistryError) {
    console.error(`[reset-demo] ${err.name}: ${err.message}`);
  } else {
    console.error('[reset-demo] failed:', err);
  }
  process.exitCode = 1;
});
