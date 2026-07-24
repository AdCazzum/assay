/**
 * JSON encode/decode for the two ENS text records this package owns, plus
 * defensive shape-validation. See SPEC.md §5.
 *
 * No schema library here on purpose: `@assay/core`'s hard rule is not to add
 * dependencies mid-hackathon (zod is installed for `apps/mcp` already, but
 * pulling it into this package touches `pnpm-lock.yaml`, the one file every
 * parallel agent would collide on). The two shapes are small and flat, so a
 * handwritten check is plenty and keeps the failure messages specific to
 * exactly the field that is wrong.
 */

import type { Manifest, Reputation } from '@assay/core';
import { MalformedRecordError } from './errors.js';

export const MANIFEST_RECORD_KEY = 'assay:manifest';
export const REPUTATION_RECORD_KEY = 'assay:rep';

export function encodeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest);
}

export function encodeReputation(reputation: Reputation): string {
  return JSON.stringify(reputation);
}

export function decodeManifest(raw: string, ensName: string): Manifest {
  const parsed = parseJson(raw, MANIFEST_RECORD_KEY, ensName);
  return validateManifestShape(parsed, ensName);
}

export function decodeReputation(raw: string, ensName: string): Reputation {
  const parsed = parseJson(raw, REPUTATION_RECORD_KEY, ensName);
  return validateReputationShape(parsed, ensName);
}

function parseJson(raw: string, recordKey: string, ensName: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MalformedRecordError(recordKey, ensName, `not valid JSON (${reason})`);
  }
}

function asObject(
  value: unknown,
  recordKey: string,
  ensName: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedRecordError(recordKey, ensName, 'not a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  recordKey: string,
  ensName: string,
): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new MalformedRecordError(recordKey, ensName, `field "${field}" is missing or not a non-empty string`);
  }
  return v;
}

function requireFiniteNumber(
  obj: Record<string, unknown>,
  field: string,
  recordKey: string,
  ensName: string,
): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MalformedRecordError(recordKey, ensName, `field "${field}" is missing or not a finite number`);
  }
  return v;
}

function validateManifestShape(value: unknown, ensName: string): Manifest {
  const obj = asObject(value, MANIFEST_RECORD_KEY, ensName);
  return {
    capabilityId: requireString(obj, 'capabilityId', MANIFEST_RECORD_KEY, ensName),
    description: requireString(obj, 'description', MANIFEST_RECORD_KEY, ensName),
    priceHbar: requireFiniteNumber(obj, 'priceHbar', MANIFEST_RECORD_KEY, ensName),
    endpoint: requireString(obj, 'endpoint', MANIFEST_RECORD_KEY, ensName),
    bondRef: requireString(obj, 'bondRef', MANIFEST_RECORD_KEY, ensName),
    verifierHash: requireString(obj, 'verifierHash', MANIFEST_RECORD_KEY, ensName),
  };
}

function validateReputationShape(value: unknown, ensName: string): Reputation {
  const obj = asObject(value, REPUTATION_RECORD_KEY, ensName);
  return {
    score: requireFiniteNumber(obj, 'score', REPUTATION_RECORD_KEY, ensName),
    jobs: requireFiniteNumber(obj, 'jobs', REPUTATION_RECORD_KEY, ensName),
    slashes: requireFiniteNumber(obj, 'slashes', REPUTATION_RECORD_KEY, ensName),
    bondHbar: requireFiniteNumber(obj, 'bondHbar', REPUTATION_RECORD_KEY, ensName),
  };
}
