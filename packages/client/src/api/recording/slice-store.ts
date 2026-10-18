/**
 * Where the shoot screen keeps Director's recording until it's uploaded: each slice the
 * recorder hands over, and each part's end, in that order. Kept in the browser's
 * IndexedDB, so a dead tab, a crash or a dropped connection loses at most the slice the
 * recorder was still making, and a shoot screen opened again sends the rest.
 *
 * Seam: `SliceStore` is what the uploader (./upload-slices.ts) reads and writes.
 * `IndexedDbSliceStore` is the browser's; `MemorySliceStore` keeps it for this page only
 * (a browser without IndexedDB, React Native until it has a store of its own, tests). A
 * store on a device's own file system is another `SliceStore`; the uploader doesn't change.
 */
import { type RecordingSessionId, recordingSessionIdSchema } from "@repo/contracts/ids";
import * as z from "zod";

/** A slice of a part, waiting to be uploaded. */
export interface QueuedSlice {
  kind: "slice";
  sessionId: RecordingSessionId;
  partIndex: number;
  index: number;
  /** Where it starts in its part's clock, and how long it lasts, in milliseconds. */
  startMs: number;
  durationMs: number;
  bytes: Blob;
}

/** A part's recorder stopped after `sliceCount` slices: sent once they're all uploaded. */
interface QueuedPartEnd {
  kind: "part-end";
  sessionId: RecordingSessionId;
  partIndex: number;
  sliceCount: number;
}

export type QueuedItem = QueuedSlice | QueuedPartEnd;

/** An item's place in the store: one slice of a part, or its end. */
export function keyOf(item: QueuedItem) {
  const which = item.kind === "slice" ? String(item.index).padStart(4, "0") : "end";
  return `${item.sessionId}/${String(item.partIndex).padStart(3, "0")}/${which}`;
}

/**
 * The order items are sent in: a part's slices from its first, then its end. Keys compare
 * by code unit, as IndexedDB orders them.
 */
function byKey(a: QueuedItem, b: QueuedItem) {
  const [first, second] = [keyOf(a), keyOf(b)];
  return first < second ? -1 : Number(first > second);
}

export interface SliceStore {
  put(item: QueuedItem): Promise<void>;
  /** Everything still to send, in the order it's sent. */
  all(): Promise<QueuedItem[]>;
  /** The next to send, without reading the rest; null when there's none. */
  first(): Promise<QueuedItem | null>;
  remove(item: QueuedItem): Promise<void>;
}

export class MemorySliceStore implements SliceStore {
  private readonly items = new Map<string, QueuedItem>();

  async put(item: QueuedItem) {
    this.items.set(keyOf(item), item);
  }

  async all() {
    return [...this.items.values()].sort(byKey);
  }

  async first() {
    const [next = null] = await this.all();
    return next;
  }

  async remove(item: QueuedItem) {
    this.items.delete(keyOf(item));
  }
}

const DATABASE = "director-recording";
const ITEMS = "items";

/** What an IndexedDB request settles with. */
function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A write transaction, once it has committed. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** An item as IndexedDB holds it: under its key. */
type Stored = QueuedItem & { key: string };

const count = z.number().int().nonnegative();
const storedItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("slice"),
    sessionId: recordingSessionIdSchema,
    partIndex: count,
    index: count,
    startMs: count,
    durationMs: count,
    bytes: z.instanceof(Blob),
  }),
  z.object({
    kind: z.literal("part-end"),
    sessionId: recordingSessionIdSchema,
    partIndex: count,
    sliceCount: count,
  }),
]);

export class IndexedDbSliceStore implements SliceStore {
  private database: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open() {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(ITEMS, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.database;
  }

  private async write(change: (items: IDBObjectStore) => void) {
    const transaction = (await this.open()).transaction(ITEMS, "readwrite");
    change(transaction.objectStore(ITEMS));
    await committed(transaction);
  }

  async put(item: QueuedItem) {
    const stored: Stored = { ...item, key: keyOf(item) };
    await this.write((items) => items.put(stored));
  }

  private async items() {
    return (await this.open()).transaction(ITEMS).objectStore(ITEMS);
  }

  async all() {
    const read: IDBRequest<unknown[]> = (await this.items()).getAll();
    // Read back as written, but parsed: another version of this page may have written it.
    return z
      .array(storedItem)
      .parse(await settled(read))
      .sort(byKey);
  }

  async first() {
    // IndexedDB keeps the items in key order: the first is a cursor's first step.
    const cursor = await settled((await this.items()).openCursor());
    return cursor ? storedItem.parse(cursor.value) : null;
  }

  async remove(item: QueuedItem) {
    await this.write((items) => items.delete(keyOf(item)));
  }
}

/** The browser's IndexedDB where there is one, or this page's memory. */
export function defaultSliceStore(): SliceStore {
  return typeof indexedDB === "undefined" ? new MemorySliceStore() : new IndexedDbSliceStore();
}
