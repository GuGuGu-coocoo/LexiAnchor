import { describe, expect, it } from 'vitest';

import { createStoredZip, readStoredZip } from './zip-store';

describe('stored ZIP codec', () => {
  it('round-trips UTF-8 file names and binary content', () => {
    const zip = createStoredZip(
      [
        { name: 'manifest.json', data: new TextEncoder().encode('{"version":1}') },
        { name: 'optional-content/书籍.pdf', data: new Uint8Array([0, 1, 2, 255]) },
      ],
      new Date('2026-07-26T00:00:00.000Z'),
    );
    const files = readStoredZip(zip);

    expect(new TextDecoder().decode(files.get('manifest.json'))).toBe('{"version":1}');
    expect(files.get('optional-content/书籍.pdf')).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it('rejects unsafe paths and corrupted content', () => {
    expect(() =>
      createStoredZip([{ name: '../database.sqlite', data: new Uint8Array([1]) }]),
    ).toThrow(/Unsafe ZIP entry path/);

    const zip = createStoredZip([{ name: 'data.jsonl', data: new Uint8Array([1, 2, 3]) }]);
    zip[41] = (zip[41] ?? 0) ^ 0xff;
    expect(() => readStoredZip(zip)).toThrow(/integrity check/i);
  });
});
