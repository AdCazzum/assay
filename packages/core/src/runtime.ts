/**
 * The capability runtime: the generic seam described in SPEC.md §4 and §6.
 *
 * It registers `Capability<Req, Res>` objects by id and runs/verifies them.
 * It contains zero knowledge of what any capability actually computes (no
 * rug-score, no tokens, no The Graph): if this file ever needs a domain
 * import, the design has broken down.
 */

import type { Capability, Claim, Verdict } from './types.js';

/**
 * Thrown when a capability id is not registered. Named so it is easy to catch
 * on stage, and lists what *is* registered so a live demo can recover fast
 * instead of staring at a bare "not found".
 */
export class UnknownCapabilityError extends Error {
  readonly capabilityId: string;
  readonly registeredIds: readonly string[];

  constructor(capabilityId: string, registeredIds: readonly string[]) {
    const known =
      registeredIds.length > 0 ? registeredIds.join(', ') : '(none registered)';
    super(`Unknown capability "${capabilityId}". Registered capabilities: ${known}.`);
    this.name = 'UnknownCapabilityError';
    this.capabilityId = capabilityId;
    this.registeredIds = registeredIds;
  }
}

/** Thrown when a capability id is registered a second time. */
export class DuplicateCapabilityError extends Error {
  readonly capabilityId: string;

  constructor(capabilityId: string) {
    super(
      `Capability "${capabilityId}" is already registered. Register each capability id once.`,
    );
    this.name = 'DuplicateCapabilityError';
    this.capabilityId = capabilityId;
  }
}

/**
 * The generic registry: register a capability, then run/verify it by id
 * without the caller (or this runtime) knowing anything about its Req/Res
 * shape.
 */
export interface CapabilityRegistry {
  /** Registers a capability. Throws `DuplicateCapabilityError` if its id is already taken. */
  register<Req, Res>(capability: Capability<Req, Res>): void;
  /** Looks up a capability by id. Throws `UnknownCapabilityError` if absent. */
  get<Req = unknown, Res = unknown>(id: string): Capability<Req, Res>;
  /** True iff `id` is registered. */
  has(id: string): boolean;
  /** All registered capability ids. */
  list(): string[];
  /** Runs a registered capability's `run`. Throws `UnknownCapabilityError` if `id` is absent. */
  run<Req, Res>(id: string, req: Req): Promise<{ result: Res; claims: Claim[] }>;
  /** Runs a registered capability's `verify`. Throws `UnknownCapabilityError` if `id` is absent. */
  verify<Req, Res>(
    id: string,
    req: Req,
    result: Res,
    claims: Claim[],
  ): Promise<Verdict>;
}

/** Creates an empty, in-memory capability registry. */
export function createCapabilityRegistry(): CapabilityRegistry {
  const capabilities = new Map<string, Capability<unknown, unknown>>();

  function requireCapability(id: string): Capability<unknown, unknown> {
    const capability = capabilities.get(id);
    if (!capability) {
      throw new UnknownCapabilityError(id, [...capabilities.keys()]);
    }
    return capability;
  }

  return {
    register(capability) {
      if (capabilities.has(capability.id)) {
        throw new DuplicateCapabilityError(capability.id);
      }
      capabilities.set(capability.id, capability as Capability<unknown, unknown>);
    },

    get(id) {
      return requireCapability(id) as Capability<any, any>;
    },

    has(id) {
      return capabilities.has(id);
    },

    list() {
      return [...capabilities.keys()];
    },

    async run(id, req) {
      const capability = requireCapability(id);
      return capability.run(req) as ReturnType<Capability<unknown, unknown>['run']> as Promise<{
        result: any;
        claims: Claim[];
      }>;
    },

    async verify(id, req, result, claims) {
      const capability = requireCapability(id);
      return capability.verify(req, result, claims);
    },
  };
}
