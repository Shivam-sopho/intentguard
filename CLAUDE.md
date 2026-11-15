# IntentGuard: notes for Claude Code

IntentGuard is a hackathon demo: a SaaS purchasing agent that pays with an Airwallex virtual card
locked to a human-approved intent and checks out with Visa Trusted Agent Protocol signed requests.
See README.md for the story and architecture.

## When someone asks you to run it

Goal: get the app running, show the full flow working, and tell the person what they are looking at.

1. **Prerequisites.** Node.js 20 or newer (`node -v`). Then run `npm install` at the repo root (npm workspaces).
2. **Tests.** `npm test` should report 40 passing tests. Run `npm run typecheck` too if anything looks off.
3. **Credentials (optional).** Without them, everything runs on a clearly labelled offline emulator.
   - For the live Airwallex sandbox: `cp .env.example .env` and ask the person to put their own
     **sandbox** `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` into `.env` themselves. Never ask them to
     paste keys into the chat. Never print, log or commit `.env`, and never use production keys.
   - The sandbox org must be registered in a country where Airwallex issues cards (for example US, UK, AU,
     SG). An India-registered org fails card creation with `Invalid issuance details`.
   - Check credentials with `npm run sandbox:check` (read-only: login, balances, Issuing).
   - The language layer uses `ANTHROPIC_API_KEY` if it is set; otherwise it uses the local `claude` CLI
     (headless `claude -p`, all tools disabled); otherwise it falls back to labelled offline templates.
4. **Start the app** in the background: `npm run dev` (API on :8787, UI on http://localhost:5173).
   Wait for both to come up (`curl -s localhost:8787/api/state`).
5. **Run the full flow headlessly** to prove it works, then summarise the output:
   `npm run demo:cli` runs all five steps against the running API (rules → plan → card → blocked → settled).
   To exercise everything, including a PDF upload, another vendor misbehaviour and the refund, call the
   API directly in this order (all `POST`, JSON bodies):
   - `/api/reset`
   - `/api/act1`, with body `{}` (or `{"forceEmulator":true}` to stay offline)
   - `/api/contract`, with body `{"filename","mimeType","data"}`: the base64 of a file from `samples/`.
     Use `/api/contract/sample` for the built-in CloudScale form.
   - `/api/act2`: Claude reads the contract and the engine picks the plan
   - `/api/approve`: the signed approval, then the Airwallex card is issued
   - `/api/shock`, with body `{"mode":"FEE"}` (adds a $250 fee) or `{"mode":"CADENCE_FLIP"}` (switches the plan)
   - `/api/resolve`: holds the vendor to the approved terms and pays exactly the approved amount
   - `/api/refund`: refunds through Airwallex and restores the card's limit

   Each response is `{ ok, state }`. `state.machineState` should end at `SETTLED`.
   `state.rail.mode` says whether the run was `LIVE` or `EMULATOR`.
6. **Hand over to the person.** Tell them to open http://localhost:5173 and either click **Auto-play demo**
   or step through it. Step 2 has the PDF upload, with three sample order forms that lead to different
   decisions. **Under the hood** shows every Airwallex call, TAP signature and state transition.
7. **Optional audit with the Airwallex Developer MCP** (live sandbox only):
   `claude mcp add-json airwallex-dev '{"type":"http","url":"https://mcp.sandbox.airwallex.com/developer"}'`,
   then the person signs in through `/mcp`. Use `list_cards` and `list_issuing_transactions` to show the
   $1,250 `LIMIT_EXCEEDED` decline, the `CARD_INACTIVE` retry, the cleared payment and the refund.
   Never reveal full card numbers or CVVs.

## Ground rules for changes

- Money math, limits, hashes, signatures and state transitions live in `packages/deterministic-engine`
  and must stay deterministic. Claude (`packages/cognitive-agent`) only parses contracts and narrates,
  and its output is grounded against the source and the engine's facts.
- Every live Airwallex call goes to the **sandbox** (`api.sandbox.airwallex.com`).
- `video/` builds the demo video; it is not needed to run the app.
