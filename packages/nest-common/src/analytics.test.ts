/**
 * BigQueryAnalytics against a stand-in that speaks BigQuery's real streaming-insert
 * protocol (the same shape `tabledata.insertAll` expects), so this never reaches Google
 * or the GCE metadata server: the stand-in's `BigQuery` client carries its own, already
 * valid access token (see `client()` below).
 *
 * That token lives on an `OAuth2Client` from this package's own `google-auth-library`
 * devDependency, handed to a `BigQuery` client that authenticates through
 * `@google-cloud/common`'s copy of the same library. The two must stay on the same major
 * version (upgrade them together): across majors the SDK stops recognizing the client
 * as one of its own and goes looking for ADC, and these tests start reaching for the
 * metadata server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BigQuery } from "@google-cloud/bigquery";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it } from "vitest";
import { BigQueryAnalytics, createAnalytics } from "./analytics";

/** A stand-in for BigQuery's tabledata.insertAll endpoint. */
class FakeBigQuery {
  readonly server: Server;
  readonly listening: Promise<void>;
  readonly received: { path: string; rows: Record<string, unknown>[] }[] = [];
  status = 200;
  /** What a 200 says about rows BigQuery still refused (`insertErrors`), when set. */
  insertErrors: unknown[] | undefined;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.listening = new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      rows: { json: Record<string, unknown> }[];
    };
    this.received.push({
      path: request.url ?? "",
      rows: body.rows.map((row) => row.json),
    });
    response.writeHead(this.status, { "content-type": "application/json" });
    response.end(
      this.status === 200
        ? JSON.stringify({
            kind: "bigquery#tableDataInsertAllResponse",
            ...(this.insertErrors && { insertErrors: this.insertErrors }),
          })
        : JSON.stringify({ error: { message: "insert refused" } }),
    );
  }

  get url() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A BigQuery client pointed at the stand-in, with a token it never has to fetch. */
function client(fake: FakeBigQuery) {
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: "test-token", expiry_date: Date.now() + 3_600_000 });
  return new BigQuery({ projectId: "test-project", apiEndpoint: fake.url, authClient });
}

const servers: FakeBigQuery[] = [];
afterEach(() => Promise.all(servers.splice(0).map((server) => server.close())));

async function setup(status = 200) {
  const fake = new FakeBigQuery();
  servers.push(fake);
  await fake.listening;
  fake.status = status;
  const analytics = new BigQueryAnalytics({
    projectId: "test-project",
    dataset: "director",
    bigquery: client(fake),
  });
  return { fake, analytics };
}

describe("analytics configuration", () => {
  it("is off without a dataset", () => {
    expect(createAnalytics({})).toBeNull();
    expect(createAnalytics({ GOOGLE_CLOUD_PROJECT: "p" })).toBeNull();
  });

  it("fails at boot with a dataset but no project to write it in", () => {
    expect(() => createAnalytics({ BIGQUERY_DATASET: "director" })).toThrow(
      "GOOGLE_CLOUD_PROJECT is missing",
    );
  });
});

describe("the BigQuery client", () => {
  it("builds its own, through ADC, when no stand-in is given", () => {
    // Construction alone never reaches the network: ADC resolves lazily, on first use.
    expect(
      () => new BigQueryAnalytics({ projectId: "test-project", dataset: "director" }),
    ).not.toThrow();
  });
});

describe("recording an event", () => {
  it("streams it into the dataset's events table", async () => {
    const { fake, analytics } = await setup();
    await analytics.record({ kind: "call_started", userId: "user-1", videoId: "video-1" });
    expect(fake.received).toHaveLength(1);
    const [insert] = fake.received;
    expect(insert?.path).toBe(
      "/bigquery/v2/projects/test-project/datasets/director/tables/events/insertAll?prettyPrint=false",
    );
    const [row] = insert?.rows ?? [];
    expect(row).toMatchObject({
      kind: "call_started",
      user_id: "user-1",
      video_id: "video-1",
      template_id: null,
      score: null,
      detail: null,
    });
    expect(typeof row?.time).toBe("string");
    expect(new Date(row?.time as string).toISOString()).toBe(row?.time);
  });

  it("writes an omitted score or template as null, not dropped", async () => {
    const { fake, analytics } = await setup();
    await analytics.record({ kind: "indexed" });
    expect(fake.received[0]?.rows[0]).toMatchObject({
      user_id: null,
      template_id: null,
      video_id: null,
      score: null,
      detail: null,
    });
  });

  it("keeps a score of zero, rather than treating it as missing", async () => {
    const { fake, analytics } = await setup();
    await analytics.record({ kind: "take_reviewed", score: 0 });
    expect(fake.received[0]?.rows[0]?.score).toBe(0);
  });

  it("stores detail as the table's JSON column expects: a JSON string", async () => {
    const { fake, analytics } = await setup();
    await analytics.record({ kind: "published", detail: { platform: "shorts" } });
    expect(fake.received[0]?.rows[0]?.detail).toBe('{"platform":"shorts"}');
  });

  it("rejects when BigQuery refuses the insert, for the caller to handle", async () => {
    const { analytics } = await setup(400);
    await expect(analytics.record({ kind: "cut_saved" })).rejects.toThrow();
  });

  it("names each refused row's reason when BigQuery answers 200 but rejects rows", async () => {
    // A partial failure: the request succeeds and the response lists the rows it dropped.
    // The SDK's own error for it has an empty message, which logs as nothing useful.
    const { fake, analytics } = await setup();
    fake.insertErrors = [
      {
        index: 0,
        errors: [
          { reason: "invalid", location: "user_id", message: "no such field: user_id." },
          { reason: "stopped", location: "", message: "" },
        ],
      },
    ];
    const recorded = analytics.record({ kind: "indexed", userId: "user-secret-1" });
    await expect(recorded).rejects.toThrow(
      "BigQuery refused the event: invalid: no such field: user_id.; stopped",
    );
    // Only the reasons: never the row itself, which would carry the user's ids into logs.
    await expect(recorded).rejects.not.toThrow("user-secret-1");
    await recorded.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("cause");
    });
  });
});
