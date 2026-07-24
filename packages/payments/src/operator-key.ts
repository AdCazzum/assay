/**
 * Parsing the operator key, unambiguously.
 *
 * `PrivateKey.fromString()` looks convenient and is a trap. Handed a bare
 * 32-byte hex string it does not detect the curve: it parses it as ED25519 and
 * returns a perfectly valid key that is simply not yours. Nothing fails at
 * construction. You find out at the network, as `INVALID_SIGNATURE`, which
 * reads like a permissions problem rather than a parsing one.
 *
 * That is exactly how this bit us: the Hedera portal issues ECDSA accounts by
 * default, `fromString` silently produced the ED25519 interpretation of the
 * same bytes, and the transfer was rejected by every node.
 *
 * So the curve is either encoded in the input (DER) or stated explicitly. We
 * never guess silently.
 */

import { PrivateKey } from '@hashgraph/sdk';

/**
 * `der` is self-describing: the encoding names the curve, so it needs no hint.
 * `ecdsa` and `ed25519` describe a bare hex string, which does not.
 */
export type HederaKeyType = 'ecdsa' | 'ed25519' | 'der';

export class OperatorKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorKeyError';
  }
}

/** DER-encoded keys are ASN.1 SEQUENCEs, so they always begin with tag 0x30. */
function looksDerEncoded(hex: string): boolean {
  return /^(0x)?30/i.test(hex);
}

/**
 * Parses a Hedera operator key.
 *
 * With no `keyType`, a DER string is detected and decoded (the encoding names
 * its own curve), and a bare hex string is read as **ECDSA**, which is what
 * portal.hedera.com hands out by default today. That default is still a guess
 * about your account, so verify it against the network before signing anything
 * that matters: see `assertKeyMatchesAccount`.
 */
export function parseOperatorKey(raw: string, keyType?: HederaKeyType): PrivateKey {
  const key = raw.trim();
  if (!key) {
    throw new OperatorKeyError('operator key is empty');
  }

  const resolved: HederaKeyType = keyType ?? (looksDerEncoded(key) ? 'der' : 'ecdsa');

  try {
    switch (resolved) {
      case 'der':
        return PrivateKey.fromStringDer(key);
      case 'ecdsa':
        return PrivateKey.fromStringECDSA(key);
      case 'ed25519':
        return PrivateKey.fromStringED25519(key);
      default: {
        const exhaustive: never = resolved;
        throw new OperatorKeyError(`unknown key type "${String(exhaustive)}", expected ecdsa, ed25519 or der`);
      }
    }
  } catch (err) {
    if (err instanceof OperatorKeyError) throw err;
    throw new OperatorKeyError(
      `could not parse the operator key as ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Confirms the parsed key actually controls the account, by comparing the
 * public key we derived against the one the account publishes on the mirror
 * node.
 *
 * This turns the failure mode from a network-level `INVALID_SIGNATURE` on some
 * later transfer into a precise message at startup that names the curve you
 * probably wanted. Worth the one HTTP call: an unattended signer holding the
 * wrong key is the kind of thing that eats an hour at 4am.
 */
export async function assertKeyMatchesAccount(params: {
  accountId: string;
  key: PrivateKey;
  mirrorNodeBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { accountId, key, mirrorNodeBaseUrl } = params;
  const doFetch = params.fetchImpl ?? fetch;

  const res = await doFetch(`${mirrorNodeBaseUrl}/api/v1/accounts/${accountId}`);
  if (!res.ok) {
    throw new OperatorKeyError(
      `could not read account ${accountId} from the mirror node (HTTP ${res.status}). ` +
        'Check HEDERA_OPERATOR_ID and that the account exists on this network.',
    );
  }

  const body = (await res.json()) as { key?: { _type?: string; key?: string } | null };
  const published = body.key?.key;
  const publishedType = body.key?._type;
  if (!published) {
    throw new OperatorKeyError(`account ${accountId} publishes no key on the mirror node, cannot verify the operator key`);
  }

  const derived = key.publicKey.toStringRaw();
  if (derived.toLowerCase() !== published.toLowerCase()) {
    const hint =
      publishedType === 'ECDSA_SECP256K1'
        ? 'The account is ECDSA_SECP256K1, so set HEDERA_KEY_TYPE=ecdsa.'
        : publishedType === 'ED25519'
          ? 'The account is ED25519, so set HEDERA_KEY_TYPE=ed25519.'
          : `The account reports key type ${publishedType ?? 'unknown'}.`;
    throw new OperatorKeyError(
      `the operator key does not control account ${accountId}.\n` +
        `  derived public key : ${derived}\n` +
        `  account public key : ${published}\n` +
        `  ${hint}\n` +
        '  Signing with this key would fail at the network as INVALID_SIGNATURE.',
    );
  }
}
