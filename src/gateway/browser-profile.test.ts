import { beforeAll, describe, expect, it, vi } from 'vitest';

type BrowserProfileHelper = {
  normalizeWorkerUrl: (rawWorkerUrl: string | undefined) => string | null;
  buildCloudflareCdpUrl: (workerUrl: string | undefined, secret: string | undefined) => string | null;
  applyCloudflareBrowserProfile: (
    config: Record<string, any>,
    env: Record<string, string | undefined>,
    logger: { warn: (msg: string) => void; log: (msg: string) => void },
  ) => { configured: boolean; reason: string | null; cdpUrl: string | null };
};

let helper: BrowserProfileHelper;

describe('patch-browser-profile helper', () => {
  beforeAll(async () => {
    helper = (await import('../../scripts/patch-browser-profile.cjs')) as BrowserProfileHelper;
  });

  it('normalizes worker URL with and without scheme', () => {
    expect(helper.normalizeWorkerUrl('https://moltbot.example.com/')).toBe(
      'https://moltbot.example.com',
    );
    expect(helper.normalizeWorkerUrl('moltbot.example.com')).toBe('https://moltbot.example.com');
  });

  it('builds encoded CDP URL', () => {
    const result = helper.buildCloudflareCdpUrl('https://moltbot.example.com/', 'a+b c');
    expect(result).toBe('https://moltbot.example.com/cdp?secret=a%2Bb%20c');
  });

  it('applies browser profile when WORKER_URL and CDP_SECRET are set', () => {
    const config = {
      browser: {
        profiles: {
          existing: {
            cdpUrl: 'wss://existing.example.com',
          },
          cloudflare: {
            label: 'keep-me',
          },
        },
      },
    };

    const logger = { warn: vi.fn(), log: vi.fn() };
    const result = helper.applyCloudflareBrowserProfile(
      config,
      {
        WORKER_URL: 'https://worker.example.com/',
        CDP_SECRET: 'top-secret',
      },
      logger,
    );

    expect(result).toEqual({
      configured: true,
      reason: null,
      cdpUrl: 'https://worker.example.com/cdp?secret=top-secret',
    });
    expect(config.browser.profiles.cloudflare).toEqual({
      label: 'keep-me',
      cdpUrl: 'https://worker.example.com/cdp?secret=top-secret',
    });
    expect(config.browser.profiles.existing).toEqual({
      cdpUrl: 'wss://existing.example.com',
    });
  });

  it('does not fail startup when env is missing', () => {
    const config = { browser: { profiles: { cloudflare: { cdpUrl: 'keep' } } } };
    const logger = { warn: vi.fn(), log: vi.fn() };

    const result = helper.applyCloudflareBrowserProfile(
      config,
      {
        WORKER_URL: undefined,
        CDP_SECRET: 'top-secret',
      },
      logger,
    );

    expect(result).toEqual({ configured: false, reason: 'missing_env', cdpUrl: null });
    expect(config.browser.profiles.cloudflare.cdpUrl).toBe('keep');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not apply profile when WORKER_URL is invalid', () => {
    const config: Record<string, any> = {};
    const logger = { warn: vi.fn(), log: vi.fn() };

    const result = helper.applyCloudflareBrowserProfile(
      config,
      {
        WORKER_URL: '://bad-url',
        CDP_SECRET: 'top-secret',
      },
      logger,
    );

    expect(result).toEqual({ configured: false, reason: 'invalid_worker_url', cdpUrl: null });
    expect(config.browser).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
