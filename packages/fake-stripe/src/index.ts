/**
 * A local, stateful stand-in for the parts of Stripe the app uses: customers, Checkout,
 * the billing portal, subscriptions, invoices and the cards subscriptions are paid with.
 * It keeps state between calls (unlike stripe-mock), checks the secret key, honours
 * Idempotency-Key (refusing a key reused for other parameters), and sends signed webhooks
 * to apps/webhooks exactly like Stripe does, so billing can be tested end to end, in
 * integration tests and in the browser.
 *
 * Hosted pages: `/checkout/<session>` (pay, pay with a declined card, or go back; a
 * posted `card` names the card, so a test can pay twice with the same one) and
 * `/portal/<session>` (cancel or resume the plan, then return). Test hooks under
 * `/__fake/` make a renewal fail, a subscription lapse, or add an invoice in any status.
 *
 * Only what the app calls is implemented; anything else answers 404 like an unknown
 * Stripe route, so a new Stripe call fails loudly in tests until it's added here.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fieldOf, required } from "@repo/contracts/objects";
import { DAY_S } from "@repo/contracts/time";
import Stripe from "stripe";
import * as z from "zod";

export interface FakeStripeOptions {
  secretKey: string;
  /** Where to send events (apps/webhooks' /webhooks/stripe), and the signing secret. */
  webhookUrl: string;
  webhookSecret: string;
  /** Price ids the app may use: their interval and unit amount (cents). */
  prices: Record<string, { interval: "month" | "year"; unitAmount: number }>;
  port?: number;
}

type Form = Record<string, unknown>;

// The fake's objects hold only what the app reads. Each field it shares with Stripe's own
// types takes its type from them, so a field Stripe renames or retypes in an SDK upgrade
// fails to compile here instead of the fake quietly answering the old shape.
interface Subscription
  extends Pick<
    Stripe.Subscription,
    | "id"
    | "object"
    | "metadata"
    | "cancel_at_period_end"
    | "trial_end"
    | "canceled_at"
    | "created"
    | "default_payment_method"
  > {
  customer: string;
  status: Stripe.Subscription.Status;
  // The app's subscriptions have one item: the seats.
  items: { object: "list"; data: [SubscriptionItem] };
}

interface SubscriptionItem
  extends Pick<
    Stripe.SubscriptionItem,
    "id" | "object" | "current_period_start" | "current_period_end"
  > {
  // Optional and nullable in Stripe's types; the fake always sets them.
  quantity: number;
  price: Pick<Stripe.Price, "id" | "object"> & {
    unit_amount: number;
    recurring: Pick<Stripe.Price.Recurring, "interval">;
  };
}

interface Invoice
  extends Pick<
    Stripe.Invoice,
    "id" | "object" | "number" | "amount_due" | "created" | "hosted_invoice_url"
  > {
  customer: string;
  /** Where this API version puts an invoice's subscription. */
  parent: {
    type: Stripe.Invoice.Parent["type"];
    subscription_details: { subscription: string };
  };
  /**
   * A draft has no number or hosted page until it's finalized. Any status: tests set ones
   * Stripe doesn't document, as a newer API version could.
   */
  status: string;
  currency: "usd";
}

/**
 * How a subscription is paid, as far as the app reads it: a card, whose fingerprint is the
 * same for every use of it, or a SEPA debit, which has no card.
 */
interface PaymentMethod extends Pick<Stripe.PaymentMethod, "id" | "object"> {
  type: "card" | "sepa_debit";
  card?: { fingerprint: string; last4: string };
}

const now = () => Math.floor(Date.now() / 1000);
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

/** A form, or a nested part of one (`metadata[a]`, `line_items[0]`): an object or an array. */
type FormPart = Form | unknown[];
const isFormPart = (value: unknown): value is FormPart =>
  typeof value === "object" && value !== null;
const fieldIn = (node: FormPart, name: string) =>
  Array.isArray(node) ? node[Number(name)] : node[name];

