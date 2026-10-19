/**
 * The stock seam against a local stand-in that speaks Pexels' and Pixabay's APIs (their
 * search, a photo by id, and the image files), on a loopback port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HOUR_MS } from "@repo/contracts/time";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageKeyAllowed } from "../assets.service";
import { createStockProviders } from "./providers";
import { interleave, StockLibrary, type StockProvider } from "./stock";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
let base = "";
let server: Server;
const seen: string[] = [];
let failPixabay = false;
/** Both providers answer 404 to everything but the image files. */
let gone = false;

function pexelsPhoto(id: number) {
  return {
    id,
    width: 4000,
    height: 3000,
    url: `https://www.pexels.com/photo/${id}/`,
    photographer: "Jane Doe",
    photographer_url: "https://www.pexels.com/@jane",
    alt: "A coffee cup",
    src: { large2x: `${base}/images/${id}.jpg`, medium: `${base}/images/${id}-small.jpg` },
  };
}

function pixabayHit(id: number) {
  return {
    id,
    pageURL: `https://pixabay.com/photos/${id}/`,
    tags: "coffee, cup",
    webformatURL: `${base}/images/${id}-small.jpg`,
    largeImageURL: `${base}/images/${id}.jpg`,
    imageWidth: 1920,
    imageHeight: 1280,
    user: "joe",
    user_id: 7,
  };
}

/** Pexels' photo by id: 3 has no alt text, and its full-size link on another host. */
function pexelsById(id: number) {
  const photo = pexelsPhoto(id);
  return id === 3
    ? { ...photo, alt: null, src: { ...photo.src, large2x: "https://elsewhere.test/3.jpg" } }
    : photo;
}

/** The image files: whole JPEGs, one that doesn't say its type, one too big to keep. */
function imageFile(path: string, response: ServerResponse) {
  if (path === "/images/1.jpg" || path === "/images/10.jpg") {
    response.writeHead(200, { "content-type": "image/jpeg", "content-length": JPEG.length });
    response.end(JPEG);
  } else if (path === "/images/4.jpg") {
    response.writeHead(200);
    response.end(JPEG);
  } else if (path === "/images/6.jpg") {
    // Sent without saying its length up front.
    response.writeHead(200, { "content-type": "image/jpeg", "transfer-encoding": "chunked" });
    response.write(Buffer.alloc(8_000_000));
    response.write(Buffer.alloc(8_000_000));
    response.end();
  } else {
    return false;
  }
  return true;
}

function answer(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", base);
  seen.push(`${url.pathname}${url.search} ${request.headers.authorization ?? ""}`);
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (imageFile(url.pathname, response)) {
    return;
  }
  if (gone) {
    return json(404, { error: "not found" });
  }
  if (url.pathname === "/v1/search") {
    return json(200, { photos: [pexelsPhoto(1), pexelsPhoto(2)] });
  }
  const photo = /^\/v1\/photos\/([1-46])$/.exec(url.pathname);
  if (photo) {
    return json(200, pexelsById(Number(photo[1])));
  }
  if (url.pathname.startsWith("/v1/photos/")) {
    return json(404, { error: "not found" });
  }
  if (url.pathname === "/api/") {
    if (failPixabay) {
      return json(429, { error: "slow down" });
    }
    const id = url.searchParams.get("id");
    return json(200, { hits: id === "99" ? [] : [pixabayHit(id ? Number(id) : 10)] });
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<html></html>");
}

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stand-in isn't listening on a port");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function library(now = () => 0) {
  return new StockLibrary(
    createStockProviders({
      PEXELS_API_KEY: "pexels-key",
      PEXELS_API_URL: base,
      PIXABAY_API_KEY: "pixabay-key",
      PIXABAY_API_URL: base,
    }),
    now,
  );
}

