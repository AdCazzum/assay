/**
 * Typed errors for the ENS registry adapter. See SPEC.md §5 and §12.
 *
 * `resolveProvider` feeds a requester agent's pay-or-not decision, so a bad
 * record must fail loudly and specifically rather than as a generic Error:
 * the caller (or an MCP tool wrapping this) can tell "this provider doesn't
 * exist" apart from "this provider is misconfigured" apart from "this
 * provider's data is corrupt".
 */

/** Base class for every error this package throws. */
export class EnsRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * `name` has no resolver set on the ENS registry: either the name (or
 * subname) does not exist yet, or it exists but was never given a resolver.
 * Both reads and writes need a resolver, so this is thrown from either path.
 */
export class NoResolverConfiguredError extends EnsRegistryError {
  constructor(public readonly ensName: string) {
    super(
      `no resolver configured for "${ensName}". The name must exist and have ` +
        `a resolver set (e.g. via the ENS Manager app, or a ` +
        `setSubnodeRecord/setResolver call from the parent name's owner) ` +
        `before Assay can read or write its text records.`,
    );
  }
}

/** The resolver exists but the requested text record key was never set. */
export class MissingRecordError extends EnsRegistryError {
  constructor(
    public readonly recordKey: string,
    public readonly ensName: string,
  ) {
    super(`text record "${recordKey}" is not set for "${ensName}"`);
  }
}

/**
 * The text record is set but is not parseable JSON, or does not match the
 * shape Assay expects (missing field, wrong type).
 */
export class MalformedRecordError extends EnsRegistryError {
  constructor(
    public readonly recordKey: string,
    public readonly ensName: string,
    public readonly reason: string,
  ) {
    super(`text record "${recordKey}" for "${ensName}" is malformed: ${reason}`);
  }
}

/** `name` is not the configured parent, nor a subname under it. */
export class UnownedNameError extends EnsRegistryError {
  constructor(
    public readonly ensName: string,
    public readonly parentName: string,
  ) {
    super(`"${ensName}" is not "${parentName}" nor a subname under it`);
  }
}
