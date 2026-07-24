/**
 * `RegistryPort` over ENS on Sepolia. See SPEC.md §4, §5, §12.
 *
 * `publishManifest` / `resolveProvider` (issue #15) and `updateReputation`
 * (issue #16) are both implemented here.
 */

import type { Manifest, ProviderRecord, RegistryPort, Reputation } from '@assay/core';
import { createEthersEnsGateway, type EnsResolverGateway, type EnsWriteAttemptState } from './ens-gateway.js';
import { InvalidReputationError, UnownedNameError } from './errors.js';
import {
  MANIFEST_RECORD_KEY,
  REPUTATION_RECORD_KEY,
  decodeManifest,
  decodeReputation,
  encodeManifest,
  encodeReputation,
} from './manifest-codec.js';
import { MissingRecordError } from './errors.js';

/**
 * Progress ticks for `updateReputation`'s read-modify-write, so a caller (the
 * dashboard) can render "in flight" instead of freezing during the ~24s an
 * ENS write took in the one live sample measured so far (#53). `'reading'`
 * covers the (fast) `getText` round trip; `'writing'` re-surfaces the
 * underlying `EnsResolverGateway.setText`'s own `EnsWriteAttempt` ticks
 * (`'submitted'` once broadcast, `'pending'` on a heartbeat while mining,
 * `'confirmed'` once mined); `'done'` fires once with the total elapsed time
 * and the resulting `txHash`.
 */
export type ReputationWriteProgress =
  | { phase: 'reading'; elapsedMs: number }
  | { phase: 'writing'; writeState: EnsWriteAttemptState; elapsedMs: number }
  | { phase: 'done'; elapsedMs: number; txHash: string };

export interface CreateEnsRegistryOptions {
  /** Sepolia JSON-RPC endpoint. Ignored if `gateway` is supplied. */
  rpcUrl: string;
  /** Private key of the wallet that owns `parentName` (and its subnames). Ignored if `gateway` is supplied. */
  privateKey: string;
  /** e.g. `assay.eth`. Every `name` passed in must equal this or be a subname under it. */
  parentName: string;
  /**
   * Overrides the resolver gateway. This is the seam unit tests use to drive
   * a `FakeEnsResolverGateway` in place of real Sepolia RPC calls; production
   * callers should never set it (the real `createEthersEnsGateway` is built
   * from `rpcUrl`/`privateKey` when omitted).
   */
  gateway?: EnsResolverGateway;
  /**
   * Observability hook for `updateReputation`'s read-modify-write (see
   * `ReputationWriteProgress`). `RegistryPort.updateReputation`'s return
   * type is fixed (no room for a per-call callback), so — the same way
   * `@assay/payments`' `HederaPaymentsPortConfig.onConfirmAttempt` is bound
   * at construction time — this is bound once per `createEnsRegistry` call
   * rather than passed per-call.
   */
  onReputationWriteAttempt?: (info: ReputationWriteProgress) => void;
}

/**
 * The reputation state a provider implicitly has before `updateReputation`
 * is ever called for it: no jobs served, no slashes, no bond posted, a
 * neutral score. Every other `RegistryPort` test double in this repo already
 * defaults an unseeded provider to exactly this shape
 * (`packages/core/src/test-support/fakes.ts`,
 * `apps/mcp/src/test-support/live-ports.ts`, `apps/provider/src/fakes.ts`),
 * so a first-ever write here starts from that same zero state rather than a
 * value invented just for the real adapter.
 */
const ZERO_REPUTATION: Reputation = { score: 0, jobs: 0, slashes: 0, bondHbar: 0 };

/** `field`'s valid range in a `Reputation` that is safe to publish. `max` omitted means unbounded above. */
const REPUTATION_BOUNDS: Record<keyof Reputation, { min: number; max?: number }> = {
  score: { min: 0, max: 100 },
  jobs: { min: 0 },
  slashes: { min: 0 },
  bondHbar: { min: 0 },
};

/**
 * Refuses to publish a `Reputation` outside its valid range. Per SPEC.md
 * §12/the issue's own instructions, an out-of-range value here is always a
 * bug upstream (a bad delta, or a corrupt existing record), never a
 * legitimate state — so this fails loudly rather than clamping the value
 * silently and writing something the caller didn't actually ask for.
 */
function assertValidReputation(candidate: Reputation, ensName: string): void {
  for (const field of Object.keys(REPUTATION_BOUNDS) as Array<keyof Reputation>) {
    const value = candidate[field];
    const bounds = REPUTATION_BOUNDS[field];
    if (!Number.isFinite(value)) {
      throw new InvalidReputationError(ensName, field, value, 'must be a finite number');
    }
    if (value < bounds.min) {
      throw new InvalidReputationError(ensName, field, value, `must be >= ${bounds.min}`);
    }
    if (bounds.max !== undefined && value > bounds.max) {
      throw new InvalidReputationError(ensName, field, value, `must be <= ${bounds.max}`);
    }
  }
}

