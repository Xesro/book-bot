import { describe, expect, it } from "vitest";
import { rankBooks } from "../src/services/book-ranking.js";
import type { BookSearchResult } from "../src/sources/types.js";

describe("rankBooks", () => {
  it("puts the title and author match before fuzzy API results", () => {
    const books: BookSearchResult[] = [
      book("EBOOK Montecristo – Martin Suter.epub", 100),
      book("EBOOK Le comte de Monte-Cristo – Alexandre Dumas.epub", 10),
      book("EBOOK Le monde selon Dumas.epub", 500),
    ];

    const ranked = rankBooks("Le comte de Monte Cristo Alexandre Dumas", books);

    expect(ranked[0]?.originalName).toContain("Alexandre Dumas");
  });
});

function book(originalName: string, downloads: number): BookSearchResult {
  return {
    description: "",
    downloads,
    extension: "epub",
    fileId: `import_${downloads.toString().padStart(12, "0")}`,
    originalName,
    providerCoverUrl: null,
    providerId: "test",
    size: 1000,
  };
}
