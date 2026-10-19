/**
 * The asset picker, opened from "What you'll need" on a template's page and from the
 * editor's gap tiles: its three sources, the preview in the member's video, and "Use
 * this". It runs against the API's contract in memory (the AI service and the stock
 * providers behind the real API aren't stood in for these), each test's slots kept in a
 * plain object the procedures change as the API would.
 */

import { ORPCError } from "@orpc/client";
import { ApiProvider } from "@repo/client";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import type {
  AssetImage,
  AssetSlot,
  DirectorAssets,
  ServedAsset,
  ServedShotPlan,
  StockPhoto,
} from "@repo/contracts/api";
import { fileIdSchema } from "@repo/contracts/ids";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page as browserPage, commands, userEvent } from "vitest/browser";
import { GapStrip } from "@/modules/director/components/gap-strip";
import { SlotPreview } from "@/modules/director/components/slot-preview";
import { WhatYouNeed } from "@/modules/director/components/what-you-need";
import type { SlotPlacement } from "@/modules/director/lib/slot-preview";
import type { StandIn } from "../../../../packages/client/test/stand-in";
import { cleanup, renderPage } from "../render";
import { deferred, planShot, shotPlan, standIn } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

const VIDEO_ID = "abcdefghijk";
// A 1×1 PNG, served for every picture's link.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(atob(PNG), (char) => char.charCodeAt(0));
const picture = (name: string) => `https://cdn.test/${name}.png`;

function asset(overrides: Partial<ServedAsset> = {}): ServedAsset {
  return {
    id: "chart",
    kind: "image",
    title: "The chart",
    role: "Shows the four archetypes",
    description: "A chart of four archetypes.",
    prompt: "A chart of four archetypes",
    sourceStartSeconds: 1,
    sourceEndSeconds: 3,
    defaultSource: "create",
    personalisable: false,
    ask: null,
    secondScreen: false,
    reference: {
      subject: "Four archetypes",
      composition: "Centred",
      style: "Flat",
      palette: "Warm",
      blackAndWhite: false,
      aspectRatio: "9:16",
      text: [],
      brands: [],
      mood: "Playful",
    },
    ...overrides,
  };
}

