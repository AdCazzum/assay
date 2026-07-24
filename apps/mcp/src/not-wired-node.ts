import type { Job } from '@assay/core';
import type { AssayNodePort, DiscoverResult } from './node-port.js';

/**
 * Thrown by `NotWiredAssayNode`. Named and worded so it reads honestly to
 * whoever hits it, human or agent: the MCP surface is real, the node behind
 * it is not wired up yet.
 */
export class NodeNotWiredError extends Error {
  constructor(method: string) {
    super(
      `Assay MCP server: "${method}" has no node wired in yet. ` +
        '@assay/core\'s createAssayNode (issue #20/#21) had not landed when this server was ' +
        'built (issue #23); wiring it in is the pending follow-up. See apps/mcp/src/index.ts.',
    );
    this.name = 'NodeNotWiredError';
  }
}

/**
 * A placeholder `AssayNodePort` so the server can start, connect over
 * stdio, and list its tools honestly, without pretending any of them work
 * end to end yet. Every method throws `NodeNotWiredError` instead of
 * fabricating a manifest, reputation, or job, which would be exactly the
 * kind of faked integration AGENTS.md rules out.
 *
 * As of issue #46, `index.ts`'s `main()` no longer uses this: it builds
 * `createLiveAssayNode` (`live-node.ts`) over real Hedera/Sepolia/Graph
 * adapters instead. This class stays around, and stays exported, for the
 * same honest reason it existed before: something to boot the server against
 * with zero live credentials (e.g. a quick `listTools` check) without ever
 * faking a result.
 */
export class NotWiredAssayNode implements AssayNodePort {
  async discover(_capabilityId: string): Promise<DiscoverResult> {
    throw new NodeNotWiredError('discover');
  }

  async payAndCall(_capabilityId: string, _request: unknown, _force?: boolean): Promise<Job> {
    throw new NodeNotWiredError('pay_and_call');
  }

  async challenge(_jobId: string, _claimKey: string): Promise<Job> {
    throw new NodeNotWiredError('challenge');
  }

  async rate(_jobId: string, _satisfied: boolean, _comment?: string): Promise<Job> {
    throw new NodeNotWiredError('rate');
  }
}
