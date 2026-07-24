/**
 * Obviously-named test doubles for the three ports, used to drive
 * `createAssayNode` (and the loop it exposes) with zero network. None of
 * these are real adapters: `@assay/registry`, `@assay/payments`, `@assay/graph`
 * are, and this package deliberately does not depend on any of them (core
 * knows the ports, not the adapters). Test-only, not exported from this
 * package's public entry point (`index.ts`) — the same discipline
 * `@assay/registry`'s `FakeEnsResolverGateway` and `@assay/cap-rugscore`'s
 * `FakeGraphPort` already follow, so nobody mistakes a fake for the sponsor
 * integration it stands in for.
 */

import type { GraphPort, PaymentsPort, RegistryPort, TokenSignals } from '../ports.js';
import type { Manifest, ProviderRecord, Reputation } from '../types.js';

/** Thrown by `FakeRegistryPort` when asked to resolve a name nobody seeded or published. */
export class UnknownProviderRecordError extends Error {
  readonly providerName: string;

  constructor(providerName: string) {
    super(`FakeRegistryPort: no provider record for "${providerName}".`);
    this.name = 'UnknownProviderRecordError';
    this.providerName = providerName;
  }
}

/**
 * In-memory `RegistryPort`. `resolveProvider` reads whatever was seeded via
 * `seed()` or written via `publishManifest`/`updateReputation`; nothing is
 * hardcoded per SPEC.md §11's ENS rule, it is just backed by a `Map` instead
 * of Sepolia RPC calls.
 */
export class FakeRegistryPort implements RegistryPort {
  private readonly records = new Map<string, ProviderRecord>();
  readonly publishedManifests: Array<{ name: string; manifest: Manifest }> = [];
  readonly reputationUpdates: Array<{ name: string; delta: Partial<Reputation> }> = [];
  private txSeq = 0;

  /** Seeds `name` as already resolvable, as if registered before this test started. */
  seed(name: string, record: Omit<ProviderRecord, 'name'>): this {
    this.records.set(name, { name, ...record });
    return this;
  }

  async resolveProvider(name: string): Promise<ProviderRecord> {
    const record = this.records.get(name);
    if (!record) throw new UnknownProviderRecordError(name);
    return record;
  }

  async publishManifest(name: string, manifest: Manifest): Promise<{ txHash: string }> {
    this.publishedManifests.push({ name, manifest });
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
    const existing = this.records.get(name);
    if (!existing) throw new UnknownProviderRecordError(name);
    this.reputationUpdates.push({ name, delta });
    this.txSeq += 1;
    const reputation: Reputation = { ...existing.reputation, ...delta };
    this.records.set(name, { ...existing, reputation });
    return { txHash: `0xfake-rep-${this.txSeq}`, reputation };
  }
}

export type FakePaymentsPortOptions = {
  /**
   * txIds `confirm()` reports as confirmed, checked at construction time.
   * Omit entirely to make every txId `pay()` mints confirm automatically
   * (the happy path); pass an explicit list (empty or not) to make `pay()`
   * mint txIds that stay unconfirmed until `setConfirmed()` says otherwise —
   * this is how tests drive the payment gate.
   */
  confirmedTxIds?: Iterable<string>;
};

/**
 * In-memory `PaymentsPort`. Records every call so tests can assert on call
 * counts/args (e.g. that `confirm()` was actually consulted).
 */
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

  /** Marks `txId` confirmed (or explicitly not), e.g. to simulate a mirror-node confirmation landing after a retry. */
  setConfirmed(txId: string, confirmed = true): this {
    if (confirmed) this.confirmed.add(txId);
    else this.confirmed.delete(txId);
    return this;
  }

  async pay(amountHbar: number, requestHash: string): Promise<{ txId: string }> {
    this.payCalls.push({ amountHbar, requestHash });
    this.paySeq += 1;
    const txId = `0xfake-pay-${this.paySeq}`;
    if (this.autoConfirm) {
      this.confirmed.add(txId);
    }
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

/**
 * `GraphPort` fixed to one block and one signals fixture, for tests that need
 * *a* `GraphPort` to satisfy `AssayNodeConfig` without exercising it (the loop
 * covered here never calls `graph` directly, see node.ts).
 */
export class FakeGraphPort implements GraphPort {
  constructor(
    private readonly latestBlock = 1,
    private readonly signals: TokenSignals = {
      atBlock: 1,
      holders: 0,
      top10Pct: 0,
      liquidityUsd: 0,
      ageBlocks: 0,
      transfers: 0,
      hasActiveMintRole: false,
    },
  ) {}

  async getLatestBlock(): Promise<number> {
    return this.latestBlock;
  }

  async getTokenSignals(_token: string, atBlock?: number): Promise<TokenSignals> {
    return { ...this.signals, atBlock: atBlock ?? this.signals.atBlock };
  }
}