function image(overrides: Partial<AssetImage> = {}): AssetImage {
  const id = crypto.randomUUID();
  return {
    id,
    origin: "created",
    media: "image",
    status: "ready",
    url: picture(id),
    prompt: null,
    credit: null,
    error: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function slot(overrides: Partial<AssetSlot> = {}): AssetSlot {
  return {
    assetId: "chart",
    prompt: "A chart of four archetypes",
    defaultImage: { id: crypto.randomUUID(), status: "ready", url: picture("default") },
    images: [],
    chosenId: null,
    history: [],
    ...overrides,
  };
}

const stockPhoto = (id: string, author: string): StockPhoto => ({
  provider: "pexels",
  id,
  previewUrl: picture(`stock-${id}`),
  width: 1080,
  height: 1920,
  alt: `A photo by ${author}`,
  author,
  authorUrl: "https://www.pexels.com/@someone",
  pageUrl: `https://www.pexels.com/photo/${id}`,
});

/** What the in-memory API holds and was asked, for a test to set and read. */
interface World {
  assets: DirectorAssets;
  stock: boolean;
  drawn: Record<string, unknown>[];
  chosen: (string | null)[];
  searched: string[];
  stockResults: StockPhoto[];
  /** A procedure the test makes refuse, and with which code. */
  refuse: Partial<
    Record<"list" | "draw" | "choose" | "addStock" | "addUpload" | "searchStock", string>
  >;
  /** A procedure the test holds until it lets it answer. */
  hold: Partial<Record<"draw" | "addStock" | "addUpload" | "searchStock", Promise<void>>>;
}

function world(overrides: Partial<World> = {}): World {
  return {
    assets: {
      slots: [slot()],
      images: { used: 0, perVideo: 12, today: 0, perDay: 30 },
    },
    stock: true,
    drawn: [],
    chosen: [],
    searched: [],
    stockResults: [],
    refuse: {},
    hold: {},
    ...overrides,
  };
}

/** The slot `assetId` as the world has it now. */
const slotIn = (state: World, assetId: string) => {
  const found = state.assets.slots.find((candidate) => candidate.assetId === assetId);
  if (!found) {
    throw new Error(`no slot ${assetId}`);
  }
  return found;
};

const refusal = (code: string) => new ORPCError(code);

/** The contract in memory: the slots, the files an upload goes through, and stock. */
function api(state: World): StandIn {
  const uploaded = (fileId: string, status: "pending" | "ready") => ({
    id: fileIdSchema.parse(fileId),
    purpose: "director-asset-image" as const,
    status,
    filename: "mine.png",
    contentType: "image/png",
    size: PNG_BYTES.length,
    rejectReason: null,
    createdAt: new Date(),
  });
  const added = async (
    which: "addStock" | "addUpload",
    assetId: string,
    made: AssetImage,
  ): Promise<AssetImage> => {
    await state.hold[which];
    const code = state.refuse[which];
    if (code) {
      throw refusal(code);
    }
    slotIn(state, assetId).images.push(made);
    return made;
  };
  return standIn((os) => ({
    system: {
      info: os.system.info.handler(() => ({
        release: "test",
        features: {
          ai: true,
          captcha: false,
          demoGuests: false,
          director: true,
          files: true,
          google: false,
          live: false,
          stock: state.stock,
        },
        minimumClientVersion: "1.0.0",
        captchaSiteKey: null,
        demo: null,
      })),
    },
    files: {
      createUpload: os.files.createUpload.handler(() => {
        const fileId = crypto.randomUUID();
        return {
          file: uploaded(fileId, "pending"),
          upload: {
            url: `https://storage.test/${fileId}`,
            headers: { "content-type": "image/png" },
            expiresAt: new Date(Date.now() + 60_000),
          },
        };
      }),
      completeUpload: os.files.completeUpload.handler(({ input }) =>
        uploaded(input.fileId, "ready"),
      ),
    },
    assets: {
      list: os.assets.list.handler(() => {
        if (state.refuse.list) {
          throw refusal(state.refuse.list);
        }
        return state.assets;
      }),
      draw: os.assets.draw.handler(async ({ input }) => {
        state.drawn.push(input);
        await state.hold.draw;
        if (state.refuse.draw) {
          throw refusal(state.refuse.draw);
        }
        const made = image({ status: "making", url: null, media: input.clip ? "video" : "image" });
        slotIn(state, input.assetId).images.push(made);
        state.assets.images.used += 1;
        return made;
      }),
      addUpload: os.assets.addUpload.handler(({ input }) =>
        added("addUpload", input.assetId, image({ origin: "upload" })),
      ),
      addStock: os.assets.addStock.handler(({ input }) =>
        added(
          "addStock",
          input.assetId,
          image({
            origin: "stock",
            credit: {
              provider: input.provider,
              author: "Ana Lee",
              authorUrl: "https://www.pexels.com/@ana",
              pageUrl: `https://www.pexels.com/photo/${input.photoId}`,
            },
          }),
        ),
      ),
      choose: os.assets.choose.handler(({ input }) => {
        if (state.refuse.choose) {
          throw refusal(state.refuse.choose);
        }
        const chosen = slotIn(state, input.assetId);
        chosen.history.unshift(chosen.chosenId);
        chosen.chosenId = input.imageId;
        state.chosen.push(input.imageId);
        return { ok: true as const };
      }),
      searchStock: os.assets.searchStock.handler(async ({ input }) => {
        state.searched.push(`${input.query} (${input.orientation})`);
        await state.hold.searchStock;
        if (state.refuse.searchStock) {
          throw refusal(state.refuse.searchStock);
        }
        return input.query === "nothing" ? [] : state.stockResults;
      }),
    },
  }));
}

/** Pictures and storage answer locally: a 1×1 PNG, and an upload's PUT taken as done. */
async function serveMedia() {
  await commands.serveRequests("^https://(cdn|storage)\\.test/", {
    contentType: "image/png",
    base64: PNG,
  });
}

/** What's under it once the system's features are known, as the page's gate has them. */
function Known({ children }: { children: ReactNode }) {
  return useSystemInfoQuery().data ? children : null;
}

async function show(state: World, ui: ReactNode) {
  await serveMedia();
  const stand = api(state);
  const page = await renderPage(
    <ApiProvider options={{ baseUrl: "http://api.test", fetch: stand.fetch }}>
      <Known>{ui}</Known>
    </ApiProvider>,
  );
  return page;
}

const plan = (assets: ServedAsset[], overrides: Partial<ServedShotPlan> = {}): ServedShotPlan => ({
  ...shotPlan({
    shots: [planShot({ sourceStartSeconds: 0, sourceEndSeconds: 4 })],
  }),
  assets,
  ...overrides,
});

const dialog = () => browserPage.getByRole("dialog");
const tile = (name: string) => dialog().getByRole("button", { name, exact: true });
const pngFile = (name = "mine.png") => new File([PNG_BYTES], name, { type: "image/png" });
const fileInput = (label: string) => dialog().getByLabelText(label);

describe("what you'll need", () => {
  it("lists what Director makes, drawn or still drawing, and opens the picker on one", async () => {
    const page = await show(
      world(),
      <WhatYouNeed
        videoId={VIDEO_ID}
        plan={plan([
          asset({ image: { status: "ready", url: picture("chart") } }),
          asset({
            id: "topic-card",
            kind: "text-card",
            title: "The topic card",
            personalisable: true,
            image: { status: "making", url: null },
          }),
          // Footage: nothing to pick yet.
          asset({ id: "street", kind: "broll", title: "A busy street" }),
        ])}
      />,
    );
    await expect.element(page.getByText("Your own topic, if you like")).toBeVisible();
    await expect.element(page.getByText("Director's still drawing this one")).toBeVisible();
    expect(page.getByRole("button", { name: "Change A busy street" }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByRole("heading", { name: "The chart" })).toBeVisible();
    await expect.element(dialog().getByText("Shows the four archetypes")).toBeVisible();
    // Create with AI first, for a picture Director drew.
    await expect
      .element(dialog().getByRole("tab", { name: "Create with AI" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialog().query()).toBeNull();
  });

  it("says why the pictures couldn't be had", async () => {
    await show(
      world({ refuse: { list: "UPSTREAM_UNAVAILABLE" } }),
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset()])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByRole("alert")).toBeVisible();
  });
});

describe("creating a picture with AI", () => {
  it("draws from the prompt and a photo of the member's, and changes the one picked", async () => {
    const state = world();
    await show(state, <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset()])} />);
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByText("12 pictures left for this video")).toBeVisible();
    // Nothing of the member's is asked for: Upload is plain, and empty.
    await userEvent.click(dialog().getByRole("tab", { name: "Upload" }));
    await expect.element(dialog().getByText("Choose a photo")).toBeVisible();
    await expect.element(dialog().getByText("Nothing here yet.")).toBeVisible();
    await userEvent.click(dialog().getByRole("tab", { name: "Create with AI" }));
    const prompt = dialog().getByLabelText("Describe the picture");
    await expect.element(prompt).toHaveValue("A chart of four archetypes");
    await userEvent.fill(prompt, "  ");

    // The file picker closed with nothing chosen: nothing changes.
    const reference = fileInput("Add your photo as reference").element();
    reference.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(dialog().getByText("Add your photo as reference")).toBeVisible();
    // A photo that isn't one is refused before anything is sent.
    await userEvent.upload(
      fileInput("Add your photo as reference"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    await expect
      .element(dialog().getByText("That isn't a photo we can use. Try a JPEG, PNG or WebP."))
      .toBeVisible();
    await userEvent.upload(fileInput("Add your photo as reference"), pngFile("me.png"));
    await expect.element(dialog().getByText("Drawing from me.png")).toBeVisible();
    await userEvent.click(dialog().getByRole("button", { name: "Remove photo" }));
    await expect.element(dialog().getByText("Add your photo as reference")).toBeVisible();
    await userEvent.upload(fileInput("Add your photo as reference"), pngFile("me.png"));

    await userEvent.click(dialog().getByRole("button", { name: "Create", exact: true }));
    // An empty prompt draws from the slot's own.
    await expect
      .poll(() => state.drawn[0])
      .toMatchObject({ prompt: "A chart of four archetypes", referenceFileId: expect.any(String) });
    await expect.element(tile("Your picture 1")).toBeDisabled();
    await expect.element(dialog().getByText("Drawing it")).toBeVisible();
    await expect.element(dialog().getByText("11 pictures left for this video")).toBeVisible();

    // Another from the same prompt, then an edit of Director's version, which is picked.
    await userEvent.click(dialog().getByRole("button", { name: "Generate another" }));
    await expect.poll(() => state.drawn).toHaveLength(2);
    const change = dialog().getByLabelText("Change the one you picked");
    // Nothing to change it by: nothing's sent, even past its disabled button (a script,
    // an assistive tool).
    await userEvent.fill(change, "   ");
    change.element().closest("form")?.requestSubmit();
    expect(state.drawn).toHaveLength(2);
    await userEvent.fill(change, "make it moodier");
    await userEvent.click(dialog().getByRole("button", { name: "Change it" }));
    // The prompt box is still empty: the edit goes with the slot's prompt, not a blank.
    await expect
      .poll(() => state.drawn[2])
      .toMatchObject({
        prompt: "A chart of four archetypes",
        instruction: "make it moodier",
        baseId: state.assets.slots[0]?.defaultImage?.id,
      });
    await expect.element(change).toHaveValue("");
  });

  it("makes a gap's moment a video clip, and says why a drawing was refused", async () => {
    const state = world({
      assets: {
        slots: [slot({ assetId: "gap-1", defaultImage: null, prompt: "Steam over a cup" })],
        images: { used: 0, perVideo: 12, today: 0, perDay: 30 },
      },
    });
    const page = await show(
      state,
      <GapStrip
        videoId={VIDEO_ID}
        plan={plan([])}
        gaps={[
          {
            slotId: "gap-1",
            description: "Steam over a cup",
            span: { start: 2, end: 3 },
            shotIndex: null,
          },
        ]}
        slots={state.assets.slots}
        locked={false}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: /Steam over a cup/ }));
    // A gap is stock first; Create makes a clip too.
    await expect
      .element(dialog().getByRole("tab", { name: "Stock" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(dialog().getByRole("tab", { name: "Create with AI" }));
    // Nothing drawn yet: no "another", and nothing picked to change.
    await expect.element(dialog().getByText("Nothing here yet.")).toBeVisible();
    expect(dialog().getByLabelText("Change the one you picked").query()).toBeNull();
    // A clip is filmed from the words alone: a reference photo is for stills.
    await userEvent.upload(fileInput("Add your photo as reference"), pngFile("me.png"));
    await expect.element(dialog().getByText("Drawing from me.png")).toBeVisible();
    await userEvent.click(dialog().getByRole("button", { name: "Make a video clip" }));
    await expect.poll(() => state.drawn[0]).toMatchObject({ assetId: "gap-1", clip: true });
    expect(state.drawn[0]).not.toHaveProperty("referenceFileId");

    state.refuse.draw = "AI_BUDGET_EXCEEDED";
    await userEvent.click(dialog().getByRole("button", { name: "Create", exact: true }));
    await expect.element(dialog().getByRole("alert")).toBeVisible();
  });

  it("shows Starting… while a drawing is asked for, and stops at the limit", async () => {
    const held = deferred<void>();
    const state = world({
      hold: { draw: held.promise },
      assets: {
        slots: [slot()],
        images: { used: 11, perVideo: 12, today: 3, perDay: 30 },
      },
    });
    await show(state, <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset()])} />);
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByText("1 picture left for this video")).toBeVisible();
    await userEvent.click(dialog().getByRole("button", { name: "Create", exact: true }));
    await expect.element(dialog().getByRole("button", { name: "Starting…" })).toBeDisabled();
    held.resolve();
    await expect
      .element(
        dialog().getByText("No more pictures for this video. Upload your own or pick from stock."),
      )
      .toBeVisible();
    await expect
      .element(dialog().getByRole("button", { name: "Create", exact: true }))
      .toBeDisabled();
  });
});

