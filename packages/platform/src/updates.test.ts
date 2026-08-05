import { describe, expect, it, vi } from 'vitest';

import {
  checkLatestStableRelease,
  isNewerStableVersion,
  latestStableReleaseApiUrl,
  parseStableRelease,
} from './updates';

const stableRelease = {
  tag_name: 'v0.1.3',
  name: 'LexiAnchor v0.1.3',
  html_url: 'https://github.com/GuGuGu-coocoo/LexiAnchor/releases/tag/v0.1.3',
  published_at: '2026-08-05T02:00:00Z',
  draft: false,
  prerelease: false,
};

describe('stable release updates', () => {
  it('compares stable versions without treating candidates as newer', () => {
    expect(isNewerStableVersion('0.1.3', '0.1.2')).toBe(true);
    expect(isNewerStableVersion('0.1.2', '0.1.2')).toBe(false);
    expect(isNewerStableVersion('0.1.2', '0.1.3-rc.1')).toBe(false);
  });

  it('accepts only stable releases from the project release page', () => {
    expect(parseStableRelease(stableRelease)?.version).toBe('0.1.3');
    expect(parseStableRelease({ ...stableRelease, draft: true })).toBeNull();
    expect(parseStableRelease({ ...stableRelease, prerelease: true })).toBeNull();
    expect(
      parseStableRelease({ ...stableRelease, html_url: 'https://example.com/v0.1.3' }),
    ).toBeNull();
  });

  it('checks the latest stable endpoint and reports an available update', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(stableRelease), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(checkLatestStableRelease('0.1.2', fetcher)).resolves.toMatchObject({
      status: 'available',
      currentVersion: '0.1.2',
      release: { version: '0.1.3' },
    });
    expect(fetcher).toHaveBeenCalledWith(latestStableReleaseApiUrl, expect.any(Object));
  });

  it('fails closed when GitHub is unavailable or returns invalid metadata', async () => {
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const invalid = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...stableRelease, prerelease: true }), { status: 200 }),
      );

    await expect(checkLatestStableRelease('0.1.2', offline)).resolves.toEqual({
      status: 'unavailable',
      currentVersion: '0.1.2',
    });
    await expect(checkLatestStableRelease('0.1.2', invalid)).resolves.toEqual({
      status: 'unavailable',
      currentVersion: '0.1.2',
    });
  });
});