/** Stripe's form encoding (`a[b][0][c]=x`) into nested objects and arrays. */
export function parseForm(body: string): Form {
  const root: Form = {};
  for (const [key, value] of new URLSearchParams(body)) {
    let node: FormPart = root;
    let name = "";
    for (const [index, part] of key.replaceAll("]", "").split("[").entries()) {
      // Each part after the first is a field of the one before: an array's when it's a number.
      if (index > 0) {
        const inner = fieldIn(node, name);
        node = isFormPart(inner) ? inner : setField(node, name, /^\d+$/.test(part) ? [] : {});
      }
      name = part;
    }
    setField(node, name, value);
  }
  return root;
}

/** Sets a field of a form part; the value set. */
function setField<V>(node: FormPart, name: string, value: V): V {
  if (Array.isArray(node)) {
    node[Number(name)] = value;
  } else {
    node[name] = value;
  }
  return value;
}

// The parts of a form the fake reads. It stays as lenient as it always was: a field the
// app always sends is checked where it's used, so a test can leave out what it doesn't need.
const metadata = z.record(z.string(), z.string());
const subscriptionData = z.object({
  metadata: metadata.optional(),
  trial_period_days: z.string().optional(),
});
const lineItems = z.array(z.object({ id: z.string(), quantity: z.string().optional() }));
const withFirstLine = z.object({
  line_items: z.tuple(
    [z.object({ price: z.string(), quantity: z.string().optional() })],
    z.unknown(),
  ),
});

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto"><h1>${title}</h1>${body}</body></html>`;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

/**
 * An API handler's result as a response: nothing is Stripe's 404, a `{ status, body }` is
 * sent as it is, and anything else is a 200 with it as the body.
 */
function answerFor(result: unknown): { status: number; body: unknown } {
  if (result === undefined) {
    return {
      status: 404,
      body: { error: { type: "invalid_request_error", message: "Unrecognized request URL" } },
    };
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "body" in result &&
    typeof result.status === "number"
  ) {
    return { status: result.status, body: result.body };
  }
  return { status: 200, body: result };
}

const notFound = (what: string) => ({
  status: 404,
  body: { error: { type: "invalid_request_error", message: `No such ${what}` } },
});

type Customer = { id: string; object: "customer"; metadata: Record<string, string> };
type CheckoutSession = Form & { id: string; customer: string };

/** A Stripe API route: the method, the path, and what it answers (undefined is a 404). */
type Route = [
  method: string,
  path: RegExp,
  handle: (match: RegExpExecArray, form: Form, query: URLSearchParams, method: string) => unknown,
];

/** Everything the fake remembers between calls, and what it does with it. */
class Fake {
  readonly customers = new Map<string, Customer>();
  readonly sessions = new Map<string, CheckoutSession>();
  readonly portals = new Map<string, { customer: string; return_url: unknown }>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly invoices: Invoice[] = [];
  readonly paymentMethods = new Map<string, PaymentMethod>();
  /** Each key's answer, and the request body it answered (a key is for one request). */
  readonly idempotent = new Map<string, { request: string; status: number; body: unknown }>();
  readonly events: { type: string; object: unknown }[] = [];
  baseUrl = "";

  constructor(private readonly options: FakeStripeOptions) {}

