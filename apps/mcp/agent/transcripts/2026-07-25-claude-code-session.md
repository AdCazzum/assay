# A real Claude Code session running `/assay-demo`

Verbatim final answer from a live run against Hedera testnet, Sepolia and The Graph mainnet.
Nothing here is edited except this header.

Kept because of the fourth paragraph. The agent was never told that comparing two providers'
outputs side by side would be unsound, or that block-stamping is what makes a verdict safe. It
worked that out, flagged it as a caveat rather than burying it, and noted that the unsound
reasoning would have reached the *right* answer anyway. That is the protocol's own thesis,
stated unprompted by the thing it was built for.

The reputation change it reports was verified independently against the chain afterwards:
`rugscore.assay.eth` 78 to 79, `liar.assay.eth` 88 to 58 with its slash ratio at 20.0%, read
off the Sepolia resolver rather than taken from the transcript.

---

Both reads are done and the record has moved on-chain.

The token. The honest, fully-verified picture at block 25611166: $56.51 of total liquidity,
8,789 blocks old (roughly a day), 2 transactions in its entire existence, $0 volume, and 100%
of its liquidity in a single pool. Rug-risk score 99/100. There is no exit here — $56 of
liquidity means any position of consequence is unsellable, and the single pool means one
withdrawal ends it. Both providers actually agreed on the 99, which is worth saying: the lie
wasn't in the headline verdict, it was in the one input that would make you doubt it.

The two providers. I picked the lower-scoring one and that was the right read.
liar.assay.eth's 88 was the higher number sitting on a slashed record; rugscore.assay.eth's 78
had 14 clean jobs under it. Same price, same 6x collateral, so the cleaner history cost me
nothing. The scores have now inverted to match reality — rugscore 78 → 79, liar 88 → 58, its
slash ratio doubling to 20% and its track-record signal escalating from caution to concern for
whoever queries it next.

On the second read. It cost 5 HBAR and returned nothing new about the token, but that isn't
the measure. It converted a suspicion into a settled on-chain fact, slashed a real bond, and
left a marker that makes the next requester's decision easier than mine was. Spending half my
budget to catch that was the budget working as intended.

One caveat I'd flag rather than bury: the two providers' claims were four blocks apart, so a
naive side-by-side comparison of their outputs would have been unsound reasoning even though
it happened to point at the right answer. What actually convicted liar.assay.eth was
re-deriving at its own stamped block. That distinction is the whole protocol — I never had to
trust either provider, and I didn't.

Budget: 10 of 20 HBAR spent.

PROVIDERS CONSULTED: rugscore.assay.eth, liar.assay.eth
PAID: rugscore.assay.eth, liar.assay.eth
CHALLENGED: liar.assay.eth/liquidityUsd
VERDICT: Do not touch 0xd6c68bc8...d3530 — a one-day-old token with $56 of liquidity, two
lifetime transactions, zero volume and 100% single-pool concentration is an unexitable rug,
and the only source that told you otherwise has been slashed for fabricating that liquidity
figure.
