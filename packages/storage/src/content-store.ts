import type { ContentStore } from './types';

function assertSafeKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Content keys must be lowercase SHA-256 digests.');
  }
}

async function contentDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle('lexianchor', { create: true });
  return appDirectory.getDirectoryHandle('books', { create: true });
}

export class OpfsContentStore implements ContentStore {
  async put(key: string, data: ArrayBuffer): Promise<void> {
    assertSafeKey(key);
    const directory = await contentDirectory();
    const handle = await directory.getFileHandle(key, { create: true });
    const writer = await handle.createWritable();

    try {
      await writer.write(data);
    } finally {
      await writer.close();
    }
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    assertSafeKey(key);

    try {
      const directory = await contentDirectory();
      const handle = await directory.getFileHandle(key);
      return (await handle.getFile()).arrayBuffer();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return null;
      }

      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);

    try {
      const directory = await contentDirectory();
      await directory.removeEntry(key);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw error;
      }
    }
  }
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
