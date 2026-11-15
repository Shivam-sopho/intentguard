import { describe, expect, it } from 'vitest';
import { VENDOR_QUOTE_DOCUMENT } from '@intentguard/deterministic-engine';
import { checkGrounding, groundExtraction, offlineParse, squash } from '../src/index.js';

describe('LLM output is untrusted: deterministic grounding', () => {
  it('accepts an extraction whose prices and quotes are in the document', () => {
    const g = groundExtraction(VENDOR_QUOTE_DOCUMENT, offlineParse(VENDOR_QUOTE_DOCUMENT));
    expect(g.ok).toBe(true);
    expect(g.options.map((o) => [o.id, o.chargeAmount, o.annualizedCost])).toEqual([
      ['ANNUAL_UPFRONT', 9600, 9600],
      ['MONTHLY', 1000, 12000],
    ]);
  });

  it('rejects a hallucinated price', () => {
    const x = offlineParse(VENDOR_QUOTE_DOCUMENT);
    x.options[1].charge_amount = 950;
    const g = groundExtraction(VENDOR_QUOTE_DOCUMENT, x);
    expect(g.ok).toBe(false);
    expect(g.issues[0].problem).toMatch(/does not appear/);
  });

  it('rejects a fabricated source quote', () => {
    const x = offlineParse(VENDOR_QUOTE_DOCUMENT);
    x.risk_clauses[0].source_quote = 'No renewal obligations apply.';
    expect(groundExtraction(VENDOR_QUOTE_DOCUMENT, x).ok).toBe(false);
  });

  it('recomputes annualized cost in code instead of trusting the model', () => {
    const x = offlineParse(VENDOR_QUOTE_DOCUMENT);
    x.options[1].annualized_cost = 10_000;
    const g = groundExtraction(VENDOR_QUOTE_DOCUMENT, x);
    expect(g.ok).toBe(true); // non-blocking, corrected
    expect(g.options[1].annualizedCost).toBe(12_000);
    expect(g.issues.some((i) => i.path.endsWith('annualized_cost'))).toBe(true);
  });

  it('flags narrative dollar figures that are not in the engine facts', () => {
    const facts = { approved: 1000, attempted: 1250 };
    expect(checkGrounding('Blocked $1,250.00 against $1,000.00.', facts).grounded).toBe(true);
    const bad = checkGrounding('Blocked $1,250.00; saved $3,000.', facts);
    expect(bad.grounded).toBe(false);
    expect(bad.ungrounded).toEqual(['$3,000']);
  });

  it('treats PDF line-wrap hyphenation and curly quotes as verbatim', () => {
    const pdfText = 'USD 9,600.00 billed\nimmediately for a 12-\nmonth term. Annual fees are non-\nrefundable. Cancel with 30 days\u2019 notice.';
    expect(squash(pdfText)).toContain(squash('USD 9,600.00 billed immediately for a 12-month term'));
    expect(squash(pdfText)).toContain(squash('Annual fees are non-refundable.'));
    expect(squash(pdfText)).toContain(squash("Cancel with 30 days' notice."));
  });
});
