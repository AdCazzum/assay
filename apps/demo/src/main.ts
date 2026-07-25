/**
 * The live entrypoint (issue #86): wires the real adapters (`live-node.ts`),
 * the demo's step machine (`session.ts`), and the one screen (`screen.ts`)
 * together, then reads the keyboard until `q`.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createCoreEventMapper, type LoopEvent } from '@assay/dashboard';
import { buildLiveDemoNodes, MissingConfigError } from './live-node.js';
import { formatReputationHeartbeat } from './reputation-heartbeat.js';
import { LEGEND } from './legend.js';
import { checkDemoReadiness } from './reset-check.js';
import { createDemoSession } from './session.js';
import { keyFor } from './step-machine.js';
import { Screen } from './screen.js';
import { startKeyboard } from './keys.js';

const CHALLENGE_VISIBLE_STEPS = new Set<LoopEvent['step']>(['challenge', 'verify', 'slash', 'reputation']);

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

export async function main(): Promise<void> {
  const screen = new Screen();
  const setStatusLine = (message: string): void => screen.setStatus([LEGEND, message]);

  // Flipped by `onPayFinalizing` below (see session.ts's module doc comment):
  // once true, requesterNode's own further 'pay' LoopEvents (serve()'s
  // unconditional payment re-verification) are dropped rather than
  // downgrading the pay row this session already finished narrating itself.
  let suppressPayEvents = false;

  let nodes: ReturnType<typeof buildLiveDemoNodes>;
  try {
    // Mapper state (the pay-elapsed-time memory, see `@assay/dashboard`'s
    // `createCoreEventMapper` doc comment) is scoped per node, matching
    // `createEventStamper()`'s own "one per node" precedent in `@assay/core`.
    const requesterMapper = createCoreEventMapper();
    const challengeMapper = createCoreEventMapper();

    nodes = buildLiveDemoNodes({
      onRequesterEvent: (event) => {
        for (const mapped of requesterMapper(event)) {
          if (mapped.step === 'pay' && suppressPayEvents) continue;
          screen.pushEvent(mapped);
        }
      },
      onChallengeEvent: (event) => {
        // Only the climax steps are narrated; see session.ts's module doc
        // comment for why the challenge node's own discover/pay/serve
        // preamble stays silent.
        for (const mapped of challengeMapper(event)) {
          if (CHALLENGE_VISIBLE_STEPS.has(mapped.step)) screen.pushEvent(mapped);
        }
      },
      // The ENS write's own heartbeat (see live-node.ts's module doc
      // comment): a *different* hook than the two above, needed so the
      // reputation row keeps ticking during the 8-25s write instead of
      // sitting frozen between "writing-reputation" and "reputation-confirmed".
      onReputationHeartbeat: (info) => {
        const event = formatReputationHeartbeat(info);
        if (event) screen.pushEvent(event);
      },
    });
  } catch (err) {
    if (err instanceof MissingConfigError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // The visible reset check (issue #86, #64): refuse to start with a clear
  // message rather than failing halfway through act one.
  setStatusLine(`checking "${nodes.goodProviderName}"'s live reputation before starting...`);
  const readiness = await checkDemoReadiness(nodes.requesterNode, nodes.goodProviderName);
  if (!readiness.ready) {
    console.error(`\n${LEGEND}\n`);
    console.error('NOT READY TO START:');
    console.error(readiness.reason);
    nodes.close();
    process.exitCode = 1;
    return;
  }

  const session = createDemoSession({
    requesterNode: nodes.requesterNode,
    challengeNode: nodes.challengeNode,
    registry: nodes.registry,
    payments: nodes.payments,
    goodProviderName: nodes.goodProviderName,
    liarProviderName: nodes.liarProviderName,
    push: (event) => screen.pushEvent(event),
    onStatus: setStatusLine,
    onPayFinalizing: () => {
      suppressPayEvents = true;
    },
  });

  setStatusLine(`ready. press ${keyFor('discover')} (discover) to begin.`);

  const keyboard = startKeyboard({
    onKey: (key) => session.handleKey(key),
    onQuit: () => {
      keyboard.stop();
      nodes.close();
      process.exit(0);
    },
  });
}

// Only auto-run when this file is executed directly (tsx/node), never when
// imported — `index.ts` and tests both import from this module without
// wanting to launch the live demo as a side effect (same convention every
// other app entrypoint in this repo uses, e.g. `apps/mcp/src/index.ts`).
const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main().catch((err) => {
    console.error('assay demo failed:', err);
    process.exit(1);
  });
}
