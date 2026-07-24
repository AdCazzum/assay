import { describe, expect, it } from 'vitest';
import { ClaimVerificationUnavailableError } from './errors.js';

describe('ClaimVerificationUnavailableError', () => {
  it('names the claim and the block it could not verify', () => {
    const err = new ClaimVerificationUnavailableError('liquidityUsd', 123, new Error('gateway 429'));
    expect(err.claimKey).toBe('liquidityUsd');
    expect(err.atBlock).toBe(123);
  });

  it('carries the underlying cause', () => {
    const cause = new Error('gateway 429');
    const err = new ClaimVerificationUnavailableError('liquidityUsd', 123, cause);
    expect(err.cause).toBe(cause);
  });

  it('states in its own message that this is not evidence of a lie', () => {
    const err = new ClaimVerificationUnavailableError('liquidityUsd', 123, new Error('gateway 429'));
    expect(err.message.toLowerCase()).toContain('not');
    expect(err.message.toLowerCase()).toContain('liquidityusd');
  });

  it('is a real Error subclass, distinguishable by name', () => {
    const err = new ClaimVerificationUnavailableError('txCount', 1, new Error('boom'));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ClaimVerificationUnavailableError');
  });
});
