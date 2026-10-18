/**
 * Uploads Director's recording as it's made: the shoot screen hands each slice the
 * recorder makes (and each part's end) to `enqueue`, and the uploader sends them in order,
 * one at a time: it asks the API to sign the slice's upload, PUTs the bytes straight to
 * storage, and completes it. Everything waits in a `SliceStore` (IndexedDB in a browser)
 * until it's sent, so a dead tab, a crash or a lost connection loses at most the slice the
 * recorder was still making: the shoot screen opened again sends the rest by itself.
 *
 * A failure that may pass (no connection, storage or the API unavailable, a rate limit) is
 * tried again later, waiting longer each time; one that won't (the session deleted, past
 * its 20 minutes, the member's footage allowance full, the workspace left) drops that
 * slice and says why, so one slice never holds up the rest.
 *
 * The queue holds at most five minutes of footage (a phone short of storage, a network
 * gone for long): a slice past that is refused, and `full` says so until one is sent, for
 * the shoot screen to pause recording meanwhile.
 */
import type { ErrorCode } from "@repo/contracts/errors";
import { RECORDING_QUEUE_MAX_MS } from "@repo/contracts/recording";
import { SECOND_MS } from "@repo/contracts/time";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ApiClient } from "../../client";
import { errorCode } from "../../errors";
import { useApi } from "../../provider";
import { UploadFailedError } from "../files/upload";
import { defaultSliceStore, keyOf, type QueuedItem, type SliceStore } from "./slice-store";

/** How long to wait before trying again, after each failure in a row (the last repeats). */
export const RETRY_DELAYS_MS = [1, 2, 5, 10, 30].map((seconds) => seconds * SECOND_MS);

/** The wait before the next try, after `failures` failures in a row. */
export function retryDelay(failures: number) {
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
}

/** Refusals no retry changes: the slice (or part's end) is dropped, and the error shown. */
const FINAL = new Set<ErrorCode>([
  "RECORDING_NOT_FOUND",
  "RECORDING_PART_NOT_FOUND",
  "RECORDING_PART_CLOSED",
  "RECORDING_LIMIT_REACHED",
  "RECORDING_STORAGE_FULL",
  "RECORDING_SLICE_INVALID",
  "VALIDATION_FAILED",
  "FEATURE_DISABLED",
  "NO_ACTIVE_ORGANIZATION",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
]);

interface UploadState {
  /** Slices and part ends still to send. */
  pending: number;
  /** How much recording is still to send, in milliseconds: "Saving footage, 1 min behind". */
  behindMs: number;
  /** The last failure, until something is sent again. */
  error: ErrorCode | null;
  /** A slice was refused for the queue's five minutes, and none has been sent since. */
  full: boolean;
}

const IDLE: UploadState = { pending: 0, behindMs: 0, error: null, full: false };

