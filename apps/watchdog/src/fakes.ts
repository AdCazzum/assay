/**
 * Named test doubles for the three `@assay/core` ports (SPEC.md §11 / AGENTS.md
 * "never fake an integration" rule). None of these are `@assay/registry` /
 * `@assay/payments` / `@assay/graph`; they exist so this app's watchdog logic
 * is unit-testable with zero network.
 *
 * `@assay/core` has its own equivalents under `packages/core/src/test-support/`,
 * but that module is deliberately not part of `@assay/core`'s public exports
 * (its `package.json` only exposes `"."`), so it cannot be imported from here.
 * This is this app's own copy, the same way `apps/provider/src/fakes.ts` and
 * `apps/mcp/src/test-support/live-ports.ts` each keep their own.
 */

import type { GraphPort, Manifest, PaymentsPort, ProviderRecord, RegistryPort, Reputation, TokenSignals } from '@assay/core';

/** Thrown by `FakeRegistryPort` when asked to resolve a name nobody seeded. */
export class UnknownFixtureProviderError extends Error {
  constructor(readonly providerName: string) {
    super(`FakeRegistryPort: no provider record seeded for "${providerName}".`);
    this.name = 'UnknownFixtureProviderError';
  }
}

/** In-memory `RegistryPort`. `updateReputation` merges the delta onto the existing record, matching the real adapter's read-modify-write semantics (`packages/registry/src/ens-registry.ts`). */
export class FakeRegistryPort implements RegistryPort {
  private readonly records = new Map<string, ProviderRecord>();
  readonly updateReputationCalls: Array<{ name: string; delta: Partial<Reputation> }> = [];
  private txSeq = 0;

  /** Seeds `name` as already resolvable, as if it had been registered before this test started. */
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
    const existing = this.records.get(name);
    if (!existing) throw new UnknownFixtureProviderError(name);
    this.updateReputationCalls.push({ name, delta });
    this.txSeq += 1;
    const reputation: Reputation = { ...existing.reputation, ...delta };
    this.records.set(name, { ...existing, reputation });
    return { txHash: `0xfake-rep-${this.txSeq}`, reputation };
  }
}

export type FakePaymentsPortOptions = {
  /** txIds `confirm()` reports as confirmed. Omit to auto-confirm every `pay()`-minted txId. */
  confirmedTxIds?: Iterable<string>;
};

/** In-memory `PaymentsPort`. Records every call so tests can assert on it, including every `slash()` (bondRef, toChallenger, txId). */
export class FakePaymentsPort implements PaymentsPort {
  readonly payCalls: Array<{ amountHbar: number; requestHash: string }> = [];
  readonly confirmCalls: string[] = [];
  readonly postBondCalls: number[] = [];
  readonly slashCalls: Array<{ bondRef: string; toChallenger: string; txId: string }> = [];
  private readonly confirmed: Set<string>;
  private readonly autoConfirm: boolean;
  private paySeq = 0;
  private bondSeq = 0;
  private slashSeq = 0;

  constructor(opts: FakePaymentsPortOptions = {}) {
    this.autoConfirm = opts.confirmedTxIds === undefined;
    this.confirmed = new Set(opts.confirmedTxIds ?? []);
  }

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
    this.slashSeq += 1;
    const txId = `0xfake-slash-${this.slashSeq}`;
    this.slashCalls.push({ bondRef, toChallenger, txId });
    return { txId };
  }
}

/**
 * `GraphPort` fixed to one block, backed by a per-token signals map. Reused
 * for both the honest and lying capability in tests, so `watchdog.test.ts`
 * exercises the real `@assay/cap-rugscore` verifier, not a toy stand-in.
 */
export class FakeGraphPort implements GraphPort {
  readonly calls: Array<{ token: string; atBlock?: number }> = [];

  constructor(
    private readonly latestBlock: number,
    private readonly signalsByToken: Record<string, TokenSignals>,
  ) {}

  async getLatestBlock(): Promise<number> {
    return this.latestBlock;
  }

  async getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals> {
    this.calls.push({ token, atBlock });
    const entry = this.signalsByToken[token];
    if (!entry) {
      throw new Error(`FakeGraphPort: no fixture registered for token "${token}"`);
    }
    return { ...entry, atBlock: atBlock ?? entry.atBlock };
  }
}
