import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contractToText } from '../src/contractLoader.js';

describe('contract upload', () => {
  it('extracts text from the sample PDFs so prices can be grounded', async () => {
    const pdf = readFileSync(new URL('../../../samples/cloudscale-order-form.pdf', import.meta.url)).toString('base64');
    const { text, pages } = await contractToText('cloudscale-order-form.pdf', 'application/pdf', pdf);
    expect(pages).toBe(1);
    expect(text).toContain('USD 9,600.00');
    expect(text).toContain('USD 1,000.00');
    expect(text).toContain('4.5 Onboarding.');
  });

  it('accepts text files and rejects other types', async () => {
    const b64 = Buffer.from('Order form\r\nUSD 100.00 per month').toString('base64');
    expect((await contractToText('quote.txt', 'text/plain', b64)).text).toBe('Order form\nUSD 100.00 per month');
    await expect(contractToText('quote.docx', 'application/msword', b64)).rejects.toThrow(/PDF, .txt or .md/);
  });
});
