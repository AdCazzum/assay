import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@hashgraph/sdk';

import { assertKeyMatchesAccount, OperatorKeyError, parseOperatorKey } from './operator-key.js';

/**
 * Any 32-byte value is a valid private key on both curves, which is precisely
 * why the curve cannot be inferred from the bytes and why `fromString` guessing
 * is dangerous.
 */
const RAW_HEX = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';

describe('parseOperatorKey', () => {
  it('reads a bare hex string as ECDSA by default, matching what the portal issues', () => {
    const key = parseOperatorKey(RAW_HEX);
    expect(key.publicKey.toStringRaw()).toBe(parseOperatorKey(RAW_HEX, 'ecdsa').publicKey.toStringRaw());
  });

  it('derives genuinely different keys per curve from identical bytes', () => {
    // The bug this module exists to prevent: same input, silently different key.
    const ecdsa = parseOperatorKey(RAW_HEX, 'ecdsa').publicKey.toStringRaw();
    const ed25519 = parseOperatorKey(RAW_HEX, 'ed25519').publicKey.toStringRaw();
    expect(ecdsa).not.toBe(ed25519);
  });

  it('produces a compressed secp256k1 point for ecdsa', () => {
    const pub = parseOperatorKey(RAW_HEX, 'ecdsa').publicKey.toStringRaw();
    expect(pub).toMatch(/^0[23][0-9a-f]{64}$/i);
  });

  it('detects DER encoding without being told, because DER names its own curve', () => {
    const der = PrivateKey.generateECDSA().toStringDer();
    expect(parseOperatorKey(der).publicKey.toStringRaw()).toBe(PrivateKey.fromStringDer(der).publicKey.toStringRaw());
  });

  it('round-trips an ED25519 DER key through the same auto-detection', () => {
    const generated = PrivateKey.generateED25519();
    expect(parseOperatorKey(generated.toStringDer()).publicKey.toStringRaw()).toBe(generated.publicKey.toStringRaw());
  });

  it('rejects an empty key instead of failing later at the network', () => {
    expect(() => parseOperatorKey('  ')).toThrow(OperatorKeyError);
  });

  it('reports the curve it tried when the input cannot be parsed', () => {
    expect(() => parseOperatorKey('not-a-key', 'ecdsa')).toThrow(/ecdsa/);
  });
});

describe('assertKeyMatchesAccount', () => {
  const key = parseOperatorKey(RAW_HEX, 'ecdsa');
  const mirrorNodeBaseUrl = 'https://testnet.mirrornode.hedera.com';

  /** Obviously a double: returns whatever account payload the test wants. */
  const fakeMirrorNode = (body: unknown, ok = true, status = 200): typeof fetch =>
    (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

  it('passes when the derived public key is the one the account publishes', async () => {
    const fetchImpl = fakeMirrorNode({
      key: { _type: 'ECDSA_SECP256K1', key: key.publicKey.toStringRaw() },
    });
    await expect(
      assertKeyMatchesAccount({ accountId: '0.0.1', key, mirrorNodeBaseUrl, fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('names the right curve when the key is the wrong one for the account', async () => {
    const fetchImpl = fakeMirrorNode({
      key: { _type: 'ED25519', key: parseOperatorKey(RAW_HEX, 'ed25519').publicKey.toStringRaw() },
    });
    await expect(
      assertKeyMatchesAccount({ accountId: '0.0.1', key, mirrorNodeBaseUrl, fetchImpl }),
    ).rejects.toThrow(/HEDERA_KEY_TYPE=ed25519/);
  });

  it('explains an unreadable account rather than surfacing a bare HTTP status', async () => {
    const fetchImpl = fakeMirrorNode({}, false, 404);
    await expect(
      assertKeyMatchesAccount({ accountId: '0.0.999', key, mirrorNodeBaseUrl, fetchImpl }),
    ).rejects.toThrow(/HEDERA_OPERATOR_ID/);
  });
});
