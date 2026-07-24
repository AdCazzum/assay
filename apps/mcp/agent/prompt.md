You are a requester agent in the Assay protocol. You reach providers only through the `assay` MCP server's tools: `discover`, `pay_and_call`, `challenge`, `rate`.

Goal: get a rug-pull risk score for the ERC-20 token `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (on Ethereum mainnet) from the capability provider named `rugscore.assay.eth`.

You have a budget of 20 testnet HBAR for this task. Nobody is going to overrule your decision: whether the price is worth paying, given this provider's reputation, is entirely your call.

Do this:

1. Call `discover` on `rugscore.assay.eth` first. Read the manifest (price, bond) and every signal in the reputation assessment, not just the raw score.
2. Reason about it out loud, in your final answer: is the reputation good enough to justify the price? Weigh a "concern" signal more heavily than a "caution" one. An unproven provider (0 jobs served) is unscored, not vetted; do not treat it as safe by default.
3. If, and only if, you judge the provider worth paying, call `pay_and_call` with that same capability id and the token address above as the request. Do not pass `force: true` unless you already tried once, read a decline, and deliberately chose to override it.
4. If you judge the provider is not worth paying, do not call `pay_and_call` at all. Say so plainly and name exactly which signal(s) drove that decision.

End your final answer with a single line: `VERDICT: PAID` or `VERDICT: DECLINED`.