describe("stock photos", () => {
  it("searches both providers, Pexels first, in turn, with each one's credit", async () => {
    const photos = await library().search("coffee", "landscape");
    expect(photos.map((photo) => `${photo.provider}:${photo.id}`)).toEqual([
      "pexels:1",
      "pixabay:10",
      "pexels:2",
    ]);
    expect(photos[1]).toEqual({
      provider: "pixabay",
      id: "10",
      previewUrl: `${base}/images/10-small.jpg`,
      width: 1920,
      height: 1280,
      alt: "coffee, cup",
      author: "joe",
      authorUrl: "https://pixabay.com/users/joe-7/",
      pageUrl: "https://pixabay.com/photos/10/",
    });
    // The keys go where each provider wants them; the full-size link stays on the server.
    expect(seen).toContainEqual(expect.stringMatching(/^\/v1\/search\?query=coffee.* pexels-key$/));
    expect(seen).toContainEqual(expect.stringMatching(/key=pixabay-key.*orientation=horizontal/));
    expect(photos[0]).not.toHaveProperty("imageUrl");
  });

  it("answers again from its cache within the day, and asks again after it", async () => {
    let now = 0;
    const stock = library(() => now);
    await stock.search("tea", "portrait");
    const asked = seen.length;
    await stock.search("TEA", "portrait");
    expect(seen.length).toBe(asked);
    now = 25 * HOUR_MS;
    await stock.search("tea", "portrait");
    expect(seen.length).toBeGreaterThan(asked);
  });

  it("keeps the other provider's photos when one fails, and fails when none answers", async () => {
    failPixabay = true;
    try {
      const photos = await library().search("rain", "square");
      expect(new Set(photos.map((photo) => photo.provider))).toEqual(new Set(["pexels"]));
      const pixabayOnly = new StockLibrary(
        createStockProviders({
          PEXELS_API_URL: base,
          PIXABAY_API_KEY: "pixabay-key",
          PIXABAY_API_URL: base,
        }),
      );
      await expect(pixabayOnly.search("rain", "square")).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
    } finally {
      failPixabay = false;
    }
  });

  it("copies a photo it finds again by id, with its credit", async () => {
    const copy = await library().copy("pexels", "1");
    expect(copy).toEqual({
      data: JPEG,
      contentType: "image/jpeg",
      extension: "jpg",
      credit: {
        provider: "pexels",
        author: "Jane Doe",
        authorUrl: "https://www.pexels.com/@jane",
        pageUrl: "https://www.pexels.com/photo/1/",
      },
    });
    expect((await library().copy("pixabay", "10")).credit.author).toBe("joe");
  });

  it("copies nothing a provider doesn't have, or that isn't an image", async () => {
    await expect(library().copy("pexels", "5")).rejects.toMatchObject({
      code: "DIRECTOR_ASSET_NOT_FOUND",
    });
    await expect(library().copy("pexels", "../x")).rejects.toMatchObject({
      code: "DIRECTOR_ASSET_NOT_FOUND",
    });
    await expect(library().copy("pixabay", "99")).rejects.toMatchObject({
      code: "DIRECTOR_ASSET_NOT_FOUND",
    });
    // Photo 2's full-size link answers with a page, not an image.
    await expect(library().copy("pexels", "2")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("copies nothing from another host, without a type, or too big to keep", async () => {
    for (const id of ["3", "4", "6"]) {
      await expect(library().copy("pexels", id)).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
    }
    await expect(library().copy("pixabay", "../x")).rejects.toMatchObject({
      code: "DIRECTOR_ASSET_NOT_FOUND",
    });
  });

  it("reads a photo with no alt text as having none", async () => {
    const [pexels] = createStockProviders({
      PEXELS_API_KEY: "pexels-key",
      PEXELS_API_URL: base,
      PIXABAY_API_URL: base,
    });
    expect((await pexels?.photo("3"))?.alt).toBe("");
  });

  it("finds nothing where both providers have nothing", async () => {
    gone = true;
    try {
      await expect(library().search("nothing", "portrait")).resolves.toEqual([]);
      await expect(library().copy("pixabay", "10")).rejects.toMatchObject({
        code: "DIRECTOR_ASSET_NOT_FOUND",
      });
    } finally {
      gone = false;
    }
  });

  it("keeps the latest searches, forgetting the oldest once it holds 500", async () => {
    const asked: string[] = [];
    const counting: StockProvider = {
      name: "pexels",
      imageHosts: [],
      search: (query) => {
        asked.push(query);
        return Promise.resolve([]);
      },
      photo: () => Promise.resolve(null),
    };
    const stock = new StockLibrary([counting], () => 0);
    for (let index = 0; index <= 500; index++) {
      await stock.search(`query ${index}`, "square");
    }
    asked.length = 0;
    await stock.search("query 1", "square");
    expect(asked).toEqual([]);
    await stock.search("query 0", "square");
    expect(asked).toEqual(["query 0"]);
  });

  it("is off without a key", async () => {
    const off = new StockLibrary(
      createStockProviders({ PEXELS_API_URL: base, PIXABAY_API_URL: base }),
    );
    expect(off.enabled).toBe(false);
    await expect(off.search("x", "square")).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    await expect(off.copy("pexels", "1")).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    const pexelsOnly = new StockLibrary(
      createStockProviders({ PEXELS_API_KEY: "k", PEXELS_API_URL: base, PIXABAY_API_URL: base }),
    );
    await expect(pexelsOnly.copy("pixabay", "10")).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
    });
  });

  it("takes lists' items in turn", () => {
    expect(interleave([[1, 2, 3], [4], []])).toEqual([1, 4, 2, 3]);
    expect(interleave([])).toEqual([]);
  });
});

describe("which keys an image of a slot may be signed for", () => {
  const plan = "01a14f8a-a7c2-7849-8caa-3b082d3b4de7";
  const id = "019a0000-0000-7000-8000-000000000001";
  const image = (origin: "created" | "upload" | "stock", objectKey: string | null) => ({
    id,
    assetId: "chart",
    origin,
    status: "ready" as const,
    objectKey,
    fileId: origin === "upload" ? id : null,
    error: null,
    prompt: null,
    credit: null,
    createdAt: new Date(0),
  });

  it("allows only the slot's own folder, or the upload's own file", () => {
    expect(imageKeyAllowed(plan, image("created", `director-assets/${plan}/chart/${id}.png`))).toBe(
      true,
    );
    expect(imageKeyAllowed(plan, image("stock", `director-assets/${plan}/chart/${id}.jpg`))).toBe(
      true,
    );
    expect(imageKeyAllowed(plan, image("upload", `files/${id}`))).toBe(true);
    // A gap's Veo clip, kept beside the slot's images.
    expect(imageKeyAllowed(plan, image("created", `director-assets/${plan}/chart/${id}.mp4`))).toBe(
      true,
    );
    expect(imageKeyAllowed(plan, image("created", `director-assets/${plan}/chart/${id}.mov`))).toBe(
      false,
    );
    expect(imageKeyAllowed(plan, image("created", null))).toBe(false);
    expect(imageKeyAllowed(plan, image("created", `director-assets/${plan}/card/${id}.png`))).toBe(
      false,
    );
    expect(imageKeyAllowed(plan, image("created", `director-assets/${plan}/chart/../x.png`))).toBe(
      false,
    );
    expect(imageKeyAllowed(plan, image("upload", "files/someone-else"))).toBe(false);
    expect(imageKeyAllowed(plan, { ...image("upload", `files/${id}`), fileId: null })).toBe(false);
  });
});
