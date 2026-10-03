// file: core/test/helpers/https-stub.ts
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateSelfSignedCert } from '../../src/sync/cert.js';

/** A throwaway HTTPS server with a fresh self-signed certificate; `seen` lists every request that reached it. */
export async function stubServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const c = generateSelfSignedCert();
  const seen: string[] = [];
  const srv = https.createServer({ cert: c.certPem, key: c.keyPem }, (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { seen.push(`${req.method} ${req.url}`); handler(req, res, body); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `https://127.0.0.1:${port}`, fingerprint: c.fingerprint, seen,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

