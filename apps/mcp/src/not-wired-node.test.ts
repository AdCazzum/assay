import { describe, expect, it } from 'vitest';
import { NodeNotWiredError, NotWiredAssayNode } from './not-wired-node.js';

describe('NotWiredAssayNode', () => {
  it('throws a named, readable error from every method instead of faking a result', async () => {
    const node = new NotWiredAssayNode();

    await expect(node.discover('rugscore')).rejects.toThrow(NodeNotWiredError);
    await expect(node.payAndCall('rugscore', '0xTOKEN')).rejects.toThrow(NodeNotWiredError);
    await expect(node.challenge('job-1', 'hasActiveMintRole')).rejects.toThrow(NodeNotWiredError);
    await expect(node.rate('job-1', true)).rejects.toThrow(NodeNotWiredError);
  });

  it('names which method was called in the error message', async () => {
    const node = new NotWiredAssayNode();
    await expect(node.discover('rugscore')).rejects.toThrow(/discover/);
  });
});
