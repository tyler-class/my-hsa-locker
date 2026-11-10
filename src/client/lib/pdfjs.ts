// pdf.js, loaded only when a PDF is shown (import('./pdfjs')), so it never weighs on the main
// bundle. The worker is its own file; fonts, CMaps, ICC profiles and image decoders (wasm) are
// copied to /pdfjs/ at build time (vite.config.ts) and fetched only when a PDF needs them.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

/** Opens a PDF from its bytes (a copy is handed to the worker). */
export function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(bytes.slice(0)),
    wasmUrl: '/pdfjs/wasm/',
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    cMapUrl: '/pdfjs/cmaps/',
    iccUrl: '/pdfjs/iccs/',
    enableXfa: false,
  }).promise;
}
