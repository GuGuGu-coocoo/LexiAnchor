import { describe, expect, it, vi } from 'vitest';

import { formatStorageBytes, readStorageHealth, requestPersistentStorage } from './storage-health';

describe('storage health', () => {
  it('reports persistence and quota without requesting permission', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    const health = await readStorageHealth({
      persisted: () => Promise.resolve(false),
      persist,
      estimate: () => Promise.resolve({ usage: 12_500_000, quota: 100_000_000 }),
    });

    expect(health).toEqual({
      supported: true,
      persisted: false,
      usageBytes: 12_500_000,
      quotaBytes: 100_000_000,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests persistence only through the explicit action', async () => {
    let persisted = false;
    const health = await requestPersistentStorage({
      persisted: () => Promise.resolve(persisted),
      persist: () => {
        persisted = true;
        return Promise.resolve(true);
      },
      estimate: () => Promise.resolve({ usage: 1_000_000, quota: 2_000_000 }),
    });

    expect(health.persisted).toBe(true);
  });

  it('formats storage sizes for the interface locale', () => {
    expect(formatStorageBytes(12_500_000, 'en')).toBe('13 MB');
    expect(formatStorageBytes(1_250_000_000, 'en')).toBe('1.3 GB');
    expect(formatStorageBytes(null, 'en')).toBe('—');
  });
});
