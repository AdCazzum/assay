/**
 * `FakeEnsResolverGateway` — an obviously-named test double for
 * `EnsResolverGateway`. Backs text records with a plain in-memory `Map`
 * instead of a Sepolia RPC call. Not exported from the package's public
 * entry point: this is test-only support, never something a caller could
 * mistake for the real chain-backed gateway.
 */

import { NoResolverConfiguredError } from './errors.js';
import type { EnsResolverGateway, EnsWriteAttempt } from './ens-gateway.js';

export class FakeEnsResolverGateway implements EnsResolverGateway {
  private readonly records = new Map<string, Map<string, string>>();
  private readonly namesWithoutResolver = new Set<string>();
  private txCounter = 0;

  /** Marks `name` as having no resolver set, so both `getText`/`setText` throw. */
  withNoResolver(name: string): this {
    this.namesWithoutResolver.add(name);
    return this;
  }

  /** Seeds `name`'s `key` text record directly, bypassing `setText`. */
  seedText(name: string, key: string, value: string): this {
    this.recordsFor(name).set(key, value);
    return this;
  }

  async getText(name: string, key: string): Promise<string | null> {
    if (this.namesWithoutResolver.has(name)) {
      throw new NoResolverConfiguredError(name);
    }
    return this.recordsFor(name).get(key) ?? null;
  }

  async setText(
    name: string,
    key: string,
    value: string,
    onAttempt?: (info: EnsWriteAttempt) => void,
  ): Promise<{ txHash: string }> {
    if (this.namesWithoutResolver.has(name)) {
      throw new NoResolverConfiguredError(name);
    }
    // No real chain here, so there is nothing to be genuinely "pending" on;
    // still fire the same 'submitted' -> 'confirmed' sequence a real write
    // would (see `createEthersEnsGateway`), so a caller wiring up
    // `onAttempt` can be unit-tested against this fake instead of only ever
    // exercised live against Sepolia.
    onAttempt?.({ state: 'submitted', elapsedMs: 0 });
    this.recordsFor(name).set(key, value);
    this.txCounter += 1;
    onAttempt?.({ state: 'confirmed', elapsedMs: 0 });
    return { txHash: `0xfake${this.txCounter}` };
  }

  private recordsFor(name: string): Map<string, string> {
    let m = this.records.get(name);
    if (!m) {
      m = new Map();
      this.records.set(name, m);
    }
    return m;
  }
}