  /** Sends a signed event to the webhook endpoint, as Stripe does. */
  async emit(type: string, object: unknown) {
    this.events.push({ type, object });
    const payload = JSON.stringify({
      id: id("evt"),
      object: "event",
      api_version: Stripe.API_VERSION,
      created: now(),
      livemode: false,
      type,
      data: { object },
    });
    // Async: under Bun the SDK signs with SubtleCrypto, which has no synchronous API.
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: this.options.webhookSecret,
    });
    const response = await fetch(this.options.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });
    if (!response.ok) {
      throw new Error(`webhook ${type} was refused: ${response.status}`);
    }
  }

  invoiceFor(subscription: Subscription, status: string) {
    const [item] = subscription.items.data;
    const draft = status === "draft";
    const invoice: Invoice = {
      id: id("in"),
      object: "invoice",
      customer: subscription.customer,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: subscription.id },
      },
      number: draft ? null : `FAKE-${String(this.invoices.length + 1).padStart(4, "0")}`,
      status,
      amount_due: subscription.status === "trialing" ? 0 : item.price.unit_amount * item.quantity,
      currency: "usd",
      created: now(),
      hosted_invoice_url: draft ? null : `${this.baseUrl}/invoices/${this.invoices.length + 1}`,
    };
    this.invoices.push(invoice);
    return invoice;
  }

  /** The subscription a completed Checkout session starts. */
  subscribe(session: CheckoutSession, paymentMethod: string | null) {
    const [line] = withFirstLine.parse(session).line_items;
    const price = this.options.prices[line.price];
    if (!price) {
      throw new Error(`unknown price ${line.price}`);
    }
    const data = subscriptionData.parse(session.subscription_data ?? {});
    const trialDays = Number(data.trial_period_days ?? 0);
    const start = now();
    const item: SubscriptionItem = {
      id: id("si"),
      object: "subscription_item",
      quantity: Number(line.quantity ?? 1),
      current_period_start: start,
      current_period_end: start + (price.interval === "month" ? 30 : 365) * DAY_S,
      price: {
        id: line.price,
        object: "price",
        recurring: { interval: price.interval },
        unit_amount: price.unitAmount,
      },
    };
    const subscription: Subscription = {
      id: id("sub"),
      object: "subscription",
      customer: session.customer,
      status: trialDays > 0 ? "trialing" : "active",
      metadata: data.metadata ?? {},
      cancel_at_period_end: false,
      trial_end: trialDays > 0 ? start + trialDays * DAY_S : null,
      canceled_at: null,
      created: start,
      default_payment_method: paymentMethod,
      items: { object: "list", data: [item] },
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  /**
   * The payment method a completed checkout saves on its subscription. `card` names the card
   * (any value but "declined"): the same name is the same card, so the same fingerprint;
   * `method=sepa_debit` pays without one. A trial with `payment_method_collection:
   * "if_required"` takes none, as Stripe's does.
   */
  takeCard(session: CheckoutSession, form: Form) {
    const trial = subscriptionData.optional().parse(session.subscription_data)?.trial_period_days;
    if (session.payment_method_collection === "if_required" && trial) {
      return null;
    }
    const card = typeof form.card === "string" ? form.card : "4242";
    const paymentMethod: PaymentMethod =
      form.method === "sepa_debit"
        ? { id: id("pm"), object: "payment_method", type: "sepa_debit" }
        : {
            id: id("pm"),
            object: "payment_method",
            type: "card",
            card: { fingerprint: `fp_${card}`, last4: card.slice(-4).padStart(4, "0") },
          };
    this.paymentMethods.set(paymentMethod.id, paymentMethod);
    return paymentMethod.id;
  }

  /** The API routes the app calls. */
  private readonly routes: Route[] = [
    ["POST", /^\/v1\/customers$/, (_, form) => this.createCustomer(form)],
    ["POST", /^\/v1\/checkout\/sessions$/, (_, form) => this.createCheckout(form)],
    ["GET", /^\/v1\/checkout\/sessions\/(cs_\w+)$/, ([, cs]) => this.checkout(cs)],
    ["GET", /^\/v1\/payment_methods\/(pm_\w+)$/, ([, pm]) => this.paymentMethod(pm)],
    ["POST", /^\/v1\/checkout\/sessions\/(cs_\w+)\/expire$/, ([, cs]) => this.expire(cs)],
    ["POST", /^\/v1\/billing_portal\/sessions$/, (_, form) => this.createPortal(form)],
    [
      "*",
      /^\/v1\/subscriptions\/(sub_\w+)$/,
      ([, sub], form, _, method) => this.subscription(method, sub, form),
    ],
    ["GET", /^\/v1\/subscriptions$/, (_, __, query) => this.listSubscriptions(query)],
    ["GET", /^\/v1\/invoices$/, (_, __, query) => this.listInvoices(query)],
  ];

  /** What an API call answers: its route's result, or undefined when there's no route. */
  api(method: string, path: string, form: Form, query: URLSearchParams) {
    for (const [routeMethod, pattern, handle] of this.routes) {
      const match = pattern.exec(path);
      if (match && (routeMethod === "*" || method === routeMethod)) {
        return handle(match, form, query, method);
      }
    }
    return undefined;
  }

  private createCustomer(form: Form) {
    const customer: Customer = {
      id: id("cus"),
      object: "customer",
      metadata: metadata.parse(form.metadata ?? {}),
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  private createCheckout(form: Form) {
    const { customer } = form;
    if (typeof customer !== "string" || !this.customers.has(customer)) {
      return notFound("customer");
    }
    const session = { ...form, customer, id: id("cs"), object: "checkout.session", status: "open" };
    this.sessions.set(session.id, session);
    return { ...session, url: `${this.baseUrl}/checkout/${session.id}` };
  }

  private paymentMethod(paymentMethodId = "") {
    return this.paymentMethods.get(paymentMethodId) ?? notFound("payment method");
  }

  private checkout(sessionId = "") {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return notFound("checkout session");
    }
    return { ...session, url: `${this.baseUrl}/checkout/${session.id}` };
  }

  private expire(sessionId = "") {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return notFound("checkout session");
    }
    if (session.status !== "open") {
      return {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            message: "Only Checkout Sessions with a status of open can be expired.",
          },
        },
      };
    }
    session.status = "expired";
    return session;
  }

  private createPortal(form: Form) {
    const { customer } = form;
    if (typeof customer !== "string" || !this.customers.has(customer)) {
      return notFound("customer");
    }
    const portal = id("bps");
    this.portals.set(portal, { customer, return_url: form.return_url });
    return {
      id: portal,
      object: "billing_portal.session",
      url: `${this.baseUrl}/portal/${portal}`,
    };
  }

  /** A subscription: read it, cancel it now (DELETE) or change it (POST). */
  private subscription(method: string, subscriptionId = "", form: Form) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return notFound("subscription");
    }
    if (method === "GET") {
      return subscription;
    }
    if (method === "DELETE") {
      return this.cancel(subscription);
    }
    if (method === "POST") {
      return this.update(subscription, form);
    }
    return undefined;
  }

  private async cancel(subscription: Subscription) {
    subscription.status = "canceled";
    subscription.canceled_at = now();
    await this.emit("customer.subscription.deleted", subscription);
    return subscription;
  }

  private async update(subscription: Subscription, form: Form) {
    for (const change of lineItems.parse(form.items ?? [])) {
      const item = subscription.items.data.find((existing) => existing.id === change.id);
      if (!item) {
        return notFound("subscription item");
      }
      if (change.quantity !== undefined) {
        item.quantity = Number(change.quantity);
      }
    }
    if (form.cancel_at_period_end !== undefined) {
      subscription.cancel_at_period_end = form.cancel_at_period_end === "true";
    }
    // Ending a trial now charges the card at once, as Stripe does.
    if (form.trial_end === "now" && subscription.status === "trialing") {
      subscription.status = "active";
      subscription.trial_end = now();
      this.invoiceFor(subscription, "paid");
    }
    await this.emit("customer.subscription.updated", subscription);
    return subscription;
  }

  private listSubscriptions(query: URLSearchParams) {
    const data = [...this.subscriptions.values()].filter(
      (s) => s.customer === query.get("customer"),
    );
    return { object: "list", data, has_more: false };
  }

  private listInvoices(query: URLSearchParams) {
    const data = this.invoices
      .filter((invoice) => invoice.customer === query.get("customer"))
      .reverse()
      .slice(0, Number(query.get("limit") ?? 10));
    return { object: "list", data, has_more: false };
  }

  /** The hosted pages: Checkout and the billing portal. */
  async hosted(method: string, path: string, form: Form): Promise<Page> {
    const checkout = /^\/checkout\/(cs_\w+)(\/pay)?$/.exec(path);
    if (checkout) {
      return this.checkoutPage(method, checkout[1], !!checkout[2], form);
    }
    const portal = /^\/portal\/(bps_\w+)(\/cancel|\/resume)?$/.exec(path);
    if (portal) {
      return this.portalPage(method, portal[1], portal[2]);
    }
    return { status: 404, html: page("Not found", "") };
  }

  // The page's path always has the session's id (the regex requires it).
  private async checkoutPage(method: string, sessionId = "", pay: boolean, form: Form) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 404, html: page("Not found", "") };
    }
    if (session.status === "expired") {
      return {
        status: 410,
        html: page("Fake Stripe Checkout", "<p>This checkout session has expired.</p>"),
      };
    }
    if (method === "POST" && pay) {
      return this.pay(session, form);
    }
    const line = withFirstLine.safeParse(session).data?.line_items[0];
    const price = this.options.prices[line?.price ?? ""];
    return {
      status: 200,
      html: page(
        "Fake Stripe Checkout",
        `<p>${line?.quantity ?? 1} × ${((price?.unitAmount ?? 0) / 100).toFixed(2)} USD / ${price?.interval}</p>` +
          `<form method="post" action="/checkout/${session.id}/pay"><button>Pay</button></form>` +
          `<form method="post" action="/checkout/${session.id}/pay"><input type="hidden" name="card" value="declined"><button>Pay with a declined card</button></form>` +
          `<a href="${escapeHtml(z.string().parse(session.cancel_url))}">Back</a>`,
      ),
    };
  }

  /** Paying on the Checkout page: declined, or the subscription starts and is invoiced. */
  private async pay(session: CheckoutSession, form: Form): Promise<Page> {
    if (form.card === "declined") {
      return {
        status: 402,
        html: page(
          "Fake Stripe Checkout",
          `<p role="alert">Your card was declined.</p><a href="${escapeHtml(`/checkout/${session.id}`)}">Try again</a>`,
        ),
      };
    }
    const successUrl = z.string().parse(session.success_url);
    if (session.status !== "open") {
      return { status: 303, location: successUrl };
    }
    session.status = "complete";
    const subscription = this.subscribe(session, this.takeCard(session, form));
    this.invoiceFor(subscription, "paid");
    await this.emit("checkout.session.completed", { ...session, subscription: subscription.id });
    await this.emit("customer.subscription.created", subscription);
    return {
      status: 303,
      location: successUrl.replace("{CHECKOUT_SESSION_ID}", session.id),
    };
  }

  private async portalPage(method: string, portalId = "", action: string | undefined) {
    const session = this.portals.get(portalId);
    if (!session) {
      return { status: 404, html: page("Not found", "") };
    }
    const subscription = [...this.subscriptions.values()].find(
      (s) => s.customer === session.customer && s.status !== "canceled",
    );
    if (method === "POST" && action && subscription) {
      subscription.cancel_at_period_end = action === "/cancel";
      await this.emit("customer.subscription.updated", subscription);
      return { status: 303, location: `/portal/${portalId}` };
    }
    return {
      status: 200,
      html: page(
        "Fake Stripe Billing Portal",
        `${planState(portalId, subscription)}<a href="${escapeHtml(z.string().parse(session.return_url))}">Return</a>`,
      ),
    };
  }

  /**
   * Test hooks: things only time or a bank would do, and invoices in any status
   * (`/invoice?status=draft`), as Stripe's dashboard can leave them.
   */
  async hooks(path: string, query: URLSearchParams) {
    if (path === "/__fake/state") {
      return { subscriptions: [...this.subscriptions.values()], events: this.events };
    }
    const failed = /^\/__fake\/subscriptions\/(sub_\w+)\/payment-failed$/.exec(path);
    const lapsed = /^\/__fake\/subscriptions\/(sub_\w+)\/lapse$/.exec(path);
    // An invoice in any status (`?status=draft`: the next renewal's, as Stripe drafts it
    // an hour before it's due), without an event, as Stripe's dashboard can leave one.
    const invoice = /^\/__fake\/subscriptions\/(sub_\w+)\/invoice$/.exec(path);
    const subscription = this.subscriptions.get((failed ?? lapsed ?? invoice)?.[1] ?? "");
    if (!subscription) {
      return undefined;
    }
    if (invoice) {
      return this.invoiceFor(subscription, String(query.get("status")));
    }
    if (failed) {
      subscription.status = "past_due";
      const open = this.invoiceFor(subscription, "open");
      await this.emit("invoice.payment_failed", { ...open, attempt_count: 1 });
      await this.emit("customer.subscription.updated", subscription);
    } else {
      subscription.status = "canceled";
      subscription.canceled_at = now();
      await this.emit("customer.subscription.deleted", subscription);
    }
    return subscription;
  }

  /**
   * An API call: the key checked, and an Idempotency-Key's first answer replayed, or
   * refused for a different request, as Stripe does.
   */
  async answerApi(request: IncomingMessage, url: URL, form: Form, raw: string) {
    if (request.headers.authorization !== `Bearer ${this.options.secretKey}`) {
      return {
        status: 401,
        body: { error: { type: "invalid_request_error", message: "Invalid API Key" } },
      };
    }
    // A server's requests always have a method.
    const method = required(request.method, "the request's method");
    const key = request.headers["idempotency-key"];
    const cacheKey = typeof key === "string" ? `${method} ${url.pathname} ${key}` : null;
    const cached = cacheKey ? this.idempotent.get(cacheKey) : undefined;
    if (cached && cached.request !== raw) {
      return {
        status: 400,
        body: {
          error: {
            type: "idempotency_error",
            message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
          },
        },
      };
    }
    if (cached) {
      return cached;
    }
    const answer = answerFor(await this.api(method, url.pathname, form, url.searchParams));
    if (cacheKey && method === "POST") {
      this.idempotent.set(cacheKey, { request: raw, ...answer });
    }
    return answer;
  }

  /** Every request: the API, the test hooks, or a hosted page. */
  async handle(request: IncomingMessage, response: ServerResponse) {
    // A server's requests always have a URL and a method.
    const url = new URL(required(request.url, "the request's URL"), "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    const form = parseForm(raw);
    try {
      if (url.pathname.startsWith("/v1/")) {
        const { status, body } = await this.answerApi(request, url, form, raw);
        return json(response, status, body);
      }
      if (url.pathname.startsWith("/__fake/")) {
        const result = await this.hooks(url.pathname, url.searchParams);
        return result ? json(response, 200, result) : json(response, 404, { error: "not found" });
      }
      send(
        response,
        await this.hosted(required(request.method, "the request's method"), url.pathname, form),
      );
    } catch (error) {
      json(response, 500, { error: { type: "api_error", message: fieldOf(error, "message") } });
    }
  }
}

