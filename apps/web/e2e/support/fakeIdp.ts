/**
 * A login provider for e2e tests of HOUSEBOOK_AUTH_MODE=oidc (D48): discovery, keys, an
 * authorize page with one "Sign in as …" button per person, the token endpoint (checks PKCE and
 * the client secret, signs a real RS256 ID token), userinfo and logout.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Person {
  sub: string;
  preferred_username: string;
  name: string;
  groups: string[];
}

export const CLIENT_ID = 'housebook';
export const CLIENT_SECRET = 'e2e-secret';

export interface FakeIdp {
  issuer: string;
  /** Logouts seen (the `post_logout_redirect_uri` each asked for). */
  logouts: string[];
  stop: () => Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startFakeIdp(people: Person[]): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { nonce: string; challenge: string; person: Person }>();
  const logouts: string[] = [];
  let issuer = '';

  const idToken = (claims: Record<string, unknown>) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'e2e' }));
    const body = b64url(JSON.stringify(claims));
    const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
    return `${head}.${body}.${b64url(sig)}`;
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((ok) => {
      let s = '';
      req.on('data', (d: Buffer) => (s += d.toString()));
      req.on('end', () => ok(s));
    });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      const q = url.searchParams;
      if (url.pathname === '/.well-known/openid-configuration')
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/certs`,
          userinfo_endpoint: `${issuer}/userinfo`,
          end_session_endpoint: `${issuer}/logout`,
        });
      if (url.pathname === '/certs') return json(res, 200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        // The login page: one button per person, each a link back with a fresh code.
        const links = people.map((p) => {
          const code = b64url(randomBytes(16));
          codes.set(code, {
            nonce: q.get('nonce') ?? '',
            challenge: q.get('code_challenge') ?? '',
            person: p,
          });
          const back = new URL(q.get('redirect_uri') ?? '');
          back.searchParams.set('code', code);
          back.searchParams.set('state', q.get('state') ?? '');
          return `<li><a href="${back.toString().replace(/&/g, '&amp;')}">Sign in as ${p.name}</a></li>`;
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(
          `<!doctype html><title>Fake login</title><h1>Fake login</h1><ul>${links.join('')}</ul>`,
        );
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        if (req.headers.authorization !== `Basic ${basic}`)
          return json(res, 401, { error: 'invalid_client' });
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!grant || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge)
          return json(res, 400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const { sub, preferred_username, name } = grant.person;
        const profile = { sub, preferred_username, name };
        return json(res, 200, {
          token_type: 'Bearer',
          access_token: `at-${grant.person.sub}`,
          // Groups only from userinfo, like Authelia's default.
          id_token: idToken({
            iss: issuer,
            aud: CLIENT_ID,
            iat: now,
            exp: now + 300,
            nonce: grant.nonce,
            ...profile,
          }),
        });
      }
      if (url.pathname === '/userinfo') {
        const person = people.find((p) => req.headers.authorization === `Bearer at-${p.sub}`);
        return person ? json(res, 200, person) : json(res, 401, { error: 'invalid_token' });
      }
      if (url.pathname === '/logout') {
        const back = q.get('post_logout_redirect_uri') ?? '';
        logouts.push(back);
        res.writeHead(302, { Location: back });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    logouts,
    stop: () => new Promise((ok) => server.close(() => ok())),
  };
}
