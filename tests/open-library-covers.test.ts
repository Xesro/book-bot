import { describe, expect, it, vi } from "vitest";
import { OpenLibraryCoverSource } from "../src/sources/open-library-covers.js";

describe("OpenLibraryCoverSource", () => {
  it("finds and caches a cover from a Fourtoutici file name", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ docs: [{ cover_i: 123456 }] }));
    const covers = new OpenLibraryCoverSource(fetcher);

    const first = await covers.findCover(book(), "Le comte de Monte-Cristo Alexandre Dumas");
    const second = await covers.findCover(book(), "Le comte de Monte-Cristo Alexandre Dumas");

    expect(first).toEqual({
      sourceId: "open-library",
      url: "https://covers.openlibrary.org/b/id/123456-M.jpg?default=false",
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("q")).toBe("Le comte de Monte-Cristo Alexandre Dumas");
  });

  it("falls back without a cover when Open Library has no match", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ docs: [] }));
    const covers = new OpenLibraryCoverSource(fetcher);

    await expect(
      covers.findCover(book("Livre introuvable.pdf"), "Livre introuvable"),
    ).resolves.toBeNull();
  });
});

function book(originalName = "EBOOK Le comte de Monte-Cristo – Alexandre Dumas.epub") {
  return {
    description: "",
    downloads: 10,
    extension: "epub" as const,
    fileId: "book_123456789012345",
    originalName,
    providerCoverUrl: null,
    providerId: "test",
    size: 1000,
  };
}
