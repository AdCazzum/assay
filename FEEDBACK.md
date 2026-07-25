# Feedback for the sponsors

Notes from building Assay at ETHGlobal Lisbon 2026, solo, in 36 hours. Everything here
comes from something that actually cost me time or nearly cost me the demo, with the
measurement or the error message that established it. Ordered roughly by how much it hurt.

I liked all three integrations enough to build a project whose whole argument depends on
them, so please read this as a bug report rather than a complaint.

---

## Hedera

### `PrivateKey.fromString()` silently returns the wrong key

This is the one that nearly ended the project two hours in, and I think it is a genuine
footgun worth fixing in the SDK.

The portal issues **ECDSA** accounts by default. Handed a bare 32-byte hex private key,
`PrivateKey.fromString()` does not detect the curve: it parses it as ED25519 and returns a
perfectly valid `PrivateKey` object that simply is not the account's key. Nothing fails at
construction. Nothing warns loudly enough to notice. From the same input bytes:

```
fromStringECDSA    02405e2bf9f18c0da4d917588627219c9ad1663b89af2744d7beca7377b1f9b9a2  <- the account
fromStringED25519  80ba2ba2a1c1de2fe4266208db78e24a148189f1df568f3db2e38d50dc3c54d8
```

You discover this at the network, as `INVALID_SIGNATURE against node account id 0.0.6`,
which reads like a permissions or account problem and sends you looking in the wrong place
entirely. I spent the time on the account before suspecting the parse.

Two suggestions, either would have saved me the hour:

1. Make `fromString` **throw** on an ambiguous bare hex string rather than guessing. There
   is no correct answer to infer, so refusing is the honest behaviour. There is already a
   deprecation-style warning printed, but a warning on stderr in a working program is easy
   to miss, and the failure it predicts appears somewhere unrelated.
2. Have the error path for `INVALID_SIGNATURE` hint at curve mismatch. It is presumably a
   common cause and the SDK knows which curve it parsed.

What I ended up doing, in case it is useful to anyone else: never call `fromString`, take
the curve from DER when it is DER-encoded, and preflight by comparing the derived public
key against the one the mirror node publishes for the account. That turns a
network-level `INVALID_SIGNATURE` into a startup error naming the curve you wanted.

### Settlement is ~4s end to end, not sub-second

The consensus itself is fast, around 3s. But the number a user or a demo audience actually
experiences is the round trip including mirror-node ingestion, and that measured **4.1s**
consistently. An isolated transfer with no confirmation resolves in ~0.4s.

I am flagging it because "sub-second finality" is in a lot of the marketing, and a builder
who plans a demo around it will be surprised on stage. The honest version, that consensus
is ~3s and reading it back adds ~1s, is still an excellent number and is one you can say
without being contradicted by your own screen.

### What was genuinely good

The testnet portal is the best of the three sponsors here: an account, a key and 1000 test
HBAR in about two minutes, with a daily refill so I never had to think about faucets again
across two days of repeated real transactions. The mirror node REST API is pleasant, well
documented, and returning the transaction memo base64-encoded in the transaction record is
exactly what I needed to prove a payment was bound to a specific request. HashScan links
made every claim in this project independently checkable by a judge, which is worth a lot.

---

## The Graph

### The Token API cannot filter by historical block, and that is a correctness problem

My project's central claim is that a factual assertion can be re-derived from a source of
truth **at the block it was stamped at**. That is not a nicety: without it, verifying a
claim against live data means slashing honest providers whenever the chain moves.

I built the first version on the Token API and then found that four of the six signals I
needed (`holders`, `top10Pct`, `liquidityUsd`, `transfers`) come from endpoints with no
historical block parameter at all. They only ever reflect current indexer state. Only
`/v1/evm/transfers` accepts `start_block`/`end_block`.

That left the fallback of caching a snapshot at serve time and verifying against it, which
is circular: you end up verifying the provider against data the provider supplied.

I rewrote onto **subgraph queries through the gateway**, where `block: { number: N }` works
properly, and the difference is night and day. Same token, three pinned blocks:

| block | txCount | TVL USD |
|---|---|---|
| 20000000 | 13682874 | 640775689 |
| 22000000 | 18679418 | 570736950 |
| 24000000 | 28025216 | 578896269 |

and a block before the subgraph's start block fails loudly instead of silently substituting
live data:

```
bad query: requested block 1000, before minimum `startBlock` of manifest 12369621
```

That explicit refusal is exactly the property a verifier needs, and I wish I had started
there. **My suggestion: add block-pinned reads to the Token API.** It is the one thing
standing between a very convenient REST API and being usable for anything that has to prove
what was true in the past, which is most of what "verifiable" means on-chain.

### The Token API docs and hostname have moved, and the old host is dead

`token-api.thegraph.com` no longer completes a TLS handshake. It resets the connection
immediately, from two different networks I tried, so it is not IP filtering:

```
* Trying 64.203.83.78:443...
* TLS connect error
* OpenSSL SSL_connect: Connection reset by peer
```

