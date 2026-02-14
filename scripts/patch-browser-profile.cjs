function normalizeWorkerUrl(rawWorkerUrl) {
  if (!rawWorkerUrl || typeof rawWorkerUrl !== 'string') {
    return null;
  }

  const trimmed = rawWorkerUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildCloudflareCdpUrl(workerUrl, secret) {
  if (!workerUrl || !secret) {
    return null;
  }

  const normalizedOrigin = normalizeWorkerUrl(workerUrl);
  if (!normalizedOrigin) {
    return null;
  }

  return `${normalizedOrigin}/cdp?secret=${encodeURIComponent(secret)}`;
}

function applyCloudflareBrowserProfile(config, env = process.env, logger = console) {
  const workerUrl = env.WORKER_URL;
  const secret = env.CDP_SECRET;

  if (!workerUrl || !secret) {
    logger.warn(
      'Browser profile not configured: set both WORKER_URL and CDP_SECRET to enable browser automation.',
    );
    return { configured: false, reason: 'missing_env', cdpUrl: null };
  }

  const cdpUrl = buildCloudflareCdpUrl(workerUrl, secret);
  if (!cdpUrl) {
    logger.warn('Browser profile not configured: WORKER_URL is invalid.');
    return { configured: false, reason: 'invalid_worker_url', cdpUrl: null };
  }

  config.browser = config.browser || {};
  config.browser.profiles = config.browser.profiles || {};
  config.browser.profiles.cloudflare = {
    ...(config.browser.profiles.cloudflare || {}),
    cdpUrl,
  };

  logger.log('Browser profile configured: browser.profiles.cloudflare.cdpUrl');
  return { configured: true, reason: null, cdpUrl };
}

module.exports = {
  normalizeWorkerUrl,
  buildCloudflareCdpUrl,
  applyCloudflareBrowserProfile,
};
