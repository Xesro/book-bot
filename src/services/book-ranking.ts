import type { BookSearchResult } from "../sources/types.js";

const IGNORED_WORDS = new Set([
  "a",
  "au",
  "aux",
  "de",
  "des",
  "du",
  "et",
  "la",
  "le",
  "les",
  "un",
  "une",
]);

export function rankBooks(query: string, books: BookSearchResult[], limit = 5): BookSearchResult[] {
  const normalizedQuery = normalize(query);
  const queryTokens = tokenize(normalizedQuery).filter((token) => !IGNORED_WORDS.has(token));

  return books
    .map((book, index) => {
      const name = normalize(
        book.originalName.replace(/^ebook\s+/i, "").replace(/\.(epub|pdf)$/i, ""),
      );
      const nameTokens = new Set(tokenize(name));
      const matches = queryTokens.filter((token) => nameTokens.has(token)).length;
      const coverage = queryTokens.length === 0 ? 0 : matches / queryTokens.length;
      const phraseBonus = name.includes(normalizedQuery) ? 100 : 0;
      const popularity = Math.log10(book.downloads + 1);
      return { book, index, score: coverage * 1000 + phraseBonus + popularity };
    })
    .sort((first, second) => second.score - first.score || first.index - second.index)
    .slice(0, limit)
    .map(({ book }) => book);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}