describe("uploading a picture", () => {
  it("asks for the member's own thing first, checks the photo, and picks it once it's in", async () => {
    const held = deferred<void>();
    const state = world({ hold: { addUpload: held.promise } });
    await show(
      state,
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset({ ask: "A photo of your dog" })])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByText("A photo of your dog")).toBeVisible();
    await expect.element(dialog().getByText("Nothing here yet.")).toBeVisible();
    const choose = fileInput("Choose a photo");
    // Choosing nothing (the picker closed) does nothing.
    choose.element().dispatchEvent(new Event("change", { bubbles: true }));
    await userEvent.upload(choose, new File(["%PDF"], "notes.pdf", { type: "application/pdf" }));
    await expect
      .element(dialog().getByText("That isn't a photo we can use. Try a JPEG, PNG or WebP."))
      .toBeVisible();
    await userEvent.upload(choose, pngFile());
    await expect.element(dialog().getByText("Checking your photo")).toBeVisible();
    held.resolve();
    // It's picked for the member, not yet in their video.
    await expect.element(tile("Your picture 1")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(dialog().getByRole("button", { name: "Use this" }));
    await expect.poll(() => state.chosen).toEqual([state.assets.slots[0]?.images[0]?.id]);
    await expect.element(tile("Your picture 1, in your video")).toBeVisible();
    await expect.element(dialog().getByRole("button", { name: "In your video" })).toBeDisabled();
  });

  it("says why an upload couldn't be added", async () => {
    const state = world({ refuse: { addUpload: "DEMO_ACCOUNT_LOCKED" } });
    await show(
      state,
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset({ ask: "A photo of your dog" })])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await userEvent.upload(fileInput("Choose a photo"), pngFile());
    await expect.element(dialog().getByRole("alert")).toBeVisible();
  });
});

