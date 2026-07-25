/**
 * Obviously-named test doubles for the three `@assay/core` ports, so
 * `live-node.test.ts` can drive `createLiveAssayNode` with zero network.
 *
 * These are NOT re-exports of `@assay/core`'s own test-support fakes: that
 * module is deliberately not part of `@assay/core`'s public entry point (see
 * its own doc comment), so this package writes its own, the same way
 * `apps/provider/src/fakes.ts` already does independently. Never mistake
 * these for `@assay/registry` / `@assay/payments` / `@assay/graph`, the real
 * adapters this app wires in `index.ts`.
 */

import type { GraphPort, Manifest, PaymentsPort, ProviderRecord, RegistryPort, Reputation, TokenSignals } from '@assay/core';

/** Thrown by `FakeRegistryPort` when asked to resolve a name nobody seeded. */
export class UnknownFixtureProviderError extends Error {
  constructor(readonly name: string) {
    super(`FakeRegistryPort: no provider record seeded for "${name}"`);
    this.name = 'UnknownFixtureProviderError';
  }
}

/** In-memory `RegistryPort`. `updateReputation` really merges the patch (see `live-node.ts`'s doc comment on why that semantics choice matters), it does not just record the call. */
export class FakeRegistryPort implements RegistryPort {
  private readonly records = new Map<string, ProviderRecord>();
  readonly updateReputationCalls: Array<{ name: string; delta: Partial<Reputation> }> = [];
  private txSeq = 0;

  seed(name: string, record: Omit<ProviderRecord, 'name'>): this {
    this.records.set(name, { name, ...record });
    return this;
  }

  async resolveProvider(name: string): Promise<ProviderRecord> {
    const record = this.records.get(name);
    if (!record) throw new UnknownFixtureProviderError(name);
    return record;
  }

  async publishManifest(name: string, manifest: Manifest): Promise<{ txHash: string }> {
    this.txSeq += 1;
    const existing = this.records.get(name);
    this.records.set(name, {
      name,
      manifest,
      reputation: existing?.reputation ?? { score: 0, jobs: 0, slashes: 0, bondHbar: 0 },
    });
    return { txHash: `0xfake-manifest-${this.txSeq}` };
  }

  async updateReputation(
    name: string,
    delta: Partial<Reputation>,
  ): Promise<{ txHash: string; reputation: Reputation }> {
    this.updateReputationCalls.push({ name, delta });
    const existing = this.records.get(name);
    if (!existing) throw new UnknownFixtureProviderError(name);
    this.txSeq += 1;
    const reputation: Reputation = { ...existing.reputation, ...delta };
    this.records.set(name, { ...existing, reputation });
    return { txHash: `0xfake-rep-${this.txSeq}`, reputation };
  }
}

/**
 * A `RegistryPort` whose `updateReputation` always throws. `@assay/registry`'s
 * real ENS adapter has `updateReputation` (#16) fully implemented as a live
 * Sepolia read-modify-write (see `ens-registry.ts`), so this is not modeling
 * any current limitation of that adapter, it models the one failure mode any
 * real write can still have (RPC error, out-of-range value, dropped
 * transaction, etc.), so `live-node.test.ts` can assert `challenge`/`rate`
 * surface such a failure as a clear, named error instead of a silent success.
 */
export class FailingUpdateReputationRegistryPort implements RegistryPort {
  constructor(private readonly seeded: ProviderRecord) {}

  async resolveProvider(name: string): Promise<ProviderRecord> {
    if (name !== this.seeded.name) throw new UnknownFixtureProviderError(name);
    return this.seeded;
  }

  async publishManifest(): Promise<{ txHash: string }> {
    throw new Error('FailingUpdateReputationRegistryPort: publishManifest not used by these tests');
  }

  async updateReputation(): Promise<{ txHash: string; reputation: Reputation }> {
    throw new Error('simulated ENS updateReputation write failure');
  }
}

export type FakePaymentsPortOptions = {
  /** txIds `confirm()` reports as confirmed; omit to auto-confirm every `pay()`d txId. */
  confirmedTxIds?: Iterable<string>;
};

/** In-memory `PaymentsPort`. Records every call so tests can assert on it. */
export class FakePaymentsPort implements PaymentsPort {
  readonly payCalls: Array<{ amountHbar: number; requestHash: string }> = [];
  readonly confirmCalls: string[] = [];
  readonly postBondCalls: number[] = [];
  readonly slashCalls: Array<{ bondRef: string; toChallenger: string }> = [];
  private readonly confirmed: Set<string>;
  private readonly autoConfirm: boolean;
  private paySeq = 0;
  private bondSeq = 0;

  constructor(opts: FakePaymentsPortOptions = {}) {
    this.autoConfirm = opts.confirmedTxIds === undefined;
    this.confirmed = new Set(opts.confirmedTxIds ?? []);
  }

  async pay(amountHbar: number, requestHash: string): Promise<{ txId: string }> {
    this.payCalls.push({ amountHbar, requestHash });
    this.paySeq += 1;
    const txId = `0xfake-pay-${this.paySeq}`;
    if (this.autoConfirm) this.confirmed.add(txId);
    return { txId };
  }

  async confirm(txId: string): Promise<boolean> {
    this.confirmCalls.push(txId);
    return this.confirmed.has(txId);
  }

  async postBond(amountHbar: number): Promise<{ bondRef: string; txId: string }> {
    this.postBondCalls.push(amountHbar);
    this.bondSeq += 1;
    return { bondRef: `fake-bond-${this.bondSeq}`, txId: `0xfake-bond-${this.bondSeq}` };
  }

  async slash(bondRef: string, toChallenger: string): Promise<{ txId: string }> {
    this.slashCalls.push({ bondRef, toChallenger });
    return { txId: `0xfake-slash-${this.slashCalls.length}` };
  }
}

/** `GraphPort` fixed to one block/signals fixture; these tests never exercise it (the loop paths under test never reach it directly), it's here only to satisfy `AssayNodeConfig`. */
export class FakeGraphPort implements GraphPort {
  async getLatestBlock(): Promise<number> {
    return 1;
  }

  async getTokenSignals(_token: string, atBlock?: number): Promise<TokenSignals> {
    return {
      atBlock: atBlock ?? 1,
      liquidityUsd: 0,
      ageBlocks: 0,
      txCount: 0,
      volumeUsd: 0,
      topPoolConcentrationPct: 0,
    };
  }
}