Meanwhile `thegraph.com/docs/en/token-api/quick-start/` 301-redirects to
`app.pinax.network/docs/api/`, and the API now lives at `api.pinax.network` and wants a
**Pinax JWT**, not the Graph Studio API key. A Studio key returns `401 unauthorized` there.

Nothing about that transition is signposted from where a builder starts. I spent real time
concluding my key was wrong before working out that the product had moved and needed a
different credential. A note on the docs page, and a redirect or an explanatory error on
the old host rather than a TLS reset, would fix it.

### What was genuinely good

The gateway worked flawlessly with a Studio key, first try, from a datacenter IP, with no
allowlisting. Block-pinned queries did exactly what they promise. And the error messages are
the best of any API I touched in this project: when I asked for a block outside the indexed
range it told me the minimum start block and the manifest it came from, which is precisely
the information needed to fix the call. That single message saved more time than any
documentation could have.

One thing I could not source anywhere, in case it is a gap worth knowing about: I found no
gateway-queryable subgraph for ERC-20 holder distribution or a token's mint role. Two
community candidates both returned `subgraph not found: no allocations`. I dropped those
signals rather than approximate them, which was the right call but cost me the more
intuitive version of my demo.

---

## ENS

### The `.eth` BaseRegistrar reports a name as available while it resolves fine

This cost me an hour and a wrong conclusion I stated confidently to my own notes.

After registering `assay.eth` on Sepolia, I checked ownership the way I assumed was
canonical, through the `.eth` BaseRegistrar at `0x57f1887a...`:

```
available(assay)     -> true
nameExpires(assay)   -> 2024-10-24
```

So I concluded the registration had failed and told my collaborator to redo it. It had not
failed. Standard resolution worked the whole time:

```
resolveName("assay.eth")   -> 0xdE1643957268Ab83465b788905d503Fd27D427a5
lookupAddress(that wallet) -> assay.eth
```

The registrar contract I was querying is legacy in this deployment. The lesson, which I now
believe is the right general advice, is **trust resolution rather than the registrar**. But
a builder has no way to know which contract is authoritative in a given deployment, and
both answer confidently.

Relatedly: `sepolia.app.ens.domains` shows a banner saying it is the legacy app and "some
features may be broken", while `app.ens.dev` is the v2 app and warns that Sepolia state may
be reset periodically. Between the two apps and the two contract sets it was genuinely hard
to establish where a name lived and which one my code should target. Clearer guidance on
"if you are building on Sepolia today, use these contracts" would help a lot.

### Subnames resolve without existing in the registry, which is great but undocumented

I assumed I would need to create `rugscore.assay.eth` on-chain before writing its text
records, and budgeted a manual step for it. Then I found this:

```
assay.eth            registry owner: 0x0635513f...  resolver: 0x8FADE66B...
rugscore.assay.eth   registry owner: 0x00000000...  resolver: 0x00000000...
```

The subname does not exist in the registry at all, yet its text records read and write
perfectly. A wildcard resolver authorises the parent's owner for **every** subname, so
`liar.assay.eth` and any other name I invented were immediately writable with no
transaction and no setup.

For my use case, where each provider agent gets its own subname, this is exactly right and
removes an entire onboarding step. It is a genuinely good property for agent identity. I
only found it by probing contracts because I did not believe what I was seeing. It deserves
to be a headline feature in the docs for anyone issuing names programmatically, because it
is the difference between "one transaction per agent" and "zero".

Note that `setSubnodeRecord` directly through the registry is *denied* for a wrapped name,
since the registry owner is the NameWrapper. So the wildcard path is not just convenient,
it is the one that works.

### Write latency is 12 to 25 seconds and the spread is the problem

Seven real `setText` confirmations, in milliseconds:

```
24600, 12588, 12389, 16435, 12391, 16572, 16587
```

Range 12.4s to 24.6s, median ~16.4s. It does not converge on a number, and the variance
hurts more than the mean: you cannot plan a 90-second demo around a step that might take
12 seconds or might take 25.

For context, the same demo's Hedera settlement is 4.1s, so ENS is the slowest thing on my
critical path by a factor of four, and it is what the closing beat depends on.

I do not think this is a protocol problem so much as an unstated expectation. Publishing a
realistic latency range for testnet text-record writes, or exposing a progress signal
richer than "pending", would let builders design around it instead of discovering it during
rehearsal. I ended up emitting a heartbeat every 3 seconds off `tx.wait()` purely so the
screen would not look frozen.

### What was genuinely good

Text records as a place to put arbitrary structured state is the right primitive, and it is
why this project works. Putting a capability manifest and a portable reputation record
under one name means an agent resolves a single human-readable string and learns who it is
dealing with, what the service costs, and whether it has been caught lying, before spending
anything. Nothing else in the stack offered that, and no part of it required a contract
deploy from me. Combined with free subnames via the wildcard resolver, ENS ended up being
the piece I would keep if I had to throw the rest away.