describe("stock photos", () => {
  it("searches in the slot's shape, credits each photo, and adds the one picked", async () => {
    const held = deferred<void>();
    const searching = deferred<void>();
    const state = world({
      hold: { addStock: held.promise, searchStock: searching.promise },
      stockResults: [stockPhoto("101", "Ana Lee"), stockPhoto("102", "Bo Chen")],
    });
    await show(
      state,
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset({ defaultSource: "stock" })])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect
      .element(dialog().getByRole("tab", { name: "Stock" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(dialog().getByText("Looking for photos")).toBeVisible();
    searching.resolve();
    // The whole frame is the asset's: a portrait search.
    expect(state.searched).toEqual(["Four archetypes (portrait)"]);
    await expect
      .element(dialog().getByRole("link", { name: "Ana Lee on Pexels" }))
      .toHaveAttribute("href", "https://www.pexels.com/photo/101");

    await userEvent.click(
      dialog().getByRole("button", { name: "Add the photo by Bo Chen on Pexels" }),
    );
    await expect.element(dialog().getByText("Adding the photo")).toBeVisible();
    held.resolve();
    await expect.element(tile("Ana Lee on Pexels")).toHaveAttribute("aria-pressed", "true");

    await userEvent.fill(dialog().getByLabelText("Search free stock photos"), "nothing");
    await userEvent.click(dialog().getByRole("button", { name: "Search" }));
    await expect.element(dialog().getByText("No photos for that. Try other words.")).toBeVisible();
  });

  it("says why a search or a copy failed", async () => {
    const state = world({
      refuse: { searchStock: "UPSTREAM_UNAVAILABLE" },
      stockResults: [stockPhoto("101", "Ana Lee")],
    });
    await show(
      state,
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset({ defaultSource: "stock" })])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByRole("alert")).toBeVisible();
    state.refuse = { addStock: "DEMO_ACCOUNT_LOCKED" };
    await userEvent.fill(dialog().getByLabelText("Search free stock photos"), "coffee");
    await userEvent.click(dialog().getByRole("button", { name: "Search" }));
    await userEvent.click(
      dialog().getByRole("button", { name: "Add the photo by Ana Lee on Pexels" }),
    );
    await expect.element(dialog().getByRole("alert")).toBeVisible();
  });

  it("isn't offered where stock is off", async () => {
    await show(
      world({ stock: false }),
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset({ defaultSource: "stock" })])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect
      .element(dialog().getByRole("tab", { name: "Create with AI" }))
      .toHaveAttribute("aria-selected", "true");
    expect(dialog().getByRole("tab", { name: "Stock" }).query()).toBeNull();
  });
});

