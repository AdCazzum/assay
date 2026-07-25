/**
 * Named test doubles for the three `@assay/core` ports (SPEC.md §11 /
 * AGENTS.md "never fake an integration" rule). This app's own copy, same
 * reason `apps/watchdog/src/fakes.ts` and `apps/provider/src/fakes.ts` each
 * keep theirs: `@assay/core`'s equivalents under `packages/core/src/test-support/`
 * are not part of its public exports.
 */

import type { GraphPort, Manifest, PaymentsPort, ProviderRecord, RegistryPort, Reputation, TokenSignals } from '@assay/core';

export class UnknownFixtureProviderError extends Error {
  constructor(readonly providerName: string) {
    super(`FakeRegistryPort: no provider record seeded for "${providerName}".`);
    this.name = 'UnknownFixtureProviderError';
  }
}

/** In-memory `RegistryPort`. `updateReputation` merges the delta onto the existing record, matching the real adapter's read-modify-write semantics. */
export class FakeRegistryPort implements RegistryPort {
  private readonly records = new Map<string, ProviderRecord>();
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

  async updateReputation(name: string, delta: Partial<Reputation>): Promise<{ txHash: string; reputation: Reputation }> {
    const existing = this.records.get(name);
    if (!existing) throw new UnknownFixtureProviderError(name);
    this.txSeq += 1;
    const reputation: Reputation = { ...existing.reputation, ...delta };
    this.records.set(name, { ...existing, reputation });
    return { txHash: `0xfake-rep-${this.txSeq}`, reputation };
  }
}

export type FakePaymentsPortOptions = {
  /** Delays every `pay()`/`postBond()`/`slash()` resolution by this many ms — lets a test observe the "running" guard window a real network call would otherwise create. */
  delayMs?: number;
};

/** In-memory `PaymentsPort`. Auto-confirms every minted txId (this app's pay step calls `confirmPayment` immediately after `pay`, so there is never a pending window to model here). */
export class FakePaymentsPort implements PaymentsPort {
  readonly payCalls: Array<{ amountHbar: number; requestHash: string }> = [];
  readonly slashCalls: Array<{ bondRef: string; toChallenger: string }> = [];
  private readonly confirmed = new Set<string>();
  private paySeq = 0;
  private bondSeq = 0;
  private slashSeq = 0;
  private readonly delayMs: number;

  constructor(opts: FakePaymentsPortOptions = {}) {
    this.delayMs = opts.delayMs ?? 0;
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async pay(amountHbar: number, requestHash: string): Promise<{ txId: string }> {
    await this.wait();
    this.payCalls.push({ amountHbar, requestHash });
    this.paySeq += 1;
    const txId = `0xfake-pay-${this.paySeq}`;
    this.confirmed.add(txId);
    return { txId };
  }

  async confirm(txId: string): Promise<boolean> {
    return this.confirmed.has(txId);
  }

  async confirmPayment(input: { txId: string; expectedAmountHbar: number; expectedMemo: string }) {
    return { confirmed: this.confirmed.has(input.txId) };
  }

  async postBond(amountHbar: number): Promise<{ bondRef: string; txId: string }> {
    await this.wait();
    this.bondSeq += 1;
    return { bondRef: `fake-bond-${this.bondSeq}`, txId: `0xfake-bond-${this.bondSeq}` };
  }

  async slash(bondRef: string, toChallenger: string): Promise<{ txId: string }> {
    await this.wait();
    this.slashSeq += 1;
    this.slashCalls.push({ bondRef, toChallenger });
    return { txId: `0xfake-slash-${this.slashSeq}` };
  }
}

/** `GraphPort` fixed to one block, backed by a per-token signals map — same shape `apps/watchdog/src/fakes.ts` uses, so both apps exercise the real `@assay/cap-rugscore` verifier, not a toy stand-in. */
export class FakeGraphPort implements GraphPort {
  constructor(
    private readonly latestBlock: number,
    private readonly signalsByToken: Record<string, TokenSignals>,
  ) {}

  async getLatestBlock(): Promise<number> {
    return this.latestBlock;
  }

  async getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals> {
    const entry = this.signalsByToken[token];
    if (!entry) throw new Error(`FakeGraphPort: no fixture registered for token "${token}"`);
    return { ...entry, atBlock: atBlock ?? entry.atBlock };
  }
}
