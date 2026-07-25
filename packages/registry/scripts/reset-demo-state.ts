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
import { buildDemoReputation, computeDemoBondHbar, DEFAULT_DEMO_BOND_MULTIPLE } from './demo-state.js';

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

async function main(): Promise<void> {
  // --- Sepolia / ENS config ---
  const rpcUrl = requireEnv('SEPOLIA_RPC_URL');
  const sepoliaPrivateKey = requireEnv('SEPOLIA_PRIVATE_KEY');
  const parentName = requireEnv('ENS_PARENT_NAME');
  const label = process.env.DEMO_PROVIDER_LABEL ?? 'rugscore';
  const name = `${label}.${parentName}`;
  const bondMultiple = Number(process.env.DEMO_BOND_MULTIPLE ?? String(DEFAULT_DEMO_BOND_MULTIPLE));

  // --- Hedera config (real bond) ---
  const operatorId = requireEnv('HEDERA_OPERATOR_ID');
  const operatorKey = requireEnv('HEDERA_OPERATOR_KEY');
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const keyType = process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || operatorId;

  console.log(`[reset-demo] target name: ${name}`);
  console.log(`[reset-demo] rpc: ${rpcUrl}`);
  console.log(`[reset-demo] hedera network: ${network}`);

  const registry = createEnsRegistry({
    rpcUrl,
    privateKey: sepoliaPrivateKey,
    parentName,
    onReputationWriteAttempt: logReputationProgress,
  });

  // 1. Resolve the current record for its live priceHbar. This also fails
  // fast, with a clear message, if the name has no manifest published yet
  // (run packages/registry/scripts/smoke.ts first).
  console.log('[reset-demo] resolving current record for priceHbar...');
  const before = await registry.resolveProvider(name);
  console.log(`[reset-demo] current manifest priceHbar: ${before.manifest.priceHbar} HBAR`);
  console.log('[reset-demo] current reputation (before reset):', JSON.stringify(before.reputation, null, 2));

  const bondHbar = computeDemoBondHbar(before.manifest.priceHbar, bondMultiple);

  // 2. Post a real Hedera bond for that amount, confirmed via mirror node --
  // a real tx behind the number this script is about to write, not just a
  // claimed figure.
  const transferClient = createHederaSdkTransferClient({ operatorId, operatorKey, network, keyType });
  try {
    const payments = createHederaPaymentsPort({
      client: transferClient,
      payToAccountId: operatorId,
      bondAccountId,
      mirrorNodeBaseUrl: process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network],
      fetchImpl: fetch,
      onConfirmAttempt: (info) => console.log(`[reset-demo] bond confirm: poll #${info.attempt} at ${info.elapsedMs}ms: ${info.state}`),
    });

    console.log(`[reset-demo] posting real bond: ${bondHbar} HBAR (${bondMultiple}x the ${before.manifest.priceHbar} HBAR price), ${operatorId} -> ${bondAccountId}...`);
    const bondStart = Date.now();
    const { bondRef, txId: bondTxId } = await payments.postBond(bondHbar);
    const bondConfirmed = await payments.confirm(bondTxId);
    const bondElapsedMs = Date.now() - bondStart;
    console.log(`[reset-demo] bond ${bondConfirmed ? 'confirmed' : 'NOT CONFIRMED'} in ${bondElapsedMs}ms`);
    console.log(`[reset-demo] bond tx: ${HASHSCAN_BASE_URL[network]}/transaction/${bondTxId}`);
    if (!bondConfirmed) {
      throw new Error(`bond tx ${bondTxId} did not confirm via mirror node; refusing to write a reputation record backed by an unconfirmed bond.`);
    }

    // 3. Republish the manifest: point bondRef at the bond just posted, and
    // replace the two fields that were carrying placeholders (#67). The
    // manifest is a public on-chain record judges read directly, so
    // `provider.example` and a verifierHash that hashes nothing are not
    // cosmetic problems.
    const endpoint = process.env.DEMO_PROVIDER_ENDPOINT ?? DEFAULT_PROVIDER_ENDPOINT;
    const verifierHash = computeVerifierHash();
    console.log(`[reset-demo] endpoint:     ${endpoint}`);
    console.log(`[reset-demo] verifierHash: ${verifierHash} (sha256 over ${'rugscore.ts + tolerances.ts'})`);
    console.log('[reset-demo] publishing manifest (bondRef, endpoint, verifierHash)...');
    const manifestStart = Date.now();
    const { txHash: manifestTxHash } = await registry.publishManifest(name, {
      ...before.manifest,
      description: DEMO_DESCRIPTION,
      bondRef,
      endpoint,
      verifierHash,
    });
    console.log(`[reset-demo] manifest write confirmed in ${Date.now() - manifestStart}ms (tx ${manifestTxHash})`);

    // 4. Write the full absolute reputation target (real ENS write).
    const target = buildDemoReputation(before.manifest.priceHbar, bondMultiple);
    console.log('[reset-demo] writing target reputation:', JSON.stringify(target, null, 2));
    const { txHash: reputationTxHash } = await registry.updateReputation(name, target);

    // 5. Read the result back independently -- a fresh resolveProvider call,
    // not the write calls' own return values -- so the summary below is
    // proof of what is actually on-chain, not just an echo of what was sent.
    const after = await registry.resolveProvider(name);

    console.log('');
    console.log('[reset-demo] --- summary ---');
    console.log(`[reset-demo] name: ${name}`);
    console.log(`[reset-demo] bond tx:       ${bondTxId} (${HASHSCAN_BASE_URL[network]}/transaction/${bondTxId})`);
    console.log(`[reset-demo] manifest tx:   ${manifestTxHash} (https://sepolia.etherscan.io/tx/${manifestTxHash})`);
    console.log(`[reset-demo] reputation tx: ${reputationTxHash} (https://sepolia.etherscan.io/tx/${reputationTxHash})`);
    console.log('[reset-demo] on-chain record, read back off the resolver:');
    console.log(JSON.stringify({ manifest: after.manifest, reputation: after.reputation }, null, 2));

    const matches =
      after.reputation.score === target.score &&
      after.reputation.jobs === target.jobs &&
      after.reputation.slashes === target.slashes &&
      after.reputation.bondHbar === target.bondHbar;
    console.log(`[reset-demo] read-back matches target: ${matches ? 'OK' : 'MISMATCH'}`);
    if (!matches) {
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
