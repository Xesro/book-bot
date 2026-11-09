import type { Logger } from "pino";
import { z } from "zod";
import type { BookCover, BookCoverSource, BookSearchResult } from "./types.js";

const searchResponseSchema = z.object({
  docs: z
    .array(
      z.object({
        cover_i: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});

interface CachedCover {
  expiresAt: number;
  url: string | null;
}

export class OpenLibraryCoverSource implements BookCoverSource {
  public readonly id = "open-library";
  private readonly cache = new Map<string, CachedCover>();

  public constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly logger?: Logger,
  ) {}

  public async findCover(book: BookSearchResult, searchQuery: string): Promise<BookCover | null> {
    const queries = [
      ...new Set([cleanBookName(searchQuery), cleanBookName(book.originalName)]),
    ].filter(Boolean);
    for (const query of queries) {
      const url = await this.findCoverUrl(query, book.originalName);
      if (url) {
        return { sourceId: this.id, url };
      }
    }
    return null;
  }

  private async findCoverUrl(query: string, originalName: string): Promise<string | null> {
    const cacheKey = query.toLocaleLowerCase("fr");
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.logger?.debug(
        { event: "cover_cache_hit", found: Boolean(cached.url), query, sourceId: this.id },
        "cover lookup served from cache",
      );
      return cached.url;
    }

    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("lang", "fr");
    url.searchParams.set("fields", "cover_i");
    url.searchParams.set("limit", "5");
    const startedAt = Date.now();
    this.logger?.debug(
      { event: "cover_lookup_started", originalName, query, sourceId: this.id },
      "searching Open Library for a cover",
    );

    try {
      const response = await this.fetcher(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "books-bot/0.1 (private-use)",
        },
        method: "GET",
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) {
        this.logger?.debug(
          {
            elapsedMs: Date.now() - startedAt,
            event: "cover_lookup_http_error",
            query,
            status: response.status,
          },
          "Open Library cover search returned an HTTP error",
        );
        this.remember(cacheKey, null);
        return null;
      }

      const parsed = searchResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        this.logger?.debug(
          {
            elapsedMs: Date.now() - startedAt,
            event: "cover_lookup_invalid_response",
            issues: parsed.error.issues,
            query,
          },
          "Open Library returned an unexpected cover response",
        );
        return null;
      }
      const coverId = parsed.data.docs.find((document) => document.cover_i)?.cover_i;
      const coverUrl = coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg?default=false`
        : null;
      this.remember(cacheKey, coverUrl);
      this.logger?.debug(
        {
          coverId: coverId ?? null,
          elapsedMs: Date.now() - startedAt,
          event: coverId ? "cover_lookup_found" : "cover_lookup_not_found",
          resultCount: parsed.data.docs.length,
          query,
        },
        coverId ? "Open Library cover found" : "Open Library returned no cover",
      );
      return coverUrl;
    } catch (error) {
      this.logger?.debug(
        {
          elapsedMs: Date.now() - startedAt,
          err: error,
          event: "cover_lookup_failed",
          query,
        },
        "Open Library cover lookup failed",
      );
      return null;
    }
  }

  private remember(cacheKey: string, url: string | null): void {
    if (this.cache.size >= 200) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      url,
    });
  }
}

function cleanBookName(bookName: string): string {
  return bookName
    .replace(/\.(?:epub|pdf)$/iu, "")
    .replace(/^\s*(?:ebook|livre)\s+/iu, "")
    .replace(/[._]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}
