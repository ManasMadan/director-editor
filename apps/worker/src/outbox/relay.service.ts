/**
 * The outbox relay: moves committed events from every service's outbox to the EventBus.
 *
 * Each pass claims up to RELAY_BATCH_SIZE unpublished rows with FOR UPDATE SKIP LOCKED,
 * publishes them, stamps published_at and commits. Any number of worker replicas can run
 * it at once: SKIP LOCKED gives each a different batch, so there's no leader to elect.
 * A crash after publishing but before the commit republishes the batch on the next pass;
 * the EventBus dedupes on the event id, so consumers still see each event once while its
 * job is kept (and are idempotent beyond that).
 *
 * It wakes on NOTIFY (sent by emitEvent when a transaction commits) through a direct,
 * non-pooled connection, and also polls every RELAY_POLL_INTERVAL_MS, so a lost
 * notification or a dropped listener only delays events, never loses them.
 *
 * Publishing happens inside the claiming transaction on purpose: the row locks are what
 * keep two relays from publishing the same batch. The transaction is short (one batch,
 * one Redis round trip) and has a timeout.
 *
 * At scale this is the OutboxSource seam: change data capture (logical replication or
 * Debezium reading the outbox tables) can replace polling and feed the same EventBus;
 * emitEvent and every consumer stay as they are.
 */

import { Socket } from "node:net";
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { eventEnvelope } from "@repo/contracts/events";
import { Prisma } from "@repo/db";
import {
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  PinoLogger,
  rows,
} from "@repo/nest-common";
import pg from "pg";
import * as z from "zod";
import { env } from "../env";
import { EventBus } from "./event-bus";
import { OUTBOX_SOURCES, type OutboxSource } from "./sources";

/**
 * An outbox row's columns. Parsed, so a migration that renames or retypes one fails here;
 * whether the row is a valid event is checked after (eventEnvelope), one row at a time.
 */
const outboxRow = z.object({
  id: z.string(),
  /** Possibly an event this build doesn't know yet (see eventEnvelope). */
  name: z.string(),
  key: z.string(),
  payload: z.unknown(),
  org_id: z.string().nullable(),
  actor_id: z.string().nullable(),
  request_id: z.string().nullable(),
  occurred_at: z.date(),
});
type OutboxRow = z.infer<typeof outboxRow>;

/** Between 1 and 3 seconds: replicas that lost the database together don't return together. */
const reconnectDelayMs = () => 1_000 + Math.random() * 2_000;

/** Ends a listener connection, which may be gone already (its error then says nothing new). */
async function closeQuietly(client: pg.Client | undefined) {
  try {
    await client?.end();
  } catch {
    // Already closed.
  }
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private listener: pg.Client | undefined;
  private poller: NodeJS.Timeout | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  /** The listener connection being made, and how to abandon it. */
  private connecting: { done: Promise<void>; cancel: () => void } | undefined;
  private draining: Promise<void> | undefined;
  private rerun = false;
  private stopped = false;

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly bus: EventBus,
    @InjectPinoLogger(OutboxRelay.name) private readonly log: PinoLogger,
  ) {}

  async onApplicationBootstrap() {
    // Polling starts first, so a shutdown while the listener connects stops it too.
    this.poller = setInterval(() => this.kick(), env.RELAY_POLL_INTERVAL_MS);
    await this.listen();
    this.kick();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.poller);
    clearTimeout(this.reconnect);
    // A connection still being made (at startup, or reconnecting) is dropped, not left
    // to finish and listen after the relay has stopped.
    this.connecting?.cancel();
    await this.connecting?.done;
    await closeQuietly(this.listener);
    // Let the batch in flight commit, so it isn't republished by the next replica.
    await this.draining;
  }

  /** Starts a drain, or asks the running one to go round again. Never runs two at once. */
  kick() {
    if (this.stopped) {
      return;
    }
    if (this.draining !== undefined) {
      this.rerun = true;
      return;
    }
    this.draining = this.drainAll().finally(() => {
      this.draining = undefined;
    });
  }

  /** Drains every source until nothing is left. Errors are logged; the next poll retries. */
  private async drainAll() {
    do {
      this.rerun = false;
      for (const source of OUTBOX_SOURCES) {
        try {
          let moved: number;
          do {
            moved = await this.drainBatch(source);
          } while (moved === env.RELAY_BATCH_SIZE && !this.stopped);
        } catch (error) {
          this.log.error({ err: error, source }, "outbox relay pass failed; retrying on next poll");
        }
      }
    } while (this.rerun && !this.stopped);
  }

  /** Publishes one batch from one source; returns how many events it moved. */
  async drainBatch(source: OutboxSource): Promise<number> {
    // The table name comes from the static source list, never from input.
    const table = Prisma.raw(`"${source}"."outbox_event"`);
    return this.database.write.$transaction(
      async (tx) => {
        const claimed = await rows(
          outboxRow,
          tx.$queryRaw`
            SELECT id, name, key, payload, org_id, actor_id, request_id, occurred_at
            FROM ${table}
            WHERE published_at IS NULL
            ORDER BY occurred_at
            LIMIT ${env.RELAY_BATCH_SIZE}
            FOR UPDATE SKIP LOCKED`,
        );
        if (claimed.length === 0) {
          return 0;
        }
        // A row that isn't a valid event never will be: publishing it would fail this
        // batch, and every batch after it, forever. It's logged and set aside (marked
        // published, so it stays in the table until retention, for someone to look at).
        const envelopes = claimed.map((row) => ({
          row,
          parsed: eventEnvelope.safeParse(toEnvelope(row, source)),
        }));
        for (const { row, parsed } of envelopes) {
          if (!parsed.success) {
            this.log.error(
              { source, eventId: row.id, name: row.name, issues: parsed.error.issues },
              "outbox row isn't a valid event; set aside",
            );
          }
        }
        await this.bus.publish(
          envelopes.flatMap(({ parsed }) => (parsed.success ? [parsed.data] : [])),
        );
        await tx.$executeRaw`
          UPDATE ${table} SET published_at = now()
          WHERE id = ANY(${claimed.map((row) => row.id)}::uuid[])`;
        return claimed.length;
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }

  private listen() {
    // The relay's own socket: pg can't end a connection it's still making, and waits for
    // an answer that may never come, but destroying the socket fails the connect at once.
    const socket = new Socket();
    const client = new pg.Client({
      connectionString: env.WORKER_DATABASE_DIRECT_URL,
      application_name: "worker-outbox-listener",
      stream: () => socket,
    });
    client.on("notification", () => this.kick());
    client.on("error", (error) => {
      this.log.warn({ err: error }, "outbox listener lost its connection; reconnecting");
      this.scheduleReconnect();
    });
    const done = this.connect(client).finally(() => {
      this.connecting = undefined;
    });
    this.connecting = { done, cancel: () => socket.destroy() };
    return done;
  }

  private async connect(client: pg.Client) {
    try {
      await client.connect();
      await client.query("LISTEN outbox");
      this.listener = client;
    } catch (error) {
      if (!this.stopped) {
        this.log.warn({ err: error }, "outbox listener could not connect; polling meanwhile");
      }
      await closeQuietly(client);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnect) {
      return;
    }
    const previous = this.listener;
    this.listener = undefined;
    void closeQuietly(previous);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.listen();
    }, reconnectDelayMs());
  }
}

/** The envelope a row would be, still to be checked against the contract (drainBatch). */
function toEnvelope(row: OutboxRow, source: OutboxSource): z.input<typeof eventEnvelope> {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    payload: row.payload,
    orgId: row.org_id,
    actorId: row.actor_id,
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
    source,
  };
}
