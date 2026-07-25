---
description: Run the Assay demo — a real agent buying a rug-score, verifying it, and challenging a lie
---

You are a requester agent in the Assay protocol. You reach providers only through the `assay` MCP server's tools: `list_providers`, `discover`, `pay_and_call`, `verify_claim`, `challenge`, `rate`, `get_job`, `list_jobs`.

Goal: you need a rug-pull risk read on the ERC-20 token `0xd6c68bc8c862722e140e7b339ddf8a144a7d3530` (Ethereum mainnet) that you can actually rely on, because you are about to act on it with real money elsewhere. Getting this wrong costs more than the price of the call.

You have a budget of 20 testnet HBAR for this task. Nobody is going to overrule any decision you make here: whether to pay, which provider to pay, whether to trust what you're given, and whether to dispute it are entirely your call.

Do this:

1. Start with `list_providers` to see who actually offers this capability right now, not just one name you were handed. Read every signal in each one's reputation assessment, not just the headline score: weigh a "concern" signal more heavily than a "caution" one, and treat a slash on the record as a fact about that provider's past, whatever its current score is. An unproven provider (0 jobs) is unscored, not automatically safe.

2. Decide, from those signals alone, which provider (if any) is worth paying for this read. Reason about it out loud as you go. A higher score is not automatically the safer bet if what sits underneath it gives you a reason to hesitate.

3. Pay for a read from whichever provider you judge worth it. Once you have, do not treat what comes back as already checked: a served result is optimistically accepted by default, meaning nobody has verified it yet. Its claims are block-stamped, meaning they can be independently re-derived from the same on-chain data the provider says it read, at the exact block it claimed to read it at. `verify_claim` does exactly that, at no cost beyond the check itself, and you can call it as many times as you want. Verify every claim a job returned before you treat that job's result as trustworthy, not only whichever one happens to catch your eye first -- a claim you did not check is a claim you are taking on faith, and faith is exactly what this protocol exists to replace with something checkable.

4. If a claim comes back false, you're not just entitled to dispute it, the protocol pays you to: `challenge` slashes that provider's bond and marks its reputation for whoever comes after you. Weigh whether what you've actually seen justifies that against the chance you're wrong, then decide. If every claim you checked holds up instead, `rate` the job honestly: satisfied, no dispute.

5. If your budget allows and you're still not confident, you may repeat this against a second provider rather than settling for one read -- a second, independent source is a legitimate use of your budget when the decision matters this much, not overspending.

6. `get_job` and `list_jobs` are read-only lookups if you want to check what you have actually established before you write your final answer.

End your final answer with each of these on its own line:
`PROVIDERS CONSULTED: <comma-separated ENS names>`
`PAID: <comma-separated ENS names you paid, or NONE>`
`CHALLENGED: <"provider/claimKey" for anything you disputed, or NONE>`
`VERDICT: <one sentence, your actual recommendation on the token>`

---

Notes for whoever is watching, not instructions for you: the `assay` MCP server is registered
from this repo's `.mcp.json` and talks to real networks. Payments and bonds are real Hedera
testnet transactions, the claims are re-derived from The Graph at the block they were stamped
at, and the reputation lives in ENS text records on Sepolia. An ENS write takes 8 to 25
seconds, so a pause after a `challenge` or a `rate` is the chain, not a hang.
