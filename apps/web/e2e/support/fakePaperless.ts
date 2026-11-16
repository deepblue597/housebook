/**
 * Paperless-ngx's API for e2e tests of receipts (D52), as far as Housebook uses it: full-text
 * search, a document, its thumbnail and its preview. Answers 401 without the right token.
 */
import { type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makePdf } from './server';

export const PAPERLESS_TOKEN = 'e2e-paperless-token';

export interface PaperlessDocument {
  id: number;
  title: string;
  created: string;
}

export interface FakePaperless {
  url: string;
  docs: Map<number, PaperlessDocument>;
  stop: () => Promise<void>;
}

// A 1×1 PNG: the thumbnail of every document.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export async function startFakePaperless(docs: PaperlessDocument[]): Promise<FakePaperless> {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Token ${PAPERLESS_TOKEN}`)
      return json(res, 401, { detail: 'Invalid token.' });
    const url = new URL(req.url ?? '/', 'http://paperless');
    if (url.pathname === '/api/documents/') {
      const words = (url.searchParams.get('query') ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const results = [...byId.values()]
        .filter((d) => words.every((w) => d.title.toLowerCase().includes(w)))
        .sort((a, b) => b.created.localeCompare(a.created));
      return json(res, 200, { count: results.length, next: null, previous: null, results });
    }
    const m = /^\/api\/documents\/(\d+)\/(thumb\/|preview\/)?$/.exec(url.pathname);
    const doc = m ? byId.get(Number(m[1])) : undefined;
    if (!m || !doc) return json(res, 404, { detail: 'No Document matches the given query.' });
    if (m[2] === 'thumb/') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (m[2] === 'preview/') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(makePdf([doc.title]));
    }
    return json(res, 200, { ...doc, original_file_name: `${doc.title}.pdf` });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    docs: byId,
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
