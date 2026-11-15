# IntentGuard

**A procurement agent that checks future cash before it buys, can only spend what a human approved, and freezes its own card when a merchant changes the price.**

IntentGuard buys a SaaS subscription for a finance team. It reads the vendor's order form with Claude. Deterministic code projects 8 weeks of cash for each billing option and chooses the cheapest option that keeps the reserve floor. It issues an Airwallex Visa virtual card whose controls only allow the approved charge, and it checks out with a Visa Trusted Agent Protocol (TAP) signed request. In the demo the merchant adds a fee mid-checkout. The card rail declines it, the agent detects that the charge no longer matches the intent hash, and it freezes the card. Nothing is paid until a human re-approves the original terms.

> Track: **Starter Kit 2, Intent-Bound Purchase Agent** (Airwallex Issuing card controls), combined with the reserve-floor logic of Starter Kit 1 and a Visa TAP checkout.

## The five acts

| Act | What happens | Where the decision is made |
|---|---|---|
| 1. Goal & guardrails | Fetch the USD balance (`GET /api/v1/balances/current`) and set the reserve floor | Operator |
| 2. Plan | The agent fetches the order form with a TAP `agent-browser-auth` request. Claude extracts the prices and risk clauses, and code checks every figure against the source. The engine projects 8 weeks: **Annual $9,600 upfront drops cash to $36,400 in week 7, $3,600 below the $40,000 floor. Monthly keeps the low point at $44,000.** The engine picks Monthly, schedules a week-8 re-evaluation for when the $18,000 receivable lands, and Claude explains the trade-off | `deterministic-engine` |
| 3. Provision & shock | The operator's Ed25519 signature is bound to the SHA-256 intent hash. The card is issued (`POST /issuing/cardholders/create`, `POST /issuing/cards/create`) with inclusive `PER_TRANSACTION` $1,000 and `MONTHLY` $1,000 limits, MCC 5734 only, USD only. The limits are read back (`GET /issuing/cards/{id}/limits`). The agent checks out with TAP `agent-payer-auth` and an `agenticPaymentContainer`. The merchant's billing system then authorizes **$1,250** (adding a $250 "Mandatory Enterprise Onboarding Fee") | Merchant (chaos) |
| 4. Rail quarantine | Airwallex declines the authorization (`process_result: DECLINED`, `failure_reason: LIMIT_EXCEEDED`), which maps to `FAILED`. The charge's binding hash differs from the intent's, so the agent freezes the card (`POST /issuing/cards/{id}/update` → `INACTIVE`). The merchant's retry of the $250 as a separate charge is declined with `CARD_INACTIVE`. Claude writes the incident report | Airwallex card controls + engine |
| 5. Verified settlement | The operator re-signs the original intent and the vendor drops the fee. Code requires the new cart's hash to match before it unfreezes the card. A new TAP checkout authorizes $1,000.00, which is then captured (`CLEARING` + `APPROVED`) and moves the state machine to `SETTLED`. The audit shows $0 unauthorized spend, the reserve preserved, and the week-8 trigger still scheduled | Engine state machine |

## Architecture: deterministic vs. probabilistic

