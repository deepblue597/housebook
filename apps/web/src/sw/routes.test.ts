import { describe, expect, it } from 'vitest';
import { SIGNIN_PARAM as APP_SIGNIN_PARAM } from '../app/pwa';
import { SIGNIN_PARAM, isCacheable, isUsablePage, markCachedShell, routeOf } from './routes';

const O = 'https://house.example';
const req = (path: string, mode = 'cors', method = 'GET') => ({ method, mode, url: O + path });

describe('routeOf', () => {
  it('never answers data, events or health checks', () => {
    for (const p of [
      '/api/snapshot',
      '/api/events',
      '/api',
      '/api/items/it_1',
      '/healthz',
      '/readyz',
    ])
      expect(routeOf(req(p), O)).toBe('network');
    expect(routeOf(req('/api/me', 'navigate'), O)).toBe('network');
  });

  it('answers page loads, but lets ?signin through to the login proxy', () => {
    expect(routeOf(req('/', 'navigate'), O)).toBe('page');
    expect(routeOf(req('/i/it_1?x=1', 'navigate'), O)).toBe('page');
    expect(routeOf(req('/print/emergency', 'navigate'), O)).toBe('page');
    expect(routeOf(req('/i/it_1?signin=1', 'navigate'), O)).toBe('network');
  });

  it('serves hashed build files from the cache, other app files network first', () => {
    expect(routeOf(req('/assets/index-B-8E9Zom.js', 'no-cors'), O)).toBe('asset');
    expect(routeOf(req('/manifest.webmanifest'), O)).toBe('static');
    expect(routeOf(req('/icon-192.png', 'no-cors'), O)).toBe('static');
    expect(routeOf(req('/sw.js'), O)).toBe('network');
  });

  it('leaves writes and other origins alone', () => {
    expect(routeOf(req('/', 'navigate', 'POST'), O)).toBe('network');
    expect(routeOf(req('/assets/x.js', 'cors', 'HEAD'), O)).toBe('network');
    expect(routeOf({ method: 'GET', mode: 'navigate', url: 'https://sso.example/auth' }, O)).toBe(
      'network',
    );
  });

  it('uses the same ?signin as the app', () => {
    expect(SIGNIN_PARAM).toBe(APP_SIGNIN_PARAM);
  });
});

describe('page answers', () => {
  it('uses only real pages from the network: no errors, no redirects to the login', () => {
    expect(isUsablePage({ ok: true })).toBe(true);
    expect(isUsablePage({ ok: false })).toBe(false); // 5xx, 401/403, opaqueredirect (status 0)
    expect(isUsablePage(null)).toBe(false); // network error
  });

  it('marks the saved app so it knows where it came from', () => {
    expect(markCachedShell('<!doctype html>\n<html lang="en">\n<head>')).toBe(
      '<!doctype html>\n<html data-shell="cached" lang="en">\n<head>',
    );
    expect(markCachedShell('<html><body>')).toBe('<html data-shell="cached"><body>');
  });

  it('keeps only plain same-origin 200s', () => {
    expect(isCacheable({ ok: true, redirected: false, type: 'basic' })).toBe(true);
    expect(isCacheable({ ok: true, redirected: true, type: 'basic' })).toBe(false);
    expect(isCacheable({ ok: true, redirected: false, type: 'opaque' })).toBe(false);
    expect(isCacheable({ ok: false, redirected: false, type: 'basic' })).toBe(false);
  });
});
