/**
 * Named test doubles for the three ports (`RegistryPort`, `PaymentsPort`,
 * `GraphPort`), honestly labeled per SPEC.md §11 / AGENTS.md's "never fake an
 * integration" rule. None of these are `@assay/registry` / `@assay/payments` /
 * `@assay/graph`; they exist so this app is unit-testable and demoable with
 * zero network.
 *
 * `@assay/core` has its own equivalents in `packages/core/src/test-support/`,
 * but that module is test-only and deliberately not part of `@assay/core`'s
 * public exports (its `package.json` only exposes `"."`), so it cannot be
 * imported from here. This file is this app's own copy, used two ways:
 *
 *  - by `service.test.ts`, to drive `createAssayNode` with zero network;
 *  - by `index.ts`'s default "demo mode", which runs the whole provider loop
 *    (register a manifest, pay, confirm, serve rug-score) end to end against
 *    these fakes, so the demo is rehearsable offline. This is the opposite of
 *    `@assay/mcp`'s `NotWiredAssayNode`: rather than a placeholder that
 *    throws, this app's demo mode is meant to actually run today, just
 *    against fakes instead of live Hedera/ENS/Graph credentials. Wiring the
 *    real adapters in is out of scope for issue #8 (the ENS name is not even
 *    registered yet, see AGENTS.md), and left as a follow-up.
 */

import type {
  GraphPort,
  Manifest,
  PaymentsPort,
  ProviderRecord,
  RegistryPort,
  Reputation,
  TokenSignals,
} from '@assay/core';

/** In-memory `RegistryPort`. Reads/writes a `Map`, nothing hardcoded. */
export class FakeRegistryPort implements RegistryPort {
  private readonly records = new Map<string, ProviderRecord>();
  private txSeq = 0;

  /** Seeds `name` as already resolvable, as if it had been registered before. */
  seed(name: string, record: Omit<ProviderRecord, 'name'>): this {
    this.records.set(name, { name, ...record });
    return this;
  }

  async resolveProvider(name: string): Promise<ProviderRecord> {
    const record = this.records.get(name);
    if (!record) throw new Error(`FakeRegistryPort: no provider record for "${name}".`);
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
    const existing = this.records.get(name);
    if (!existing) throw new Error(`FakeRegistryPort: no provider record for "${name}".`);
    this.txSeq += 1;
    const reputation: Reputation = { ...existing.reputation, ...delta };
    this.records.set(name, { ...existing, reputation });
    return { txHash: `0xfake-rep-${this.txSeq}`, reputation };
  }
}

export type FakePaymentsPortOptions = {
  /**
   * txIds `confirm()` reports as confirmed. Omit to make every `pay()`-minted
   * txId confirm automatically (the happy path); pass a list (empty or not)
   * to make `pay()` mint txIds that stay unconfirmed until `setConfirmed()`
   * says otherwise — this is how tests drive the payment gate.
   */
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

  /** Marks `txId` confirmed (or explicitly not). */
  setConfirmed(txId: string, confirmed = true): this {
    if (confirmed) this.confirmed.add(txId);
    else this.confirmed.delete(txId);
    return this;
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

/**
 * A `PaymentsPort` whose `confirm()` never resolves, on purpose: it exists
 * only to prove `ProviderService` times out instead of hanging when a
 * payment never confirms (see `service.test.ts`). Not a stand-in for any
 * plausible real behavior; a real mirror-node poll always eventually
 * resolves or rejects (see `@assay/payments`'s `pollMirrorNode`).
 */
export class HangingPaymentsPort implements PaymentsPort {
  private paySeq = 0;

  async pay(_amountHbar: number, _requestHash: string): Promise<{ txId: string }> {
    this.paySeq += 1;
    return { txId: `0xfake-hanging-pay-${this.paySeq}` };
  }

  confirm(_txId: string): Promise<boolean> {
    return new Promise(() => {
      // deliberately never settles
    });
  }

  async postBond(_amountHbar: number): Promise<{ bondRef: string; txId: string }> {
    return { bondRef: 'fake-bond-hanging', txId: '0xfake-bond-hanging' };
  }

  async slash(bondRef: string, toChallenger: string): Promise<{ txId: string }> {
    return { txId: `0xfake-slash-${bondRef}-${toChallenger}` };
  }
}

/**
 * `GraphPort` fixed to one block and one signals fixture. Rug-score's `run()`
 * only needs *a* `GraphPort` to compute a score; the verifier re-deriving
 * from a live Token API is `@assay/graph`'s job, not this app's.
 */
export class FakeGraphPort implements GraphPort {
  constructor(
    private readonly latestBlock = 1,
    private readonly signals: TokenSignals = {
      atBlock: 1,
      holders: 120,
      top10Pct: 18,
      liquidityUsd: 250_000,
      ageBlocks: 900_000,
      transfers: 4_200,
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
