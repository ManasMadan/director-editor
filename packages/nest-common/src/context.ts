/**
 * Request context: who is acting, for which organization, in which language, under
 * which request id. Available anywhere in the call chain without passing it around,
 * and stamped on every log line.
 *
 *   await runWithContext({ requestId }, () => handle(request));   // HTTP entry points
 *   await runWithContext(job.data.meta, () => process(job));        // queue workers
 *   currentContext()?.orgId                                         // anywhere below
 *
 * Built on Node's AsyncLocalStorage, so it follows awaits, timers and promise chains.
 * Producers copy it into job metadata and outbox rows, which is how one request id
 * traces through api → queue → worker → email.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  userId?: string | undefined;
  orgId?: string | undefined;
  locale?: string | undefined;
  timeZone?: string | undefined;
  /** App version sent by web/mobile clients (x-app-version). */
  clientVersion?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/**
 * Runs a job's work in the request context it was queued from (its `meta`), so its logs
 * carry that request's id. `fallback` names the work when no request queued it: the
 * event's id, or `job:<id>`.
 */
export function runJob<T>(
  meta: Omit<RequestContext, "requestId"> & { requestId?: string },
  fallback: string,
  fn: () => T,
): T {
  return runWithContext({ ...meta, requestId: meta.requestId ?? fallback }, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The request's ids to copy onto a job it queues (a job's `meta`), so the job's logs
 * carry the same request id as the HTTP request that asked for it.
 */
export function jobMetaFromContext() {
  const context = currentContext();
  return {
    ...(context?.requestId && { requestId: context.requestId }),
    ...(context?.userId && { userId: context.userId }),
  };
}

/** Adds what is learned mid-request (e.g. the user, once the session is resolved). */
export function updateContext(patch: Partial<Omit<RequestContext, "requestId">>) {
  const context = storage.getStore();
  if (context) {
    Object.assign(context, patch);
  }
}

/** Fields safe to attach to every log line (ids only, never personal data). */
export function contextLogFields() {
  const context = storage.getStore();
  if (!context) {
    return {};
  }
  const { requestId, userId, orgId } = context;
  return { requestId, ...(userId && { userId }), ...(orgId && { orgId }) };
}
