import type { WebhookEndpoint } from "@repo/contracts/api";
import { webhookEndpointIdSchema } from "@repo/contracts/ids";
import { toPage } from "@repo/contracts/pagination";
import { afterEach, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { useCreateWebhookEndpointMutation } from "./create-endpoint";
import { useDeleteWebhookEndpointMutation } from "./delete-endpoint";
import { useWebhookDeliveriesInfiniteQuery } from "./list-deliveries";
import { useWebhookEndpointsQuery } from "./list-endpoints";
import { useRedeliverWebhookMutation } from "./redeliver";
import { useRotateWebhookSecretMutation } from "./rotate-secret";
import { useSendWebhookTestMutation } from "./send-test";
import { useUpdateWebhookEndpointMutation } from "./update-endpoint";

afterEach(() => {
  vi.useRealTimers();
});

describe("webhook endpoints", () => {
  it("adds, changes, re-keys, tests and deletes an endpoint; the list follows", async () => {
    let endpoints: WebhookEndpoint[] = [];
    const tests: string[] = [];
    const api = standIn((os) => ({
      webhooks: {
        listEndpoints: os.webhooks.listEndpoints.handler(() => endpoints),
        createEndpoint: os.webhooks.createEndpoint.handler(({ input }) => {
          const endpoint: WebhookEndpoint = {
            id: webhookEndpointIdSchema.parse(id(1)),
            url: input.url,
            description: input.description ?? "",
            events: input.events ?? [],
            createdAt: new Date(0),
            disabledAt: null,
            disabledReason: null,
          };
          endpoints = [endpoint];
          return { endpoint, secret: "whsec_first" };
        }),
        updateEndpoint: os.webhooks.updateEndpoint.handler(({ input }) => {
          const [endpoint] = endpoints as [WebhookEndpoint];
          Object.assign(endpoint, { url: input.url ?? endpoint.url });
          return endpoint;
        }),
        rotateSecret: os.webhooks.rotateSecret.handler(() => ({ secret: "whsec_second" })),
        sendTest: os.webhooks.sendTest.handler(({ input }) => {
          tests.push(input.id);
        }),
        deleteEndpoint: os.webhooks.deleteEndpoint.handler(() => {
          endpoints = [];
        }),
      },
    }));
    const { result } = renderHook(
      () => ({
        endpoints: useWebhookEndpointsQuery(),
        create: useCreateWebhookEndpointMutation(),
        update: useUpdateWebhookEndpointMutation(),
        rotate: useRotateWebhookSecretMutation(),
        test: useSendWebhookTestMutation(),
        remove: useDeleteWebhookEndpointMutation(),
      }),
      api,
    );
    const urls = () => result.current.endpoints.data?.map((e) => e.url);
    await vi.waitFor(() => expect(urls()).toEqual([]));

    const created = await result.current.create.mutateAsync({ url: "https://hooks.test/a" });
    expect(created.secret).toBe("whsec_first");
    await vi.waitFor(() => expect(urls()).toEqual(["https://hooks.test/a"]));

    await result.current.update.mutateAsync({ id: id(1), url: "https://hooks.test/b" });
    await vi.waitFor(() => expect(urls()).toEqual(["https://hooks.test/b"]));

    await expect(result.current.rotate.mutateAsync({ id: id(1) })).resolves.toEqual({
      secret: "whsec_second",
    });
    await result.current.test.mutateAsync({ id: id(1) });
    expect(tests).toEqual([id(1)]);

    await result.current.remove.mutateAsync({ id: id(1) });
    await vi.waitFor(() => expect(urls()).toEqual([]));
  });
});

describe("webhook deliveries", () => {
  const delivery = (n: number, status: "pending" | "succeeded" | "failed") => ({
    id: id(n),
    eventName: "todo.created.v1",
    status,
    attempts: 1,
    lastStatus: status === "pending" ? null : 200,
    lastError: null,
    lastAttemptAt: null,
    createdAt: new Date(n),
  });

  it("pages through an endpoint's deliveries, and redelivering refetches them", async () => {
    const deliveries = [delivery(3, "failed"), delivery(2, "succeeded"), delivery(1, "succeeded")];
    const api = standIn((os) => ({
      webhooks: {
        listDeliveries: os.webhooks.listDeliveries.handler(({ input }) => {
          const start = input.cursor ? deliveries.findIndex((d) => d.id === input.cursor) + 1 : 0;
          return toPage(deliveries.slice(start), input.limit);
        }),
        redeliver: os.webhooks.redeliver.handler(({ input }) => {
          const found = deliveries.find((d) => d.id === input.id);
          if (found) {
            found.status = "succeeded";
          }
        }),
      },
    }));
    const { result } = renderHook(
      () => ({
        deliveries: useWebhookDeliveriesInfiniteQuery(id(50), 2),
        redeliver: useRedeliverWebhookMutation(),
      }),
      api,
    );
    const statuses = () =>
      result.current.deliveries.data?.pages.flatMap((p) => p.items.map((d) => d.status));
    await vi.waitFor(() => expect(statuses()).toEqual(["failed", "succeeded"]));
    await result.current.deliveries.fetchNextPage();
    await vi.waitFor(() => expect(statuses()).toEqual(["failed", "succeeded", "succeeded"]));
    expect(result.current.deliveries.hasNextPage).toBe(false);

    await result.current.redeliver.mutateAsync({ id: id(3) });
    await vi.waitFor(() => expect(statuses()).toEqual(["succeeded", "succeeded", "succeeded"]));
  });

  it("is polled while a delivery is pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let looks = 0;
    const limits: number[] = [];
    const api = standIn((os) => ({
      webhooks: {
        listDeliveries: os.webhooks.listDeliveries.handler(({ input }) => {
          limits.push(input.limit);
          return { items: [delivery(1, ++looks < 3 ? "pending" : "succeeded")], nextCursor: null };
        }),
      },
    }));
    const { result } = renderHook(() => useWebhookDeliveriesInfiniteQuery(id(50)), api);
    await until(() => expect(looks).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => expect(looks).toBe(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => expect(result.current.data?.pages[0]?.items[0]?.status).toBe("succeeded"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(looks).toBe(3);
    expect(limits[0]).toBe(20);
  });
});