```
                 ┌──────────────── command-center-ui (React + Tailwind + Recharts) ────────────────┐
                 │  guided 5-step flow, one decision per screen · "Under the hood" drawer (raw API) │
                 └───────────────▲──────────────────────── SSE /api/events ──────────────────────────┘
                                 │
┌────────────────────────────────┴───────────── server (Express orchestrator) ─────────────────────────────┐
│  sequences acts; never computes money itself                                                            │
│                                                                                                         │
│  ┌──────── deterministic-engine (pure TS, zero LLM) ────────┐   ┌──── cognitive-agent (Claude) ────────┐ │
│  │ money.ts            integer-cent math, major units       │   │ contractParser.ts  structured output │ │
│  │ cashflowProjector   8-wk projection, inclusive floor,     │   │   → grounded by code: every price &  │ │
│  │                     plan rule, upgrade trigger            │   │     quote must be verbatim in source │ │
│  │ cardPolicyBuilder   Airwallex payloads, shadow evaluator  │   │ decisionNarrator.ts explains facts;  │ │
│  │ intentHashSigner    SHA-256 intent + binding hash,        │   │   every $ figure checked vs facts    │ │
│  │                     Ed25519 operator approval             │   └──────────────────────────────────────┘ │
│  │ visaTap.ts          RFC 9421 signer + merchant verifier   │                                            │
│  │ stateMachine.ts     guarded transitions, rail mapping     │                                            │
│  │ idempotency.ts      UUIDv4 request_id ledger              │                                            │
│  └───────────────────────────────────────────────────────────┘                                            │
│                                                                                                         │
│  ┌──────────────── simulation-adapter ────────────────────────────────────────────────────────────────┐ │
│  │ airwallexClient.ts     LIVE sandbox: login, balances, cardholders, cards, limits, update            │ │
│  │ airwallexEmulator.ts   OFFLINE emulator with the same interface (always labelled "EMULATOR")        │ │
│  │ airwallexSimulation.ts /simulation/issuing/create · lifecycles/{id}/capture · /reverse              │ │
│  │ mockVendorStorefront   CloudScale merchant with a TAP verifier at the edge + chaos fee toggle       │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Rules this code enforces** (from the Airwallex builder guide):

- The LLM never does arithmetic, enforces a limit, checks the floor, or moves the state machine. Claude's extraction is treated as untrusted input. A price that is not in the document, or a quote that is not verbatim, blocks the plan. Code recomputes the annualized cost.
- Amounts are in major units. Internally all math uses integer cents, so float drift cannot change a floor decision.
- Every `POST` gets a fresh UUIDv4 `request_id`. A ledger throws if an id is reused for a different operation.
- `authorization_controls.allowed_transaction_count` is always set. Per-transaction limits are **inclusive**: $1,000.00 passes and $1,000.01 is declined (tested). A `PER_TRANSACTION` limit is not cumulative, so a `MONTHLY` limit is added to block split charges ($600 + $650).
- Simulation mapping: `failure_reason` or `DECLINED` maps to `FAILED`. `AUTHORIZATION` + `APPROVED` means funds reserved. `CLEARING` + `APPROVED` means accepted.
- REST cardholders use `type`. The Airwallex MCP tool uses `cardholder_type`. Separate mappers handle each.
- Defense in depth: before paying, the cart hash must match the intent. After the merchant authorizes, the observed charge hash must match the intent. If the rail ever approves a charge that the deterministic policy says it should decline, the mismatch is flagged and the authorization is reversed before clearing.

### Visa Trusted Agent Protocol

`visaTap.ts` implements the open TAP wire format from [github.com/visa/trusted-agent-protocol](https://github.com/visa/trusted-agent-protocol):

- RFC 9421 HTTP Message Signatures over `("@authority" "@path")`, signed with Ed25519.
- Parameters `created`, `expires`, `keyid`, `alg`, `nonce` and `tag`. The tag is `agent-browser-auth` for browsing and `agent-payer-auth` for checkout.
- The signature window is at most 8 minutes, and nonces are single-use.
- The checkout body carries an `agenticPaymentContainer` signed with the same nonce.

The mock merchant verifies all of this at its edge. It looks up keys through a key-directory stand-in (`GET /registry/keys?keyID=`), and unsigned bots get HTTP 403 (try **"try unsigned bot"** in the UI).

`intentBinding` inside the payment container is an IntentGuard extension, not part of the TAP spec. Production TAP needs Visa onboarding and keys published in Visa's directory. This repo shows the protocol against a merchant we control.

## Run it

```bash
npm install
cp .env.example .env        # optional: add Airwallex sandbox + Anthropic keys
npm run dev                 # API :8787 + UI http://localhost:5173
```

The UI walks through the story one step per screen, with one action per step. Click **Auto-play demo** to play it all, or step through by hand. **Under the hood** opens a drawer with every Airwallex call, TAP signature, engine decision and state transition, for judges who want the raw evidence.

| Command | What it does |
|---|---|
| `npm test` | 34 unit tests: Week-7 breach math, inclusive limits, split-charge block, hash drift, cadence flip, approval binding, TAP replay/path/expiry/key/nonce attacks, state-machine guards, LLM grounding |
| `npm run demo:cli` | Headless end-to-end run of all five acts against a running API |
| `npm run sandbox:check` | Read-only probe of your Airwallex sandbox credentials (login, balances, Issuing) |
| `npm start` | Production build of the UI served by the API on :8787 |

**Modes are always labelled.** The header and every telemetry line show whether calls hit the **live Airwallex sandbox** or the **offline emulator**, and whether text came from **Claude** or an **offline template**. The emulator only runs when no credentials are configured or the sandbox is unreachable. It follows the documented Airwallex response shapes and semantics.

**Live balance and the floor.** With sandbox credentials, the opening balance is your real USD wallet. The default reserve floor is the opening balance minus $18,000, which recreates the scenario's Week-7 squeeze for any balance. You can set the floor yourself in Act 1.

## Scenario numbers (verified by tests)

Opening $58,000 · floor $40,000 · opex −$1,000/week · week 7 payroll + payroll tax −$5,000 · week 8 receivable +$18,000.

| Week | 1 | 2 | 3 | 4 | 5 | 6 | **7** | 8 |
|---|---|---|---|---|---|---|---|---|
| Annual ($9,600 in W1) | 47,400 | 46,400 | 45,400 | 44,400 | 43,400 | 42,400 | **36,400 ✗** | 53,400 |
| Monthly ($1,000 in W1, W5) | 56,000 | 55,000 | 54,000 | 53,000 | 51,000 | 50,000 | **44,000 ✓** | 61,000 |

Annual saves 20% ($2,400 a year) but breaches the floor by $3,600 in week 7. Switching to annual in week 8 keeps every week at or above $44,000, so the engine schedules that re-evaluation.
