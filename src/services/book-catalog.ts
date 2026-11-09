import type { Logger } from "pino";
import type {
  BookCover,
  BookCoverResolver,
  BookCoverSource,
  BookProvider,
  BookSearchResult,
  BookSource,
} from "../sources/types.js";

interface CachedSearch {
  expiresAt: number;
  results: BookSearchResult[];
}

export class UnknownBookProviderError extends Error {}

export class BookCatalogService implements BookSource, BookCoverResolver {
  private readonly searches = new Map<string, CachedSearch>();

  public constructor(
    private readonly providers: BookProvider[],
    private readonly fallbackCoverSources: BookCoverSource[],
    private readonly logger: Logger,
  ) {
    const providerIds = new Set(providers.map((provider) => provider.id));
    if (providerIds.size !== providers.length) {
      throw new Error("Chaque fournisseur de livres doit avoir un identifiant unique.");
    }
  }

  public async search(query: string): Promise<BookSearchResult[]> {
    const settled = await Promise.allSettled(
      this.providers.map(async (provider) => ({
        providerId: provider.id,
        results: await provider.search(query),
      })),
    );
    const results: BookSearchResult[] = [];
    let firstFailure: unknown;

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(...outcome.value.results);
        this.logger.debug(
          {
            event: "provider_search_completed",
            providerId: outcome.value.providerId,
            resultCount: outcome.value.results.length,
          },
          "book provider search completed",
        );
      } else {
        firstFailure ??= outcome.reason;
        this.logger.warn(
          { err: outcome.reason, event: "provider_search_failed" },
          "a book provider search failed",
        );
      }
    }

    if (settled.length > 0 && settled.every((outcome) => outcome.status === "rejected")) {
      throw firstFailure;
    }

    this.rememberSearch(query, results);
    return results;
  }

  public async download(
    book: BookSearchResult,
    destinationPath: string,
    maximumBytes: number,
  ): Promise<void> {
    const provider = this.providers.find((candidate) => candidate.id === book.providerId);
    if (!provider) {
      throw new UnknownBookProviderError(
        `Le fournisseur « ${book.providerId} » n'est pas configure sur ce bot.`,
      );
    }
    await provider.download(book, destinationPath, maximumBytes);
  }

  public async *findCovers(book: BookSearchResult, searchQuery: string): AsyncIterable<BookCover> {
    const yieldedUrls = new Set<string>();
    const directCover = coverFromResult(book);
    if (directCover) {
      yieldedUrls.add(directCover.url);
      this.logger.debug(
        {
          event: "provider_cover_available",
          providerId: book.providerId,
          url: directCover.url,
        },
        "book provider supplied its own cover",
      );
      yield directCover;
    }

    const originalProvider = this.providers.find((provider) => provider.id === book.providerId);
    if (originalProvider?.findCover) {
      const resolved = await this.findProviderCover(originalProvider, book, searchQuery);
      if (resolved && !yieldedUrls.has(resolved.url)) {
        yieldedUrls.add(resolved.url);
        yield resolved;
      }
    }

    const crossProvider = this.findCachedProviderCover(book, searchQuery);
    if (crossProvider && !yieldedUrls.has(crossProvider.url)) {
      yieldedUrls.add(crossProvider.url);
      yield crossProvider;
    }

    for (const provider of this.providers) {
      if (provider.id === book.providerId || !provider.findCover) {
        continue;
      }
      const resolved = await this.findProviderCover(provider, book, searchQuery);
      if (resolved && !yieldedUrls.has(resolved.url)) {
        yieldedUrls.add(resolved.url);
        yield resolved;
      }
    }

    for (const fallback of this.fallbackCoverSources) {
      const resolved = await fallback.findCover(book, searchQuery);
      if (resolved && !yieldedUrls.has(resolved.url)) {
        yieldedUrls.add(resolved.url);
        this.logger.debug(
          { event: "fallback_cover_available", sourceId: resolved.sourceId, url: resolved.url },
          "fallback cover source supplied a cover",
        );
        yield resolved;
      }
    }
  }

  private async findProviderCover(
    provider: BookProvider,
    book: BookSearchResult,
    searchQuery: string,
  ): Promise<BookCover | null> {
    try {
      return (await provider.findCover?.(book, searchQuery)) ?? null;
    } catch (error) {
      this.logger.debug(
        { err: error, event: "provider_cover_lookup_failed", providerId: provider.id },
        "book provider cover lookup failed",
      );
      return null;
    }
  }

  private findCachedProviderCover(book: BookSearchResult, searchQuery: string): BookCover | null {
    const cached = this.searches.get(normalize(searchQuery));
    if (!cached || cached.expiresAt <= Date.now()) {
      return null;
    }

    const candidates = cached.results
      .filter(
        (candidate) =>
          candidate.providerCoverUrl &&
          (candidate.providerId !== book.providerId || candidate.fileId !== book.fileId),
      )
      .map((candidate) => ({ candidate, score: titleSimilarity(book, candidate) }))
      .filter(({ score }) => score >= 0.6)
      .sort((first, second) => second.score - first.score);
    const best = candidates[0]?.candidate;
    if (!best?.providerCoverUrl) {
      return null;
    }

    this.logger.debug(
      {
        event: "cross_provider_cover_match",
        matchedBook: best.originalName,
        providerId: best.providerId,
        requestedBook: book.originalName,
      },
      "using a matching cover returned by another provider result",
    );
    return { sourceId: best.providerId, url: best.providerCoverUrl };
  }

  private rememberSearch(query: string, results: BookSearchResult[]): void {
    if (this.searches.size >= 30) {
      const oldestKey = this.searches.keys().next().value;
      if (oldestKey) {
        this.searches.delete(oldestKey);
      }
    }
    this.searches.set(normalize(query), {
      expiresAt: Date.now() + 10 * 60 * 1000,
      results,
    });
  }
}

function coverFromResult(book: BookSearchResult): BookCover | null {
  return book.providerCoverUrl ? { sourceId: book.providerId, url: book.providerCoverUrl } : null;
}

function titleSimilarity(first: BookSearchResult, second: BookSearchResult): number {
  const firstTokens = tokens(first.originalName);
  const secondTokens = new Set(tokens(second.originalName));
  if (firstTokens.length === 0 || secondTokens.size === 0) {
    return 0;
  }
  const matches = firstTokens.filter((token) => secondTokens.has(token)).length;
  return matches / Math.max(firstTokens.length, secondTokens.size);
}

function tokens(value: string): string[] {
  return normalize(value)
    .replace(/\b(?:ebook|epub|pdf|livre)\b/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length >= 2);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}