/** Sends a slice's bytes to storage with the headers its upload was signed with. */
async function put(upload: { url: string; headers: Record<string, string> }, bytes: Blob) {
  // Content-Length is set by the browser from the body; the rest as signed.
  const headers = Object.fromEntries(
    Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
  const response = await fetch(upload.url, { method: "PUT", headers, body: bytes });
  if (!response.ok) {
    throw new UploadFailedError(response.status);
  }
}

/** How much recording an item holds: a slice's length; a part's end, none. */
function durationOf(item: QueuedItem) {
  return item.kind === "slice" ? item.durationMs : 0;
}

class SliceUploader {
  private state: UploadState = IDLE;
  private readonly listeners = new Set<() => void>();
  private sending: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = false;
  // Asked to send again while sending: what the running pass already read may be stale.
  private asked = false;
  // What's queued, by key: how long each lasts (a part's end, nothing). Read from the
  // store once, then kept as items come and go, so a pass never reads the whole store.
  private queued = new Map<string, number>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly client: ApiClient,
    private readonly store: SliceStore,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.state;

  /**
   * Queues a slice or a part's end, and sends it (after whatever is ahead of it). False
   * when a slice is refused: the queue holds five minutes already.
   */
  enqueue = async (item: QueuedItem) => {
    await this.loaded();
    const behind = this.state.behindMs;
    if (item.kind === "slice" && behind + item.durationMs > RECORDING_QUEUE_MAX_MS) {
      this.update({ full: true });
      return false;
    }
    await this.store.put(item);
    this.queued.set(keyOf(item), durationOf(item));
    this.update({});
    await this.send();
    return true;
  };

  /**
   * Sends everything queued, a dead tab's leftovers included. Resolves (never rejects)
   * once the queue is empty, or a failure has it waiting to try again.
   */
  send = () => {
    this.stopped = false;
    this.asked = true;
    this.sending ??= this.drain();
    return this.sending;
  };

  /** Stops sending (the shoot screen closed): what's queued stays for next time. */
  stop = () => {
    this.stopped = true;
    clearTimeout(this.retry);
  };

  /**
   * One pass over the queue. It lets go of `sending` in the same step as it decides to
   * stop (no await in between), so a send() that comes after joins nothing finished; one
   * that came while it read the queue (`asked`) makes it read again.
   */
  private async drain() {
    clearTimeout(this.retry);
    try {
      await this.loaded();
      for (;;) {
        this.asked = false;
        const next = await this.store.first();
        if (this.stopped || (!next && !this.asked)) {
          this.sending = null;
          return;
        }
        if (next && !(await this.sendAndForget(next))) {
          this.sending = null;
          this.retryLater();
          return;
        }
      }
    } catch (error) {
      // The store itself failed (IndexedDB unavailable for now): shown, and tried again.
      this.sending = null;
      this.update({ error: errorCode(error) });
      this.retryLater();
    }
  }

  /**
   * What's queued, read from the store once (an earlier visit's leftovers), and again
   * after a read that failed.
   */
  private loaded() {
    this.loading ??= this.store.all().then(
      (items) => {
        this.queued = new Map(items.map((item) => [keyOf(item), durationOf(item)]));
        this.update({});
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  /**
   * Sends one item and takes it off the queue: true once it's done with (sent, or
   * refused for good), false when it's worth another try later.
   */
  private async sendAndForget(next: QueuedItem) {
    let failed: ErrorCode | null = null;
    try {
      await this.sendOne(next);
    } catch (error) {
      failed = errorCode(error);
      this.update({ error: failed });
      if (!FINAL.has(failed)) {
        return false;
      }
    }
    // The error stays shown only while it's the latest news.
    this.failures = 0;
    await this.store.remove(next);
    this.queued.delete(keyOf(next));
    this.update({ error: failed, full: false });
    return true;
  }

  private async sendOne(item: QueuedItem) {
    const recording = this.client.recording;
    if (item.kind === "part-end") {
      await recording.closePart({
        sessionId: item.sessionId,
        index: item.partIndex,
        sliceCount: item.sliceCount,
      });
      return;
    }
    const where = { sessionId: item.sessionId, partIndex: item.partIndex, index: item.index };
    const { upload } = await recording.uploadSlice({
      ...where,
      startMs: item.startMs,
      durationMs: item.durationMs,
      size: item.bytes.size,
    });
    if (upload) {
      await put(upload, item.bytes);
    }
    await recording.completeSlice(where);
  }

  private retryLater() {
    const delay = retryDelay(this.failures);
    this.failures += 1;
    this.retry = setTimeout(() => void this.send(), delay);
  }

  /** The state with `change`, its counts from what's queued, told to the listeners. */
  private update(change: Partial<Pick<UploadState, "error" | "full">>) {
    const durations = [...this.queued.values()];
    this.state = {
      ...this.state,
      ...change,
      pending: durations.length,
      behindMs: durations.reduce((sum, ms) => sum + ms, 0),
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * The shoot screen's uploader: sends what an earlier visit left queued as soon as it
 * mounts, and stops (keeping the queue) when it unmounts.
 */
export function useSliceUploader(store?: SliceStore) {
  const { client } = useApi();
  const [uploader] = useState(() => new SliceUploader(client, store ?? defaultSliceStore()));
  useEffect(() => {
    void uploader.send();
    return uploader.stop;
  }, [uploader]);
  const state = useSyncExternalStore(uploader.subscribe, uploader.snapshot, uploader.snapshot);
  return { ...state, enqueue: uploader.enqueue, send: uploader.send };
}
