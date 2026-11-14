/**
 * Procurement lifecycle state machine. Every transition is explicit and guarded;
 * illegal transitions throw. The LLM can never move the machine.
 */

export type ProcurementState =
  | 'DRAFT'
  | 'GUARDRAILS_SET'
  | 'PLAN_PROPOSED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'CARD_ISSUED'
  | 'CHECKOUT_IN_PROGRESS'
  | 'QUARANTINED_FROZEN'
  | 'AUTHORIZED'
  | 'SETTLED'
  | 'ESCALATED'
  | 'CANCELLED';

export interface TransitionEvidence {
  approvalSignatureValid?: boolean;
  reapprovalSignatureValid?: boolean;
  cardId?: string;
  cardStatus?: string;
  bindingMatch?: boolean;
  safePlanExists?: boolean;
  railOutcome?: RailOutcome;
  reason?: string;
}

type Guard = (e: TransitionEvidence) => string | null;

const TRANSITIONS: Record<ProcurementState, Partial<Record<ProcurementState, Guard>>> = {
  DRAFT: { GUARDRAILS_SET: () => null },
  GUARDRAILS_SET: {
    PLAN_PROPOSED: (e) => (e.safePlanExists ? null : 'no reserve-safe plan exists'),
    ESCALATED: (e) => (e.safePlanExists === false ? null : 'escalation only when no safe plan exists'),
  },
  PLAN_PROPOSED: { AWAITING_APPROVAL: () => null },
  AWAITING_APPROVAL: {
    APPROVED: (e) => (e.approvalSignatureValid ? null : 'operator approval signature missing or invalid'),
    CANCELLED: () => null,
  },
  APPROVED: { CARD_ISSUED: (e) => (e.cardId && e.cardStatus === 'ACTIVE' ? null : 'card must be issued and ACTIVE') },
  CARD_ISSUED: { CHECKOUT_IN_PROGRESS: (e) => (e.bindingMatch ? null : 'cart does not match approved intent hash') },
  CHECKOUT_IN_PROGRESS: {
    AUTHORIZED: (e) => (e.railOutcome === 'AUTHORIZED' && e.bindingMatch ? null : 'authorization must be approved by the rail and match intent'),
    QUARANTINED_FROZEN: (e) => (e.cardStatus === 'INACTIVE' ? null : 'card must be frozen (INACTIVE) before quarantine'),
  },
  QUARANTINED_FROZEN: {
    CARD_ISSUED: (e) =>
      e.reapprovalSignatureValid && e.bindingMatch && e.cardStatus === 'ACTIVE'
        ? null
        : 'release needs signed re-approval, a cart matching the intent hash, and the card back to ACTIVE',
    CANCELLED: () => null,
  },
  AUTHORIZED: {
    SETTLED: (e) => (e.railOutcome === 'CLEARED' ? null : 'settlement requires CLEARING + APPROVED'),
    QUARANTINED_FROZEN: (e) => (e.cardStatus === 'INACTIVE' ? null : 'card must be frozen before quarantine'),
  },
  SETTLED: {},
  ESCALATED: {},
  CANCELLED: {},
};

export interface TransitionRecord {
  from: ProcurementState;
  to: ProcurementState;
  at: string;
  reason?: string;
}

export class IllegalTransitionError extends Error {}

export class ProcurementStateMachine {
  state: ProcurementState = 'DRAFT';
  history: TransitionRecord[] = [];

  can(to: ProcurementState, e: TransitionEvidence = {}): { ok: boolean; why?: string } {
    const guard = TRANSITIONS[this.state][to];
    if (!guard) return { ok: false, why: `no transition ${this.state} -> ${to}` };
    const why = guard(e);
    return why ? { ok: false, why } : { ok: true };
  }

  transition(to: ProcurementState, e: TransitionEvidence = {}): TransitionRecord {
    const check = this.can(to, e);
    if (!check.ok) throw new IllegalTransitionError(`${this.state} -> ${to} rejected: ${check.why}`);
    const rec: TransitionRecord = { from: this.state, to, at: new Date().toISOString(), reason: e.reason };
    this.state = to;
    this.history.push(rec);
    return rec;
  }

  static allowedFrom(state: ProcurementState): ProcurementState[] {
    return Object.keys(TRANSITIONS[state]) as ProcurementState[];
  }
}

// ---------------------------------------------------------------------------
// Rail result mapping (Airwallex Issuing)
// ---------------------------------------------------------------------------

export type RailOutcome = 'AUTHORIZED' | 'CLEARED' | 'REVERSED' | 'FAILED' | 'PENDING';

/**
 * Response of POST /api/v1/simulation/issuing/create (and the lifecycle capture/reverse endpoints).
 * Builder-guide rules: failure_reason present => declined (FAILED);
 * CLEARING + APPROVED => accepted (funds debited); AUTHORIZATION + APPROVED => funds reserved.
 */
export function mapSimulationResult(resp: { process_result?: string; failure_reason?: string | null; type?: string }): {
  outcome: RailOutcome;
  failure_reason?: string;
} {
  if (resp.failure_reason || resp.process_result === 'DECLINED') {
    return { outcome: 'FAILED', failure_reason: resp.failure_reason ?? 'DECLINED' };
  }
  if (resp.process_result !== 'APPROVED') return { outcome: 'PENDING' };
  switch (resp.type) {
    case 'CLEARING':
      return { outcome: 'CLEARED' };
    case 'AUTHORIZATION':
      return { outcome: 'AUTHORIZED' };
    case 'REVERSAL_AUTH':
      return { outcome: 'REVERSED' };
    default:
      return { outcome: 'PENDING' };
  }
}

/** Items of GET /api/v1/issuing/transactions (transaction_type + status). */
export function mapIssuingTransaction(tx: { transaction_type?: string; status?: string; failure_reason?: string | null }): {
  outcome: RailOutcome;
  failure_reason?: string;
} {
  if (tx.failure_reason || tx.status === 'FAILED') return { outcome: 'FAILED', failure_reason: tx.failure_reason ?? 'FAILED' };
  if (tx.transaction_type === 'CLEARING' && (tx.status === 'APPROVED' || tx.status === 'CLEARED')) return { outcome: 'CLEARED' };
  if (tx.transaction_type === 'AUTHORIZATION' && tx.status === 'PENDING') return { outcome: 'AUTHORIZED' };
  if (tx.transaction_type === 'AUTHORIZATION' && tx.status === 'APPROVED') return { outcome: 'AUTHORIZED' };
  if (tx.status === 'REVERSED' || tx.transaction_type === 'REVERSAL') return { outcome: 'REVERSED' };
  return { outcome: 'PENDING' };
}
