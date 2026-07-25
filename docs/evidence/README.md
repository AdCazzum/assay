# Evidence

Committed artefacts a reader can check without running the project, and without
any credential of mine.

## `anchored-runs.ndjson`

Two runs of the anchoring path (`apps/mcp/scripts/live-anchor-check.ts`) in one
append-only log, exactly as the sink wrote them. Their chain heads were
submitted to Hedera testnet topic
[`0.0.9753542`](https://hashscan.io/testnet/topic/0.0.9753542) while the runs
were happening.

```bash
pnpm --filter @assay/mcp exec tsx scripts/verify-anchors.ts \
  --topic 0.0.9753542 --file docs/evidence/anchored-runs.ndjson
```

Expect `12/12 anchors reproduce from this file` and both runs reported as fully
covered. The only network call is to the public mirror node.

Then break it on purpose, which is the part worth doing:

```bash
sed 's/"amountHbar":5,/"amountHbar":50,/' docs/evidence/anchored-runs.ndjson > /tmp/tampered.ndjson
pnpm --filter @assay/mcp exec tsx scripts/verify-anchors.ts \
  --topic 0.0.9753542 --file /tmp/tampered.ndjson
```

That gives `8/12` and a non-zero exit. Each run's last two anchors flip to
`MISMATCH` independently, and the coverage line locates the edit to after seq 9
in each, because every hash from the edited line onward is different.

The loop events in this file are synthetic and say so (`live-check` job id, a
placeholder transaction id). It is a check on the anchoring path, not a
rehearsal of the demo, and no HBAR moves in it. What is real is every anchor:
the chain values, the topic messages, and Hedera's consensus timestamps on them.

A log from a real demo run lands at `.assay/loop-events.ndjson`, which is
gitignored because it is per-run scratch. Verify one the same way, with
`--file .assay/loop-events.ndjson`.
