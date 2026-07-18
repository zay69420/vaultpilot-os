import type { IndexedFileMeta, VectorRecord } from "../types";

const DATABASE_VERSION = 1;
const CHUNKS_STORE = "chunks";
const FILES_STORE = "files";

export class VectorStore {
  private database: IDBDatabase | null = null;

  constructor(private readonly vaultIdentifier: string) {}

  async open(): Promise<void> {
    if (this.database) return;
    if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable in this Obsidian environment.");
    const readable = this.vaultIdentifier.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
    const safeIdentifier = `${readable}:${hashIdentifier(this.vaultIdentifier)}`;
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`vaultpilot-os:${safeIdentifier}`, DATABASE_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Could not open the vector database."));
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunks = database.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
          chunks.createIndex("path", "path", { unique: false });
        }
        if (!database.objectStoreNames.contains(FILES_STORE)) {
          database.createObjectStore(FILES_STORE, { keyPath: "path" });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  async getAllChunks(): Promise<VectorRecord[]> {
    const transaction = this.transaction([CHUNKS_STORE], "readonly");
    const request = transaction.objectStore(CHUNKS_STORE).getAll();
    return requestResult<VectorRecord[]>(request);
  }

  async getAllFileMeta(): Promise<IndexedFileMeta[]> {
    const transaction = this.transaction([FILES_STORE], "readonly");
    const request = transaction.objectStore(FILES_STORE).getAll();
    return requestResult<IndexedFileMeta[]>(request);
  }

  async getFileMeta(path: string): Promise<IndexedFileMeta | undefined> {
    const transaction = this.transaction([FILES_STORE], "readonly");
    const request = transaction.objectStore(FILES_STORE).get(path);
    return requestResult<IndexedFileMeta | undefined>(request);
  }

  async replaceFile(meta: IndexedFileMeta, records: VectorRecord[]): Promise<void> {
    const transaction = this.transaction([CHUNKS_STORE, FILES_STORE], "readwrite");
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const index = chunks.index("path");
    const cursorRequest = index.openKeyCursor(IDBKeyRange.only(meta.path));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        chunks.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      for (const record of records) chunks.put(record);
      transaction.objectStore(FILES_STORE).put(meta);
    };
    await transactionDone(transaction);
  }

  async deleteFile(path: string): Promise<void> {
    const transaction = this.transaction([CHUNKS_STORE, FILES_STORE], "readwrite");
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const cursorRequest = chunks.index("path").openKeyCursor(IDBKeyRange.only(path));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        chunks.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      transaction.objectStore(FILES_STORE).delete(path);
    };
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const transaction = this.transaction([CHUNKS_STORE, FILES_STORE], "readwrite");
    transaction.objectStore(CHUNKS_STORE).clear();
    transaction.objectStore(FILES_STORE).clear();
    await transactionDone(transaction);
  }

  private transaction(stores: string[], mode: IDBTransactionMode): IDBTransaction {
    if (!this.database) throw new Error("The vector database has not been opened.");
    return this.database.transaction(stores, mode);
  }
}

function hashIdentifier(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}
