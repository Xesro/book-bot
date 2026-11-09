import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { BookCatalogService } from "../src/services/book-catalog.js";
import type { BookCoverSource, BookProvider, BookSearchResult } from "../src/sources/types.js";

describe("BookCatalogService", () => {
  it("uses a provider cover before querying the public fallback", async () => {
    const fallback: BookCoverSource = {
      id: "fallback",
      findCover: vi.fn(async () => ({ sourceId: "fallback", url: "https://fallback/cover.jpg" })),
    };
    const catalog = new BookCatalogService([provider()], [fallback], pino({ enabled: false }));
    const iterator = catalog
      .findCovers(book("https://provider/cover.webp"), "Monte Cristo")
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { sourceId: "provider", url: "https://provider/cover.webp" },
    });
    expect(fallback.findCover).not.toHaveBeenCalled();
    await iterator.return?.();
  });

  it("falls back to a public cover source when providers have no image", async () => {
    const fallback: BookCoverSource = {
      id: "fallback",
      findCover: vi.fn(async () => ({ sourceId: "fallback", url: "https://fallback/cover.jpg" })),
    };
    const catalog = new BookCatalogService([provider()], [fallback], pino({ enabled: false }));
    const covers = [];

    for await (const cover of catalog.findCovers(book(null), "Monte Cristo")) {
      covers.push(cover);
    }

    expect(covers).toEqual([{ sourceId: "fallback", url: "https://fallback/cover.jpg" }]);
  });

  it("routes a download to the provider attached to the result", async () => {
    const configuredProvider = provider();
    const catalog = new BookCatalogService([configuredProvider], [], pino({ enabled: false }));

    await catalog.download(book(null), "/tmp/book.epub", 1000);

    expect(configuredProvider.download).toHaveBeenCalledOnce();
  });
});

function provider(): BookProvider {
  return {
    id: "provider",
    download: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
  };
}

function book(providerCoverUrl: string | null): BookSearchResult {
  return {
    description: "",
    downloads: 10,
    extension: "epub",
    fileId: "book_123456789012345",
    originalName: "Le comte de Monte-Cristo – Alexandre Dumas.epub",
    providerCoverUrl,
    providerId: "provider",
    size: 1000,
  };
}
