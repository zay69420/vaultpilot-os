import type { ChatImageAttachment, ImageAttachmentInput, StoredImageAttachment } from "../types";

const DATABASE_VERSION = 1;
const ATTACHMENTS_STORE = "attachments";

export class AttachmentStore {
  private database: IDBDatabase | null = null;

  constructor(private readonly vaultIdentifier: string) {}

  async open(): Promise<void> {
    if (this.database) return;
    if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable in this Obsidian environment.");
    const readable = this.vaultIdentifier.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
    const safeIdentifier = `${readable}:${hashIdentifier(this.vaultIdentifier)}`;
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`vaultpilot-os-media:${safeIdentifier}`, DATABASE_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Could not open the attachment database."));
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ATTACHMENTS_STORE)) {
          database.createObjectStore(ATTACHMENTS_STORE, { keyPath: "id" });
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

  async saveMany(inputs: readonly ImageAttachmentInput[]): Promise<ChatImageAttachment[]> {
    if (inputs.length === 0) return [];
    const transaction = this.transaction("readwrite");
    const store = transaction.objectStore(ATTACHMENTS_STORE);
    const createdAt = Date.now();
    for (const input of inputs) {
      const record: StoredImageAttachment = {
        id: input.id,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        data: input.data,
        createdAt
      };
      store.put(record);
    }
    await transactionDone(transaction);
    return inputs.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
  }

  async get(id: string): Promise<StoredImageAttachment | undefined> {
    const request = this.transaction("readonly").objectStore(ATTACHMENTS_STORE).get(id);
    return requestResult<StoredImageAttachment | undefined>(request);
  }

  async deleteMany(ids: Iterable<string>): Promise<void> {
    const unique = new Set(ids);
    if (unique.size === 0) return;
    const transaction = this.transaction("readwrite");
    const store = transaction.objectStore(ATTACHMENTS_STORE);
    for (const id of unique) store.delete(id);
    await transactionDone(transaction);
  }

  async prune(validIds: Set<string>): Promise<void> {
    const keys = await requestResult<IDBValidKey[]>(
      this.transaction("readonly").objectStore(ATTACHMENTS_STORE).getAllKeys()
    );
    const stale = keys.filter((key): key is string => typeof key === "string" && !validIds.has(key));
    await this.deleteMany(stale);
  }

  private transaction(mode: IDBTransactionMode): IDBTransaction {
    if (!this.database) throw new Error("The attachment database has not been opened.");
    return this.database.transaction([ATTACHMENTS_STORE], mode);
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
    request.onerror = () => reject(request.error ?? new Error("IndexedDB attachment request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB attachment transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB attachment transaction was aborted."));
  });
}
