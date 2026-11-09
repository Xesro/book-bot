export interface BookSearchResult {
  description: string;
  downloads: number;
  extension: "epub" | "pdf";
  fileId: string;
  originalName: string;
  providerCoverUrl: string | null;
  providerId: string;
  size: number;
}

export interface BookSource {
  download(book: BookSearchResult, destinationPath: string, maximumBytes: number): Promise<void>;
  search(query: string): Promise<BookSearchResult[]>;
}

export interface BookCover {
  sourceId: string;
  url: string;
}

export interface BookCoverSource {
  readonly id: string;
  findCover(book: BookSearchResult, searchQuery: string): Promise<BookCover | null>;
}

export interface BookCoverResolver {
  findCovers(book: BookSearchResult, searchQuery: string): AsyncIterable<BookCover>;
}

export interface BookProvider extends BookSource {
  readonly id: string;
  findCover?(book: BookSearchResult, searchQuery: string): Promise<BookCover | null>;
}
