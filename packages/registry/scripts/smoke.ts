#!/usr/bin/env tsx
/**
 * Live smoke test for the ENS registry adapter. Real Sepolia RPC calls, no
 * fakes. Run with:
 *
 *   pnpm --filter @assay/registry exec tsx scripts/smoke.ts
 *
 * Reads SEPOLIA_RPC_URL, SEPOLIA_PRIVATE_KEY, ENS_PARENT_NAME from `.env`
 * at the repo root (see `.env.example`). Publishes a manifest to
 * `<label>.${ENS_PARENT_NAME}` (label defaults to "rugscore", override with
 * SMOKE_LABEL), reads it back, and prints both plus the ENS-write elapsed
 * time (SPEC.md §16 flags ENS write latency as a live risk).
 *
 * IMPORTANT PREREQUISITE: this only writes a *text record* on an existing
 * name. It does not create the subname and does not set its resolver. If
 * `<label>.${ENS_PARENT_NAME}` has never been created (no owner set) or was
 * created without a resolver, this script fails fast with
 * NoResolverConfiguredError -- create the subname and give it a resolver
 * first (e.g. in the ENS Manager app: app.ens.domains -> your name -> +
 * Subname -> assign it a resolver, or set one explicitly if you create it
 * some other way). See the PR notes for how this was verified.
 *
 * This script always writes to a *subname* (`<label>.${ENS_PARENT_NAME}`),
 * never to the bare parent name itself, by construction -- the template
 * above always appends `.${ENS_PARENT_NAME}`, so there is no SMOKE_LABEL
 * value that resolves to the parent alone. That distinction matters because
 * the bare parent (`assay.eth`) once carried a stray `assay:manifest` record
 * with a placeholder `verifierHash` this script has never produced
 * (`"sha256:live-smoke"`, not this script's `"0xsmoke"`); it came from an
 * earlier manual write made directly against the parent outside of any
 * script here, not from a run of this file. That stray record has since
 * been cleared on-chain (empty string), so `assay.eth` no longer carries
 * unused manifest litter (ens-F3-stale-manifest-on-parent-name).
 */

import { config as loadEnv } from 'dotenv';
import { createEnsRegistry } from '../src/ens-registry.js';
import { createEthersEnsGateway } from '../src/ens-gateway.js';
import { MANIFEST_RECORD_KEY, decodeManifest } from '../src/manifest-codec.js';
import type { Manifest } from '@assay/core';
import { EnsRegistryError, MissingRecordError } from '../src/errors.js';

loadEnv();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `missing ${key}. Set it in a .env file at the repo root (see .env.example) before running the smoke script.`,
    );
  }
  return value;
}

async function main() {
  const rpcUrl = requireEnv('SEPOLIA_RPC_URL');
  const privateKey = requireEnv('SEPOLIA_PRIVATE_KEY');
  const parentName = requireEnv('ENS_PARENT_NAME');
  const label = process.env.SMOKE_LABEL ?? 'rugscore';
  const name = `${label}.${parentName}`;

  console.log(`[smoke] target name: ${name}`);
  console.log(`[smoke] rpc: ${rpcUrl}`);

  const registry = createEnsRegistry({ rpcUrl, privateKey, parentName });

  const manifest: Manifest = {
    capabilityId: 'rugscore',
    description: 'rug-pull risk score for an ERC-20 token',
    priceHbar: 5,
    endpoint: 'https://provider.example/rugscore',
    bondRef: `smoke-${Date.now()}`,
    verifierHash: '0xsmoke',
  };

  console.log('[smoke] publishing manifest...');
  const writeStarted = Date.now();
  const { txHash } = await registry.publishManifest(name, manifest);
  const writeElapsedMs = Date.now() - writeStarted;

  console.log(`[smoke] wrote assay:manifest in ${writeElapsedMs}ms`);
  console.log(`[smoke] tx: https://sepolia.etherscan.io/tx/${txHash}`);

  // Read back through the raw gateway rather than `resolveProvider`: this
  // issue (#15) only covers the manifest half, so `assay:rep` may not exist
  // yet (that's #16). Reading the manifest text record directly proves the
  // round trip this issue is scoped to without depending on the other one.
  console.log('[smoke] reading assay:manifest back...');
  const gateway = createEthersEnsGateway({ rpcUrl, privateKey });
  const manifestRaw = await gateway.getText(name, MANIFEST_RECORD_KEY);
  if (manifestRaw === null) {
    throw new MissingRecordError(MANIFEST_RECORD_KEY, name);
  }
  const manifestReadBack = decodeManifest(manifestRaw, name);

  console.log('[smoke] manifest read back:');
  console.log(JSON.stringify(manifestReadBack, null, 2));

  const roundTripOk = JSON.stringify(manifestReadBack) === JSON.stringify(manifest);
  console.log(`[smoke] round-trip match: ${roundTripOk ? 'OK' : 'MISMATCH'}`);
  if (!roundTripOk) {
    process.exitCode = 1;
  }

  // Bonus: exercise the full `resolveProvider` port method too. This needs
  // `assay:rep` to already be set on `name` (out of scope here, #16), so a
  // missing-reputation failure here is expected, not a bug in this issue.
  console.log('[smoke] (bonus) trying resolveProvider (needs assay:rep to already be set)...');
  try {
    const record = await registry.resolveProvider(name);
    console.log('[smoke] resolveProvider ok, reputation read back:');
    console.log(JSON.stringify(record.reputation, null, 2));
  } catch (err) {
    if (err instanceof MissingRecordError && err.recordKey === 'assay:rep') {
      console.log('[smoke] resolveProvider: assay:rep is not set yet (expected until #16 lands)');
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  if (err instanceof EnsRegistryError) {
    console.error(`[smoke] ${err.name}: ${err.message}`);
  } else {
    console.error('[smoke] failed:', err);
  }
  process.exitCode = 1;
});
