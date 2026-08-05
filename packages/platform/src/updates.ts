export const latestStableReleaseApiUrl =
  'https://api.github.com/repos/GuGuGu-coocoo/LexiAnchor/releases/latest';

export interface StableRelease {
  readonly version: string;
  readonly name: string;
  readonly url: string;
  readonly publishedAt: string;
}

export type UpdateCheckResult =
  | {
      readonly status: 'available';
      readonly currentVersion: string;
      readonly release: StableRelease;
    }
  | {
      readonly status: 'up-to-date';
      readonly currentVersion: string;
      readonly release: StableRelease;
    }
  | {
      readonly status: 'unavailable';
      readonly currentVersion: string;
    };

interface ReleaseResponse {
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly html_url?: unknown;
  readonly published_at?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return null;
  }

  return parts as unknown as readonly [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) {
    return false;
  }

  for (let index = 0; index < next.length; index += 1) {
    const nextPart = next[index] ?? 0;
    const installedPart = installed[index] ?? 0;
    if (nextPart !== installedPart) {
      return nextPart > installedPart;
    }
  }

  return false;
}

export function parseStableRelease(value: unknown): StableRelease | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const release = value as ReleaseResponse;
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== 'string' ||
    typeof release.html_url !== 'string' ||
    typeof release.published_at !== 'string'
  ) {
    return null;
  }

  const parsedVersion = parseVersion(release.tag_name);
  const publishedAt = Date.parse(release.published_at);
  let releaseUrl: URL;
  try {
    releaseUrl = new URL(release.html_url);
  } catch {
    return null;
  }

  if (
    !parsedVersion ||
    !Number.isFinite(publishedAt) ||
    releaseUrl.origin !== 'https://github.com' ||
    !releaseUrl.pathname.startsWith('/GuGuGu-coocoo/LexiAnchor/releases/tag/')
  ) {
    return null;
  }

  return {
    version: parsedVersion.join('.'),
    name:
      typeof release.name === 'string' && release.name.trim()
        ? release.name.trim()
        : `LexiAnchor v${parsedVersion.join('.')}`,
    url: releaseUrl.href,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

export async function checkLatestStableRelease(
  currentVersion: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<UpdateCheckResult> {
  try {
    const response = await fetcher(latestStableReleaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { status: 'unavailable', currentVersion };
    }

    const release = parseStableRelease(await response.json());
    if (!release) {
      return { status: 'unavailable', currentVersion };
    }

    return {
      status: isNewerStableVersion(release.version, currentVersion) ? 'available' : 'up-to-date',
      currentVersion,
      release,
    };
  } catch {
    return { status: 'unavailable', currentVersion };
  }
}
