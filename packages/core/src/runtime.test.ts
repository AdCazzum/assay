import { describe, expect, it } from 'vitest';
import { createCapabilityRegistry, UnknownCapabilityError } from './runtime.js';
import type { Capability } from './types.js';

/** A trivial capability: doubles a number, claims the doubling as a fact. */
const doubler: Capability<number, number> = {
  id: 'doubler',
  async run(req) {
    return { result: req * 2, claims: [{ k: 'doubled', v: req * 2, atBlock: 1 }] };
  },
  async verify(req, result, claims) {
    const claim = claims.find((c) => c.k === 'doubled');
    if (!claim) return { valid: false, reason: 'missing doubled claim' };
    return claim.v === req * 2 && result === req * 2
      ? { valid: true }
      : { valid: false, badClaim: 'doubled' };
  },
};

/** A second, unrelated capability with entirely different Req/Res shapes. */
type GreetReq = { name: string };
type GreetRes = { greeting: string };

const greeter: Capability<GreetReq, GreetRes> = {
  id: 'greeter',
  async run(req) {
    return {
      result: { greeting: `hello, ${req.name}` },
      claims: [{ k: 'nameLength', v: req.name.length, atBlock: 7 }],
    };
  },
  async verify(req, _result, claims) {
    const claim = claims.find((c) => c.k === 'nameLength');
    if (!claim) return { valid: false, reason: 'missing nameLength claim' };
    return claim.v === req.name.length ? { valid: true } : { valid: false, badClaim: 'nameLength' };
  },
};

describe('createCapabilityRegistry', () => {
  it('registers a capability and runs it through the runtime', async () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);

    const { result, claims } = await registry.run('doubler', 21);

    expect(result).toBe(42);
    expect(claims).toEqual([{ k: 'doubled', v: 42, atBlock: 1 }]);
  });

  it('verifies a capability through the runtime', async () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);

    const { result, claims } = await registry.run('doubler', 21);
    const verdict = await registry.verify('doubler', 21, result, claims);

    expect(verdict).toEqual({ valid: true });
  });

  it('catches a lying result via verify', async () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);

    const verdict = await registry.verify(
      'doubler',
      21,
      99, // wrong result
      [{ k: 'doubled', v: 42, atBlock: 1 }],
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.badClaim).toBe('doubled');
  });

  it('throws a typed, named error for an unknown capability id', async () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);
    registry.register(greeter);

    expect(() => registry.get('nope')).toThrow(UnknownCapabilityError);

    try {
      registry.get('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownCapabilityError);
      const e = err as UnknownCapabilityError;
      expect(e.message).toContain('nope');
      expect(e.message).toContain('doubler');
      expect(e.message).toContain('greeter');
    }

    await expect(registry.run('nope', 1)).rejects.toThrow(UnknownCapabilityError);
    await expect(registry.verify('nope', 1, 1, [])).rejects.toThrow(UnknownCapabilityError);
  });

  it('rejects duplicate registration instead of silently overwriting', () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);

    expect(() => registry.register(doubler)).toThrow();
    expect(() => registry.register({ ...doubler, id: 'doubler' })).toThrow();
  });

  it('has() reports whether an id is registered', () => {
    const registry = createCapabilityRegistry();
    expect(registry.has('doubler')).toBe(false);

    registry.register(doubler);
    expect(registry.has('doubler')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });

  it('lists registered ids', () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);
    registry.register(greeter);

    expect(registry.list().sort()).toEqual(['doubler', 'greeter']);
  });

  it('boundary check: two unrelated capabilities with different Req/Res run through the same generic runtime', async () => {
    const registry = createCapabilityRegistry();
    registry.register(doubler);
    registry.register(greeter);

    const doubled = await registry.run('doubler', 10);
    expect(doubled.result).toBe(20);

    const greeted = await registry.run('greeter', { name: 'assay' });
    expect(greeted.result).toEqual({ greeting: 'hello, assay' });

    const doubledVerdict = await registry.verify('doubler', 10, doubled.result, doubled.claims);
    const greetedVerdict = await registry.verify(
      'greeter',
      { name: 'assay' },
      greeted.result,
      greeted.claims,
    );

    expect(doubledVerdict.valid).toBe(true);
    expect(greetedVerdict.valid).toBe(true);
  });
});