describe("the picture in the member's video", () => {
  it("previews the one picked, uses it, and undoes back to the one before", async () => {
    const mine = image({ origin: "created" });
    const failed = image({ origin: "created", status: "failed", url: null });
    const clip = image({ origin: "created", media: "video", url: picture("clip") });
    const state = world({
      assets: {
        slots: [slot({ images: [mine, failed, clip], chosenId: mine.id, history: [null] })],
        images: { used: 3, perVideo: 12, today: 3, perDay: 30 },
      },
    });
    await show(
      state,
      <WhatYouNeed
        videoId={VIDEO_ID}
        plan={plan([asset()], {
          shots: [
            {
              ...planShot({ sourceStartSeconds: 0, sourceEndSeconds: 4 }),
              storyboardUrl: picture("storyboard"),
            },
          ],
        })}
      />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    // The one in the video is picked to start with, and says it's in use.
    await expect
      .element(tile("Your picture 1, in your video"))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(tile("Your picture 2")).toBeDisabled();
    await expect.element(dialog().getByText("That one didn't work. Try again.")).toBeVisible();
    // A clip plays while it's looked at, and stops after.
    const clipTile = tile("Your picture 3");
    const video = clipTile.element().querySelector("video");
    await userEvent.hover(clipTile);
    await userEvent.unhover(clipTile);
    expect(video?.paused).toBe(true);

    const preview = dialog().getByRole("button", { name: "Preview in your video" });
    await userEvent.click(preview);
    await expect.element(dialog().getByText("How it sits in your video")).toBeVisible();
    await userEvent.click(dialog().getByRole("button", { name: "Hide the preview" }));
    await expect.element(preview).toHaveAttribute("aria-expanded", "false");

    // Director's version: back to the default.
    await userEvent.click(tile("Director's version"));
    await userEvent.click(dialog().getByRole("button", { name: "Use this" }));
    await expect.poll(() => state.chosen).toEqual([null]);
    await userEvent.click(dialog().getByRole("button", { name: "Undo" }));
    await expect.poll(() => state.chosen).toEqual([null, mine.id]);
  });

  it("says why a picture couldn't be used, and can't use one with nothing to show", async () => {
    const state = world({
      refuse: { choose: "DIRECTOR_ASSET_NOT_FOUND" },
      assets: {
        slots: [slot({ defaultImage: null, images: [image()] })],
        images: { used: 1, perVideo: 12, today: 1, perDay: 30 },
      },
    });
    await show(state, <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset()])} />);
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    // The video has the default, and there's no default to show: nothing to use.
    await expect.element(dialog().getByRole("button", { name: "In your video" })).toBeDisabled();
    await userEvent.click(dialog().getByRole("button", { name: "Preview in your video" }));
    await expect.element(dialog().getByText("How it sits in your video")).toBeVisible();
    await userEvent.click(tile("Your picture 1"));
    await userEvent.click(dialog().getByRole("button", { name: "Use this" }));
    await expect.element(dialog().getByRole("alert")).toBeVisible();
  });
});

