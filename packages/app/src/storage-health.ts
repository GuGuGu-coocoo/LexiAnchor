export interface StorageHealth {
  readonly supported: boolean;
  readonly persisted: boolean | null;
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
}

interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

function availableStorage(): StorageManagerLike | null {
  return typeof navigator === 'undefined' ? null : navigator.storage;
}

function validByteCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function readStorageHealth(
  storage: StorageManagerLike | null = availableStorage(),
): Promise<StorageHealth> {
  if (!storage) {
    return {
      supported: false,
      persisted: null,
      usageBytes: null,
      quotaBytes: null,
    };
  }

  const [persisted, estimate] = await Promise.all([
    storage.persisted?.().catch(() => null) ?? Promise.resolve(null),
    storage.estimate?.().catch(() => null) ?? Promise.resolve(null),
  ]);

  return {
    supported: typeof storage.persist === 'function',
    persisted,
    usageBytes: validByteCount(estimate?.usage),
    quotaBytes: validByteCount(estimate?.quota),
  };
}

export async function requestPersistentStorage(
  storage: StorageManagerLike | null = availableStorage(),
): Promise<StorageHealth> {
  if (storage?.persist) {
    await storage.persist().catch(() => false);
  }

  return readStorageHealth(storage);
}

export function formatStorageBytes(bytes: number | null, locale: string): string {
  if (bytes === null) {
    return '—';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1_000 && unitIndex < units.length - 1) {
    value /= 1_000;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value < 10 && unitIndex > 0 ? 1 : 0,
  }).format(value)} ${units[unitIndex]}`;
}
