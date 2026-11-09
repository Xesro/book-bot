import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTypeFromFile } from "file-type";
import type { StoredSearchResult } from "../db/repositories.js";
import type { BookSource } from "../sources/types.js";
import type { Mailer } from "./email-service.js";

const EXPECTED_TYPES = {
  epub: { extension: "epub", mime: "application/epub+zip" },
  pdf: { extension: "pdf", mime: "application/pdf" },
} as const;

export class BookDeliveryValidationError extends Error {}

export class BookDeliveryService {
  public constructor(
    private readonly source: BookSource,
    private readonly mailer: Mailer,
    private readonly maximumBytes: number,
  ) {}

  public async deliver(book: StoredSearchResult, recipient: string): Promise<void> {
    if (book.size > this.maximumBytes) {
      throw new BookDeliveryValidationError(
        "Ce fichier est trop volumineux pour etre envoye par e-mail.",
      );
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "books-bot-"));
    const temporaryPath = join(temporaryDirectory, `book.${book.extension}`);

    try {
      await this.source.download(book, temporaryPath, this.maximumBytes);
      const actualSize = (await stat(temporaryPath)).size;
      if (actualSize > this.maximumBytes) {
        throw new BookDeliveryValidationError(
          "Ce fichier est trop volumineux pour etre envoye par e-mail.",
        );
      }

      const expected = EXPECTED_TYPES[book.extension as keyof typeof EXPECTED_TYPES];
      const detected = await fileTypeFromFile(temporaryPath);
      if (!expected || detected?.ext !== expected.extension || detected.mime !== expected.mime) {
        throw new BookDeliveryValidationError(
          "Le contenu recu ne correspond pas a un fichier EPUB ou PDF valide.",
        );
      }

      await this.mailer.sendBook(recipient, {
        contentType: expected.mime,
        filename: safeFilename(book.originalName, book.extension),
        path: temporaryPath,
      });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

function safeFilename(originalName: string, extension: string): string {
  const cleaned = originalName
    .replace(/[\r\n\0]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim()
    .slice(0, 180);
  return cleaned.toLowerCase().endsWith(`.${extension}`) ? cleaned : `${cleaned}.${extension}`;
}