describe("a picture in the video that's still being drawn", () => {
  it("has nothing to preview yet", async () => {
    const drawing = image({ status: "making", url: null });
    await show(
      world({
        assets: {
          slots: [slot({ images: [drawing], chosenId: drawing.id })],
          images: { used: 1, perVideo: 12, today: 1, perDay: 30 },
        },
      }),
      <WhatYouNeed videoId={VIDEO_ID} plan={plan([asset()])} />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Change The chart" }));
    await expect.element(dialog().getByRole("button", { name: "In your video" })).toBeDisabled();
    await userEvent.click(dialog().getByRole("button", { name: "Preview in your video" }));
    const figure = dialog().getByText("How it sits in your video").element().closest("figure");
    await expect.poll(() => figure?.querySelectorAll("img").length).toBe(0);
  });
});

describe("the editor's gap tiles", () => {
  it("say which are filled, which hold a skipped shot, and stay shut while locked", async () => {
    const filled = image({ origin: "stock" });
    const page = await show(
      world(),
      <GapStrip
        videoId={VIDEO_ID}
        plan={plan([])}
        gaps={[
          { slotId: "gap-1", description: "Steam", span: { start: 1, end: 2 }, shotIndex: null },
          { slotId: "shot-2", description: "The smile", span: { start: 4, end: 6 }, shotIndex: 2 },
        ]}
        slots={[slot({ assetId: "gap-1", images: [filled], chosenId: filled.id })]}
        locked
      />,
    );
    await expect.element(page.getByRole("button", { name: /Steam.*Filled/ })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: /The smile.*Skipped shot.*Holds your shot/ }))
      .toBeDisabled();
  });

  it("open the picker on a gap the editor has no slot for yet, named by what it shows", async () => {
    const state = world({
      assets: {
        slots: [slot({ assetId: "shot-3", defaultImage: null, prompt: "A wave goodbye" })],
        images: { used: 0, perVideo: 12, today: 0, perDay: 30 },
      },
    });
    const page = await show(
      state,
      <GapStrip
        videoId={VIDEO_ID}
        plan={plan([])}
        gaps={[
          {
            slotId: "shot-3",
            description: "A wave goodbye",
            span: { start: 8, end: 9 },
            shotIndex: 3,
          },
        ]}
        slots={[]}
        locked={false}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: /A wave goodbye/ }));
    await expect.element(dialog().getByRole("heading", { name: "A wave goodbye" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialog().query()).toBeNull();
  });

  it("show nothing without a gap", async () => {
    // Nothing to ask the API for either: it draws nothing at all.
    const page = await renderPage(
      <GapStrip videoId={VIDEO_ID} plan={plan([])} gaps={[]} slots={[]} locked={false} />,
    );
    expect(page.getByRole("heading", { name: "Moments to fill" }).query()).toBeNull();
    expect(page.getByRole("button").query()).toBeNull();
  });
});

