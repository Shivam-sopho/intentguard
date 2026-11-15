# IntentGuard architecture

This document explains how IntentGuard is put together and why. The diagrams are Mermaid, so GitHub renders them; their sources are in [`docs/diagrams/`](diagrams/).

## The core idea: AI reads, code decides, the card enforces

Every decision that moves or protects money is made by deterministic code and enforced by Airwallex's card controls. Claude is used only for the two things code can't do well: reading an unstructured contract, and explaining decisions to a human. Even then its output is treated as untrusted:
- a price Claude extracts must appear verbatim in the document, or planning stops;
- every dollar figure in Claude's explanations must match a number the engine computed.

```mermaid
flowchart TB
  OP(["Finance operator"]) --> UI
  subgraph UI["Command center · React"]
    direction TB
    U1["Guided 5-step flow"]
    U2["Under the hood:<br/>every API call and signature"]
  end
  UI <--> SRV["Server · runs the steps in order<br/>(does no money math itself)"]
  SRV --> DET
  SRV --> AI
  SRV --> ADP
  subgraph DET["Deterministic engine · no AI"]
    direction TB
    D1["8-week cash forecast<br/>+ reserve floor"]
    D2["Card policy: inclusive limits,<br/>merchant category, currency"]
    D3["SHA-256 intent fingerprint<br/>+ Ed25519 approval"]
    D4["Visa TAP request signing<br/>(RFC 9421)"]
    D5["Guarded state machine"]
  end
  subgraph AI["Probabilistic layer · Claude"]
    direction TB
    C1["Reads the vendor contract"]
    C2["Explains every decision"]
    G["Grounding check: every price<br/>must appear in the source"]
    C1 --> G
  end
  subgraph ADP["Connections"]
    direction TB
    AWX[("Airwallex sandbox<br/>Issuing + simulation")]
    DOCS[("Airwallex Docs MCP")]
    SHOP[("Vendor shop<br/>verifies Visa TAP")]
  end
```

## End-to-end flow

```mermaid
flowchart LR
  A["<b>1 · Set the rules</b><br/>live Airwallex balance<br/>+ safety floor"] --> B["<b>2 · Choose a plan</b><br/>Claude reads the contract<br/>code forecasts 8 weeks of cash"]
  B --> C["<b>3 · Issue the card</b><br/>signed approval<br/>Airwallex virtual Visa card"]
  C --> D{"<b>4 · Checkout</b><br/>does the vendor<br/>change the deal?"}
  D -- "adds a fee or<br/>switches the plan" --> E["<b>Blocked</b><br/>card declines · agent freezes<br/>and reverses · no money moves"]
  E -- "operator: hold them<br/>to the approved price" --> F["<b>5 · Pay safely</b><br/>exactly the approved amount<br/>captured and cleared"]
  D -- "no" --> F
```

## Checkout, step by step

This is the live sequence recorded against the Airwallex sandbox (the vendor adds a hidden $250 fee):

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator
  participant Ag as IntentGuard agent
  participant En as Deterministic engine
  participant V as Vendor shop
  participant AX as Airwallex Issuing
  Op->>Ag: Approve $1,000 per month
  Ag->>En: Sign the intent (SHA-256 + Ed25519)
  Ag->>AX: Create virtual card: $1,000 limit, software MCC, USD only
  Ag->>V: Checkout, signed with Visa Trusted Agent Protocol
  V->>AX: Authorize $1,250 (hidden $250 fee)
  AX-->>V: DECLINED · LIMIT_EXCEEDED
  Ag->>En: Charge fingerprint differs from the approval
  Ag->>AX: Freeze card (INACTIVE)
  V->>AX: Retry the $250 on its own
  AX-->>V: DECLINED · CARD_INACTIVE
  Op->>Ag: Hold them to $1,000
  Ag->>En: New cart matches the approval
  Ag->>AX: Unfreeze card
  V->>AX: Authorize $1,000, then capture
  AX-->>V: APPROVED · CLEARED
```

When the vendor instead switches to a cheaper plan that fits under the limit, Airwallex approves the authorization. The agent's fingerprint check catches it, freezes the card and reverses the authorization before it clears. On a single-use card Airwallex then closes the card, so the agent issues a replacement bound to the same signed approval.

## Defense in depth

```mermaid
flowchart LR
  X["Vendor tries<br/>to charge the card"] --> L1{"<b>Layer 1</b><br/>Airwallex card controls<br/>limit · merchant · currency"}
  L1 -- "breaks a rule" --> DEC["Declined at the bank<br/>(e.g. LIMIT_EXCEEDED)"]
  L1 -- "within the rules" --> L2{"<b>Layer 2</b><br/>Agent checks the charge<br/>fingerprint vs. approval"}
  L2 -- "matches" --> OK["Captured and cleared"]
  L2 -- "differs" --> FR["Freeze the card<br/>+ reverse the charge"]
  DEC --> FR
  FR --> L3["<b>Layer 3</b><br/>Human decides:<br/>hold to approved terms<br/>or re-approve"]
```

| Layer | Enforced by | Catches |
|---|---|---|
| 1. Card controls | Airwallex Issuing (`authorization_controls`) | Anything over the inclusive limit, the wrong merchant category, the wrong currency, or after expiry |
| 2. Intent fingerprint | Deterministic engine (SHA-256 over merchant, MCC, amount, currency, cadence) | Any change to the approved terms, including ones the card limit allows |
| 3. Human decision | Operator, with a signed Ed25519 re-approval | The card stays frozen until a person decides |

## State machine

Every transition is guarded by code; an illegal jump (for example, settling without a cleared capture) throws.

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> GUARDRAILS_SET: balance read, floor set
  GUARDRAILS_SET --> PLAN_PROPOSED: a reserve-safe option exists
  GUARDRAILS_SET --> ESCALATED: no option keeps the floor
  PLAN_PROPOSED --> AWAITING_APPROVAL
  AWAITING_APPROVAL --> APPROVED: valid Ed25519 signature
  APPROVED --> CARD_ISSUED: card ACTIVE
  CARD_ISSUED --> CHECKOUT_IN_PROGRESS: cart matches intent
  CHECKOUT_IN_PROGRESS --> AUTHORIZED: rail approved + charge matches
  CHECKOUT_IN_PROGRESS --> QUARANTINED_FROZEN: drift detected, card INACTIVE
  QUARANTINED_FROZEN --> CARD_ISSUED: re-approved + cart matches + card ACTIVE
  AUTHORIZED --> SETTLED: CLEARING + APPROVED
  SETTLED --> [*]
  ESCALATED --> [*]
```

## Trust boundaries

| Input | Treated as | Protection |
|---|---|---|
| Vendor contract (PDF/text) | Untrusted | Text extraction is deterministic; Claude runs with **no tools** (no shell, files, web or MCP), so prompt injection in a contract has nothing to act on; extracted prices must be verbatim in the source |
| Claude's output | Untrusted | Zod schema validation, grounding checks, code recomputes every total |
| Vendor's charges | Untrusted | Card controls at the rail plus the fingerprint check on every authorization |
| Merchant requests from the agent | Authenticated | Visa TAP: RFC 9421 Ed25519 signatures, 8-minute window, single-use nonces, signed payment container |
| Operator approval | Authenticated | Ed25519 signature over the exact intent hash |
