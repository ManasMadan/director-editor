/**
 * Pexels and Pixabay, as the asset picker reads them: the only place that knows their
 * wire formats. Each answer is parsed with a schema, so a change on their side fails
 * loudly instead of passing bad data on. Both are searched for photos only (clips are
 * for gap filling).
 */
import { STOCK_RESULTS_PER_PROVIDER } from "@repo/contracts/api";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import * as z from "zod";
import type { Orientation, StockProvider, StockResult } from "./stock";

/** The provider answered with an error (a bad key, its rate limit, an outage). */
class StockProviderError extends Error {
  constructor(provider: string, status: number) {
    super(`${provider} answered ${status}`);
  }
}

async function getJson(url: URL, provider: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new StockProviderError(provider, response.status);
  }
  const body: unknown = await response.json();
  return body;
}

// ---------------------------------------------------------------------------- Pexels

const pexelsPhoto = z.object({
  id: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.url(),
  photographer: z.string(),
  photographer_url: z.url(),
  alt: z.string().nullable().default(""),
  src: z.object({ large2x: z.url(), medium: z.url() }),
});
const pexelsSearch = z.object({ photos: z.array(pexelsPhoto) });

function fromPexels(photo: z.infer<typeof pexelsPhoto>): StockResult {
  return {
    provider: "pexels",
    id: String(photo.id),
    previewUrl: photo.src.medium,
    imageUrl: photo.src.large2x,
    width: photo.width,
    height: photo.height,
    alt: photo.alt ?? "",
    author: photo.photographer,
    authorUrl: photo.photographer_url,
    pageUrl: photo.url,
  };
}

function pexels(baseUrl: string, key: string): StockProvider {
  const headers = { authorization: key };
  return {
    name: "pexels",
    imageHosts: [new URL(baseUrl).host, "images.pexels.com"],
    async search(query: string, orientation: Orientation) {
      const url = new URL("/v1/search", baseUrl);
      url.search = new URLSearchParams({
        query,
        orientation,
        per_page: String(STOCK_RESULTS_PER_PROVIDER),
      }).toString();
      const body = await getJson(url, "pexels", headers);
      return body === null ? [] : pexelsSearch.parse(body).photos.map(fromPexels);
    },
    async photo(id: string) {
      if (!/^\d+$/.test(id)) {
        return null;
      }
      const body = await getJson(new URL(`/v1/photos/${id}`, baseUrl), "pexels", headers);
      return body === null ? null : fromPexels(pexelsPhoto.parse(body));
    },
  };
}

// ---------------------------------------------------------------------------- Pixabay

const pixabayHit = z.object({
  id: z.number().int(),
  pageURL: z.url(),
  tags: z.string(),
  webformatURL: z.url(),
  largeImageURL: z.url(),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  user: z.string(),
  user_id: z.number().int(),
});
const pixabaySearch = z.object({ hits: z.array(pixabayHit) });

const PIXABAY_ORIENTATION: Record<Orientation, string> = {
  portrait: "vertical",
  landscape: "horizontal",
  square: "all",
};

function fromPixabay(hit: z.infer<typeof pixabayHit>): StockResult {
  return {
    provider: "pixabay",
    id: String(hit.id),
    previewUrl: hit.webformatURL,
    imageUrl: hit.largeImageURL,
    width: hit.imageWidth,
    height: hit.imageHeight,
    alt: hit.tags,
    author: hit.user,
    authorUrl: `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/`,
    pageUrl: hit.pageURL,
  };
}

function pixabay(baseUrl: string, key: string): StockProvider {
  const endpoint = (params: Record<string, string>) => {
    const url = new URL("/api/", baseUrl);
    // safesearch, and no illustrations of brands: Pixabay's terms forbid using
    // recognisable brands commercially.
    url.search = new URLSearchParams({
      key,
      image_type: "photo",
      safesearch: "true",
      ...params,
    }).toString();
    return url;
  };
  return {
    name: "pixabay",
    imageHosts: [new URL(baseUrl).host, "pixabay.com", "cdn.pixabay.com"],
    async search(query: string, orientation: Orientation) {
      const url = endpoint({
        q: query,
        orientation: PIXABAY_ORIENTATION[orientation],
        per_page: String(STOCK_RESULTS_PER_PROVIDER),
      });
      const body = await getJson(url, "pixabay");
      return body === null ? [] : pixabaySearch.parse(body).hits.map(fromPixabay);
    },
    async photo(id: string) {
      if (!/^\d+$/.test(id)) {
        return null;
      }
      const body = await getJson(endpoint({ id }), "pixabay");
      const hit = body === null ? undefined : pixabaySearch.parse(body).hits[0];
      return hit ? fromPixabay(hit) : null;
    },
  };
}

/** The providers whose keys are set, Pexels first. */
export function createStockProviders(config: {
  PEXELS_API_KEY?: string | undefined;
  PEXELS_API_URL: string;
  PIXABAY_API_KEY?: string | undefined;
  PIXABAY_API_URL: string;
}): StockProvider[] {
  return [
    ...(config.PEXELS_API_KEY ? [pexels(config.PEXELS_API_URL, config.PEXELS_API_KEY)] : []),
    ...(config.PIXABAY_API_KEY ? [pixabay(config.PIXABAY_API_URL, config.PIXABAY_API_KEY)] : []),
  ];
}
