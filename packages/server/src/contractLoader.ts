/**
 * Turn an uploaded vendor contract into plain text for the agent.
 * PDFs are text-extracted deterministically (no OCR); text/markdown is decoded as UTF-8.
 * The extracted text is what Claude reads AND what the grounding check verifies against.
 */
import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface LoadedContract {
  text: string;
  pages?: number;
}

export async function contractToText(filename: string, mimeType: string, base64: string): Promise<LoadedContract> {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) throw new Error('The file is empty');
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('File is larger than 8 MB');
  const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(filename) || buf.subarray(0, 5).toString() === '%PDF-';
  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { text: normalize(String(text)), pages: totalPages };
  }
  if (/\.(txt|md|markdown|text)$/i.test(filename) || mimeType.startsWith('text/')) {
    return { text: normalize(buf.toString('utf8')) };
  }
  throw new Error('Upload a PDF, .txt or .md file');
}

function normalize(t: string) {
  return t.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