/** A hosted page's answer: HTML, or a redirect. */
type Page = { status: number; html?: string; location?: string };

function send(response: ServerResponse, { status, html, location }: Page) {
  if (location) {
    response.writeHead(status, { location });
  } else {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  }
  response.end(html);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The portal's plan line, with the button that cancels or resumes it. */
function planState(portalId: string, subscription: Subscription | undefined) {
  if (!subscription) {
    return "<p>No subscription.</p>";
  }
  const cancels = subscription.cancel_at_period_end;
  const action = cancels ? "resume" : "cancel";
  return (
    `<p>Plan: ${subscription.status}${cancels ? ", cancels at the end of the period" : ""}</p>` +
    `<form method="post" action="/portal/${portalId}/${action}"><button>${cancels ? "Resume plan" : "Cancel plan"}</button></form>`
  );
}

export async function startFakeStripe(options: FakeStripeOptions) {
  const fake = new Fake(options);
  const server = createServer((request, response) => void fake.handle(request, response));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  // Listening on a port, the server's address is that port's.
  const { port } = z.object({ port: z.number() }).parse(server.address());
  fake.baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: fake.baseUrl,
    port,
    events: fake.events,
    customers: fake.customers,
    subscriptions: fake.subscriptions,
    /** The subscription an organization has (by the orgId the app puts in metadata). */
    subscriptionFor: (orgId: string) =>
      [...fake.subscriptions.values()].find((s) => s.metadata.orgId === orgId),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type FakeStripe = Awaited<ReturnType<typeof startFakeStripe>>;