describe("the preview in the member's video", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  async function preview(placement: Partial<SlotPlacement>, cameraUrl?: string) {
    await serveMedia();
    return renderPage(
      <SlotPreview
        placement={{
          asset: box(0, 0, 1, 1),
          camera: null,
          fit: "cover",
          filter: null,
          captions: null,
          ...placement,
        }}
        imageUrl={picture("candidate")}
        cameraUrl={cameraUrl}
      />,
    );
  }
  const captionTop = () => browserPage.getByText("Your words").element();

  it("puts the captions at the seam of a split, whichever half the camera has", async () => {
    const top = await preview(
      { asset: box(0, 0.4, 1, 0.6), camera: box(0, 0, 1, 0.4), captions: "between-halves" },
      picture("storyboard"),
    );
    expect(captionTop()).toHaveStyle({ top: "40%" });
    // The template's own frame of the moment stands for the member's camera.
    expect(top.getByText("You").query()).toBeNull();
    cleanup();
    const bottom = await preview({
      asset: box(0, 0, 1, 0.6),
      camera: box(0, 0.6, 1, 0.4),
      captions: "between-halves",
    });
    expect(captionTop()).toHaveStyle({ top: "60%" });
    await expect.element(bottom.getByText("You")).toBeVisible();
  });

  it("puts the captions in the template's place, and fits and grades the picture as it does", async () => {
    await preview({ captions: "between-halves", fit: "contain", filter: "grayscale(1)" });
    // No split to sit between: the middle.
    expect(captionTop()).toHaveStyle({ top: "50%" });
    const candidate = document.querySelector<HTMLImageElement>('img[src*="candidate"]');
    expect(candidate?.className).toContain("object-contain");
    expect(candidate?.style.filter).toBe("grayscale(1)");
    cleanup();
    const plain = await preview({ captions: null });
    expect(plain.getByText("Your words").query()).toBeNull();
    const cropped = document.querySelector<HTMLImageElement>('img[src*="candidate"]');
    expect(cropped?.className).toContain("object-cover");
    expect(cropped?.style.filter).toBe("");
    cleanup();
    await preview({ captions: "bottom" });
    expect(captionTop()).toHaveStyle({ top: "82%" });
  });
});

describe("what you'll need, for a plan with none of it", () => {
  it("says it's only the member's voice, and lists nothing to make or edit", async () => {
    const page = await renderPage(
      <WhatYouNeed
        videoId={VIDEO_ID}
        plan={plan([], { shots: [planShot({ mode: "voice-over" })], edits: [] })}
      />,
    );
    await expect.element(page.getByText("Just your voice: you're not on camera")).toBeVisible();
    expect(page.getByText("Director makes for you").query()).toBeNull();
    expect(page.getByText("The editing").query()).toBeNull();
  });

  it("lists the editing the editor applies", async () => {
    const page = await renderPage(
      <WhatYouNeed
        videoId={VIDEO_ID}
        plan={plan([], {
          edits: [
            {
              type: "grade",
              startSeconds: 0,
              endSeconds: 2,
              grade: "black-and-white",
              target: "all",
            },
          ],
        })}
      />,
    );
    await expect.element(page.getByText("The editing")).toBeVisible();
    await expect.element(page.getByText("black and white")).toBeVisible();
  });
});
