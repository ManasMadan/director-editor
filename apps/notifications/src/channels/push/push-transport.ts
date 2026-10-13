/**
 * Push providers behind one interface: FCM (Android), APNs (iOS) and Web Push
 * (browsers). Each platform is on when its configuration is present (env.ts). To add a
 * provider (OneSignal, Expo push), implement `PushTransport` and register it for its
 * platform in push.module.ts; the channel and dispatcher don't change.
 */
export type PushPlatform = "ios" | "android" | "web";

export interface PushMessage {
  title: string;
  body: string;
  /** A path on the web app; apps deep-link to it when the notification is opened. */
  link?: string | undefined;
  /** Groups notifications of one kind (e.g. the template name) on the device. */
  collapseKey?: string | undefined;
}

export type PushResult =
  | { ok: true; providerMessageId?: string }
  /** `gone`: the token is dead (app uninstalled, subscription expired): forget it. */
  | { ok: false; gone: boolean; error: string };

export interface PushTransport {
  send(token: string, message: PushMessage): Promise<PushResult>;
  /** Closes what it holds open (APNs keeps an HTTP/2 session), at shutdown. */
  close?(): void | Promise<void>;
}

export const PUSH_TRANSPORTS = Symbol("PUSH_TRANSPORTS");
export type PushTransports = Partial<Record<PushPlatform, PushTransport>>;
