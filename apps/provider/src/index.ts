/**
 * @assay/provider — the long-running service that serves rug-score requests
 * (issue #8, SPEC.md §4). Owns the provider-side half of the payment gate:
 * `ProviderService` (see `service.ts`) fronts `@assay/core`'s `serve()`,
 * which is where the gate itself lives (it calls `payments.confirm(txId)`
 * unconditionally before running any capability — this app never
 * reimplements or weakens that).
 *
 * `main()`, run only when this file is executed directly, starts the demo
 * HTTP endpoint (`createProviderHttpServer`) against `buildDemoNode()`: a
 * real `@assay/core` + `@assay/cap-rugscore` loop wired to named fakes
 * (`fakes.ts`), so the service is runnable and demoable with zero network.
 * Wiring live Hedera/ENS/Graph adapters in is a follow-up, out of scope for
 * #8 (see `demo-node.ts`).
 */

import { createProviderHttpServer } from './http-server.js';
import { createProviderService } from './service.js';
import { buildDemoNode, DEMO_MANIFEST, DEMO_PROVIDER_NAME } from './demo-node.js';

export const APP_ID = '@assay/provider';

export {
  createProviderService,
  validateServeRequest,
  DEFAULT_SERVE_TIMEOUT_MS,
} from './service.js';
export type {
  ProviderService,
  ProviderServiceDeps,
  RawServeRequest,
  ServeOutcome,
  ServeRefusalCode,
  ValidServeRequest,
} from './service.js';
export { createProviderHttpServer } from './http-server.js';
export { MalformedServeRequestError, ServeTimeoutError } from './errors.js';
export { withTimeout } from './timeout.js';
export { FakeGraphPort, FakePaymentsPort, FakeRegistryPort, HangingPaymentsPort } from './fakes.js';
export type { FakePaymentsPortOptions } from './fakes.js';
export { buildDemoNode, DEMO_MANIFEST, DEMO_PROVIDER_NAME } from './demo-node.js';
export type { DemoNode } from './demo-node.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const { node } = buildDemoNode();
  const service = createProviderService({ serve: node.serve });
  const server = createProviderHttpServer(service);

  server.listen(port, () => {
    console.log(
      `${APP_ID} demo listening on http://localhost:${port} (POST /serve).\n` +
        'Demo mode: registry/payments/graph are named fakes (see fakes.ts), not live networks.\n' +
        `Provider "${DEMO_PROVIDER_NAME}", capability "${DEMO_MANIFEST.capabilityId}", ` +
        `price ${DEMO_MANIFEST.priceHbar} HBAR (fake, never charged).`,
    );
  });
}

const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main().catch((err) => {
    console.error(`${APP_ID} failed to start:`, err);
    process.exit(1);
  });
}
