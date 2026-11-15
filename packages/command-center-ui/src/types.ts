// UI-side view of the orchestrator's RunState (kept loose on purpose; the server owns the schema).

export interface TelemetryEvent {
  id: string;
  ts: string;
  channel: 'AIRWALLEX' | 'MERCHANT' | 'VISA_TAP' | 'CLAUDE' | 'ENGINE' | 'OPERATOR';
  title: string;
  level: 'info' | 'success' | 'warn' | 'error';
  mode?: 'LIVE' | 'EMULATOR';
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  request?: unknown;
  response?: unknown;
  detail?: unknown;
}

export interface Flow {
  id: string;
  week: number;
  amount: number;
  label: string;
  kind: string;
}

export interface WeekRow {
  week: number;
  opening: number;
  closing: number;
  headroom: number;
  breach: boolean;
  flows: Flow[];
}

export interface Projection {
  optionId: string;
  weeks: WeekRow[];
  minBalance: number;
  minWeek: number;
  firstBreachWeek: number | null;
  maxShortfall: number;
  breach: boolean;
}

export interface Verdict {
  optionId: string;
  safe: boolean;
  firstBreachWeek: number | null;
  minBalance: number;
  minWeek: number;
  maxShortfall: number;
  annualizedCost: number;
}

export interface LlmTrace {
  engine: 'claude' | 'offline';
  via?: 'api' | 'claude-code';
  model?: string;
  ms: number;
  error?: string;
}

export interface Narrative {
  text: string;
  trace: LlmTrace;
  grounded: boolean;
  ungroundedFigures: string[];
}

export interface Limit {
  amount: number;
  interval: string;
  remaining: number;
}

export interface IntentDiff {
  field: string;
  approved: string;
  observed: string;
  delta?: string;
}

export interface LineItem {
  sku: string;
  description: string;
  amount: number;
}

export interface RunState {
  runId: string;
  act: number;
  machineState: string;
  history: { from: string; to: string; at: string; reason?: string }[];
  busy: string | null;
  error: string | null;
  rail: { mode: 'LIVE' | 'EMULATOR' | null; note: string };
  llm: { engine: 'claude' | 'offline'; model: string };
  guardrails?: { openingBalance: number; balanceSource: string; reserveFloor: number; horizonWeeks: number; scheduled: Flow[] };
  contract?: {
    document: string;
    parsed: {
      extraction: {
        vendor_name: string;
        product: string;
        sku: string;
        seats: number;
        options: { id: string; label: string; cadence: string; charge_amount: number; annualized_cost: number; refundable: boolean; source_quote: string }[];
        risk_clauses: { clause_ref: string; kind: string; summary: string; max_amount: number | null; source_quote: string }[];
      };
      grounding: { ok: boolean; issues: { path: string; problem: string }[] };
      trace: LlmTrace;
    };
  };
  plan?: {
    decision: {
      inputHash: string;
      baseline: Projection;
      projections: Record<string, Projection>;
      verdicts: Verdict[];
      recommendedOptionId: string | null;
      cheapestOptionId: string;
      savingsForgone: number;
      upgradeTrigger: { week: number; condition: string; projectedMinBalance: number } | null;
      rule: string;
    };
    narrative: Narrative;
  };
  intent?: { intent: { intentId: string; merchant: { name: string; mcc: string; id: string }; sku: string; billing: { cadence: string; amount: number; currency: string } }; intentHash: string; bindingHash: string };
  approval?: { approver: string; approvedAt: string; signature: string; keyId: string; verified: boolean };
  card?: {
    card: { card_id: string; card_status: string; card_number: string; brand: string; nick_name?: string; authorization_controls: { allowed_transaction_count: string; allowed_currencies?: string[]; allowed_merchant_categories?: string[]; active_to?: string; transaction_limits: { currency: string; limits: { amount: number; interval: string }[] } } };
    limits: { currency: string; limits: Limit[] };
    createPayload: unknown;
    mcpCardholderShape: unknown;
  };
  tap?: { keyid: string; jwk: unknown; lastSignatureInput?: string; lastSignatureBase?: string; lastTag?: string; verifications: number };
  checkout?: {
    cart: { cart_id: string; total: number; line_items: LineItem[] };
    order?: { order_id: string; status: string; charged_amount: number; charged_line_items: LineItem[]; authorization: { outcome: string; failure_reason?: string } };
    railAgreesWithPolicy?: boolean;
  };
  incident?: {
    verification: { approvedBindingHash: string; observedBindingHash: string; diffs: IntentDiff[]; unapprovedLineItems: LineItem[]; overage: number; summary: string };
    attemptedAmount: number;
    failureReason: string;
    cardStatusAfter: string;
    retry?: { outcome: string; failure_reason?: string };
    narrative: Narrative;
  };
  reapproval?: { verified: boolean; approvedAt: string };
  settlement?: { order: { order_id: string; charged_amount: number; capture?: { outcome: string } }; narrative: Narrative; limitsAfter: { limits: Limit[] }; settledAt: string; cardStatus: string };
  triggers: { id: string; week: number; condition: string; action: string; status: string }[];
  blockedBotProbe?: { status: number; reason: string };
}