/**
 * A text record that was never written is not a broken one.
 *
 * ethers reports an unset record as an empty string, and only returns null
 * when the resolver cannot answer at all. Both mean "nothing here", and both
 * have to be caught before the JSON decoder sees them, or an uninitialised
 * provider is reported as having a corrupt record. That distinction matters
 * to whoever reads the error: "not set yet" is the normal state of a name
 * that was just registered, "malformed" says someone wrote garbage into it.
 */
function isUnset(raw: string | null): raw is null {
  return raw === null || raw.trim() === '';
}

export function createEnsRegistry(opts: CreateEnsRegistryOptions): RegistryPort {
  const gateway = opts.gateway ?? createEthersEnsGateway({ rpcUrl: opts.rpcUrl, privateKey: opts.privateKey });
  const parentName = opts.parentName;

  function assertOwnedName(name: string): void {
    if (name !== parentName && !name.endsWith(`.${parentName}`)) {
      throw new UnownedNameError(name, parentName);
    }
  }

  return {
    async publishManifest(name, manifest: Manifest) {
      assertOwnedName(name);
      const { txHash } = await gateway.setText(name, MANIFEST_RECORD_KEY, encodeManifest(manifest));
      return { txHash };
    },

    async resolveProvider(name): Promise<ProviderRecord> {
      assertOwnedName(name);

      const manifestRaw = await gateway.getText(name, MANIFEST_RECORD_KEY);
      if (isUnset(manifestRaw)) {
        throw new MissingRecordError(MANIFEST_RECORD_KEY, name);
      }
      const manifest = decodeManifest(manifestRaw, name);

      const reputationRaw = await gateway.getText(name, REPUTATION_RECORD_KEY);
      if (isUnset(reputationRaw)) {
        throw new MissingRecordError(REPUTATION_RECORD_KEY, name);
      }
      const reputation = decodeReputation(reputationRaw, name);

      return { name, manifest, reputation };
    },

    /**
     * Read-modify-write against Sepolia's `assay:rep` text record.
     *
     * Semantics of `delta`: an **absolute patch**, merged onto the existing
     * (or, for a name written for the first time, `ZERO_REPUTATION`) record
     * field-by-field — not a mathematical increment. This was not free to
     * choose: every other `RegistryPort` in this repo already commits to it
     * (`packages/core/src/test-support/fakes.ts`'s and
     * `apps/mcp/src/test-support/live-ports.ts`'s `FakeRegistryPort`s both
     * do `{ ...existing.reputation, ...delta }`), and `apps/mcp`'s
     * `live-node.ts` `rate()` already calls the real port this way in
     * production code — it reads `current.reputation.jobs` itself and
     * passes `{ jobs: current.reputation.jobs + 1 }`, not `{ jobs: 1 }`.
     * Implementing additive semantics here instead would silently
     * double-count against that caller. So: the caller decides what
     * "apply the delta" means for each field it sets; this function's job
     * is only to merge, validate, and publish the result.
     *
     * Initialization: a name with no `assay:rep` yet is the normal state of
     * a freshly registered provider (see `isUnset`'s doc comment above), not
     * a corrupt one, so it is treated as `ZERO_REPUTATION` rather than
     * making the caller special-case "first write" itself.
     *
     * Concurrency: this is a plain read-then-write, not a compare-and-swap.
     * ENS text records have no on-chain equivalent of an atomic increment or
     * an optimistic-lock version field, and building one is out of scope
     * (SPEC.md §17 rules out a real staking/consensus protocol here). Two
     * concurrent `updateReputation` calls against the same `name` can both
     * read the same base and race to write; whichever transaction lands
     * second on Sepolia wins outright and silently drops the first call's
     * delta — there is no merge of the two deltas. That risk is bounded,
     * not solved, in this build: only the provider's own Assay node ever
     * calls `updateReputation` for its own name, as one step of the
     * sequential register/serve/challenge/settle loop (SPEC.md §7), so two
     * writers racing on the same name is not expected during the demo. A
     * production version would need either a per-name write queue or a
     * contract-based reputation store with real compare-and-swap; flagging
     * it here rather than quietly risking it.
     */
    async updateReputation(name, delta: Partial<Reputation>) {
      assertOwnedName(name);
      const start = Date.now();
      const onProgress = opts.onReputationWriteAttempt;

      onProgress?.({ phase: 'reading', elapsedMs: 0 });
      const raw = await gateway.getText(name, REPUTATION_RECORD_KEY);
      const base: Reputation = isUnset(raw) ? ZERO_REPUTATION : decodeReputation(raw, name);

      const candidate: Reputation = { ...base, ...delta };
      assertValidReputation(candidate, name);

      const { txHash } = await gateway.setText(
        name,
        REPUTATION_RECORD_KEY,
        encodeReputation(candidate),
        (attempt) => {
          onProgress?.({ phase: 'writing', writeState: attempt.state, elapsedMs: Date.now() - start });
        },
      );

      onProgress?.({ phase: 'done', elapsedMs: Date.now() - start, txHash });
      return { txHash, reputation: candidate };
    },
  };
}
