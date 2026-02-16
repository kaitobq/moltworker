import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv, MoltbotEnv } from '../types';
import { createMockEnv } from '../test-utils';
import { cdp } from './cdp';

function createApp() {
  const app = new Hono<AppEnv>();
  app.route('/cdp', cdp);
  return app;
}

function createCdpEnv(overrides: Partial<MoltbotEnv> = {}): MoltbotEnv {
  return createMockEnv({
    CDP_SECRET: 'test-secret',
    BROWSER: {} as Fetcher,
    ...overrides,
  });
}

async function request(path: string, overrides: Partial<MoltbotEnv> = {}): Promise<Response> {
  const app = createApp();
  return app.request(`http://localhost${path}`, {}, createCdpEnv(overrides));
}

describe('cdp routes', () => {
  it('returns 503 when CDP_SECRET is not configured', async () => {
    const res = await request('/cdp/json/version?secret=test-secret', { CDP_SECRET: undefined });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: 'CDP endpoint not configured',
    });
  });

  it('returns 401 when secret is missing', async () => {
    const res = await request('/cdp/json/version');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when secret is invalid', async () => {
    const res = await request('/cdp/json/version?secret=wrong');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 503 when browser binding is missing', async () => {
    const res = await request('/cdp/json/version?secret=test-secret', { BROWSER: undefined });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Browser Rendering not configured',
    });
  });

  it('returns browser debugger URL in /json/version', async () => {
    const res = await request('/cdp/json/version?secret=test-secret');
    expect(res.status).toBe(200);

    await expect(res.json()).resolves.toMatchObject({
      Browser: 'Cloudflare-Browser-Rendering/1.0',
      webSocketDebuggerUrl:
        'ws://localhost/cdp/devtools/browser/cloudflare-browser?secret=test-secret',
    });
  });

  it('returns page target info in /json/list', async () => {
    const res = await request('/cdp/json/list?secret=test-secret');
    expect(res.status).toBe(200);

    await expect(res.json()).resolves.toEqual([
      {
        description: '',
        devtoolsFrontendUrl: '',
        id: 'cloudflare-browser',
        title: 'Cloudflare Browser Rendering',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl:
          'ws://localhost/cdp/devtools/page/cloudflare-browser?secret=test-secret',
      },
    ]);
  });

  it('returns /json alias with the same payload as /json/list', async () => {
    const res = await request('/cdp/json?secret=test-secret');
    expect(res.status).toBe(200);

    await expect(res.json()).resolves.toEqual([
      {
        description: '',
        devtoolsFrontendUrl: '',
        id: 'cloudflare-browser',
        title: 'Cloudflare Browser Rendering',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl:
          'ws://localhost/cdp/devtools/page/cloudflare-browser?secret=test-secret',
      },
    ]);
  });

  it('returns target placeholder from /json/new with explicit url', async () => {
    const target = encodeURIComponent('https://example.com/path?a=1');
    const res = await request(`/cdp/json/new?secret=test-secret&url=${target}`);
    expect(res.status).toBe(200);

    await expect(res.json()).resolves.toEqual({
      description: '',
      devtoolsFrontendUrl: '',
      id: 'cloudflare-browser',
      title: 'Cloudflare Browser Rendering',
      type: 'page',
      url: 'https://example.com/path?a=1',
      webSocketDebuggerUrl:
        'ws://localhost/cdp/devtools/page/cloudflare-browser?secret=test-secret',
    });
  });

  it('returns upgrade-required error on devtools websocket endpoint without Upgrade header', async () => {
    const res = await request('/cdp/devtools/browser/cloudflare-browser?secret=test-secret');
    expect(res.status).toBe(200);

    await expect(res.json()).resolves.toMatchObject({
      error: 'WebSocket upgrade required',
      hint: 'Connect via WebSocket: ws://host/cdp/devtools/browser/{id}?secret=<CDP_SECRET>',
    });
  });
});
