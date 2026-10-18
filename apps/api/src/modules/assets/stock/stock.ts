/**
 * Stock photos for the asset picker: the seam between Director and the stock libraries
 * (Pexels first, Pixabay second; their licences allow use in a YouTube video, and their
 * API terms are followed here: keys stay on the server, results are cached a day, a photo
 * the member uses is copied into our storage rather than hotlinked, and its creator and
 * source are credited).
 *
 * Swapping or adding a provider: implement `StockProvider` (search, and one photo again
 * by its id, so a copy never trusts a URL the client sent) and add it in
 * `createStockProviders`. Nothing else names a provider.
 */
import type { StockCredit, StockPhoto, StockProviderName } from "@repo/contracts/api";
import { DAY_S, PROVIDER_TIMEOUT_MS, SECOND_MS } from "@repo/contracts/time";
import { AppError } from "@repo/nest-common";

export type Orientation = "portrait" | "landscape" | "square";

/** A photo as a provider describes it, with the full-size link to copy it from. */
export interface StockResult extends StockPhoto {
  imageUrl: string;
}

export interface StockProvider {
  readonly name: StockProviderName;
  /** Where its full-size images may be downloaded from (checked before a copy). */
  readonly imageHosts: readonly string[];
  search(query: string, orientation: Orientation): Promise<StockResult[]>;
  /** One photo again, by its id; null when the provider no longer has it. */
  photo(id: string): Promise<StockResult | null>;
}

/** The largest photo copied: an upload's limit (director-asset-image). */
const MAX_COPY_BYTES = 15_000_000;
const COPY_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);
// Searches cached a day (Pixabay's terms ask for it, and Pexels' hourly limit is the
// whole app's), at most this many at a time per process.
const CACHE_ENTRIES = 500;

/** A copied photo: its bytes, type and file extension, and its credit. */
export interface StockCopy {
  data: Buffer;
  contentType: string;
  extension: string;
  credit: StockCredit;
}

export class StockLibrary {
  private readonly cache = new Map<string, { at: number; photos: StockPhoto[] }>();

  constructor(
    private readonly providers: readonly StockProvider[],
    private readonly now: () => number = Date.now,
  ) {}

  get enabled() {
    return this.providers.length > 0;
  }

  /**
   * Every provider's photos for the words, interleaved (Pexels first). A provider that
   * fails is left out while another answers; UPSTREAM_UNAVAILABLE when none does.
   */
  async search(query: string, orientation: Orientation): Promise<StockPhoto[]> {
    this.requireEnabled();
    const key = `${orientation}\n${query.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < DAY_S * SECOND_MS) {
      return cached.photos;
    }
    const answers = await Promise.allSettled(
      this.providers.map((provider) => provider.search(query, orientation)),
    );
    const lists = answers.flatMap((answer) =>
      answer.status === "fulfilled" ? [answer.value.map(publicPhoto)] : [],
    );
    if (lists.length === 0) {
      throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "stock" } });
    }
    const photos = interleave(lists);
    this.remember(key, photos);
    return photos;
  }

  /** Downloads a provider's photo by its id, to store as the member's (with its credit). */
  async copy(name: StockProviderName, id: string): Promise<StockCopy> {
    this.requireEnabled();
    const provider = this.providers.find((candidate) => candidate.name === name);
    if (!provider) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "stock" } });
    }
    const photo = await provider.photo(id);
    if (!photo) {
      throw new AppError("DIRECTOR_ASSET_NOT_FOUND");
    }
    const image = await download(photo.imageUrl, provider.imageHosts);
    return {
      ...image,
      credit: {
        provider: name,
        author: photo.author,
        authorUrl: photo.authorUrl,
        pageUrl: photo.pageUrl,
      },
    };
  }

  private requireEnabled() {
    if (!this.enabled) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "stock" } });
    }
  }

  private remember(key: string, photos: StockPhoto[]) {
    if (this.cache.size >= CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, { at: this.now(), photos });
  }
}

function publicPhoto({ imageUrl: _imageUrl, ...photo }: StockResult): StockPhoto {
  return photo;
}

/** The lists' items taken in turn: the first of each, then the second of each... */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const longest = Math.max(0, ...lists.map((list) => list.length));
  return Array.from({ length: longest }, (_, index) =>
    lists.flatMap((list) => list.slice(index, index + 1)),
  ).flat();
}

/**
 * A provider's full-size image, from one of its own hosts only (the link came from the
 * provider's answer, never from the client), within MAX_COPY_BYTES.
 */
async function download(url: string, hosts: readonly string[]) {
  const parsed = new URL(url);
  if (!hosts.includes(parsed.host)) {
    throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "stock" } });
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const [contentType = ""] = (response.headers.get("content-type") ?? "").split(";");
  const extension = COPY_TYPES.get(contentType.trim());
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!response.ok || !extension || length > MAX_COPY_BYTES) {
    await response.body?.cancel();
    throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "stock" } });
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_COPY_BYTES) {
    throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "stock" } });
  }
  return { data, contentType: contentType.trim(), extension };
}
