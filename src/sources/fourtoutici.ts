import { open } from "node:fs/promises";
import { z } from "zod";
import type { BookProvider, BookSearchResult } from "./types.js";

const fileSchema = z.object({
  description: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  downloads: z.coerce.number().int().nonnegative().catch(0),
  extension: z.string().toLowerCase(),
  file_id: z.string().regex(/^[A-Za-z0-9_-]{12,80}$/),
  has_cover: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .optional()
    .catch(false),
  original_name: z.string().min(1).max(500),
  cover_v: z
    .string()
    .regex(/^[a-f0-9]{8}$/)
    .nullish(),
  size: z.coerce.number().int().nonnegative(),
});

const responseSchema = z.object({
  files: z.array(fileSchema).default([]),
  has_more: z.boolean().optional(),
  success: z.literal(true),
});

export class SourceUnavailableError extends Error {}
export class DownloadRejectedError extends Error {}

export class FourtouticiSource implements BookProvider {
  public readonly id = "fourtoutici";

  public constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async search(query: string): Promise<BookSearchResult[]> {
    const url = new URL("/backend/api/files.php", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("cat", "EBOOK");

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "books-bot/0.1 (private-use)",
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      throw new SourceUnavailableError("Le catalogue est momentanement indisponible.", {
        cause: error,
      });
    }

    if (response.status === 403 || response.status === 429) {
      throw new SourceUnavailableError(
        "Le catalogue demande de patienter avant une nouvelle recherche.",
      );
    }
    if (!response.ok) {
      throw new SourceUnavailableError(`Le catalogue a repondu avec le statut ${response.status}.`);
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new SourceUnavailableError("Le catalogue a renvoye une reponse inattendue.");
    }

    return parsed.data.files.flatMap((file): BookSearchResult[] => {
      if (file.extension !== "epub" && file.extension !== "pdf") {
        return [];
      }

      return [
        {
          description: file.description,
          downloads: file.downloads,
          extension: file.extension,
          fileId: file.file_id,
          originalName: file.original_name,
          providerCoverUrl: this.coverUrl(file.file_id, Boolean(file.has_cover), file.cover_v),
          providerId: this.id,
          size: file.size,
        },
      ];
    });
  }

  public async download(
    book: BookSearchResult,
    destinationPath: string,
    maximumBytes: number,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(book.fileId)) {
      throw new DownloadRejectedError("Identifiant de fichier invalide.");
    }

    const url = new URL("/backend/api/download.php", this.baseUrl);
    url.searchParams.set("file_id", book.fileId);

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "books-bot/0.1 (private-use)",
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new SourceUnavailableError("Le telechargement a echoue.", { cause: error });
    }

    if (!response.ok || !response.body) {
      throw new SourceUnavailableError(
        `Le telechargement a repondu avec le statut ${response.status}.`,
      );
    }

    const announcedLength = Number(response.headers.get("content-length") ?? "0");
    if (announcedLength > maximumBytes) {
      await response.body.cancel();
      throw new DownloadRejectedError(
        "Le fichier est trop volumineux pour etre envoye par e-mail.",
      );
    }

    const reader = response.body.getReader();
    const file = await open(destinationPath, "wx", 0o600);
    let receivedBytes = 0;

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }

        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel();
          throw new DownloadRejectedError(
            "Le fichier est trop volumineux pour etre envoye par e-mail.",
          );
        }
        await file.write(chunk.value);
      }
    } finally {
      await file.close();
    }

    if (receivedBytes === 0) {
      throw new DownloadRejectedError("Le fichier telecharge est vide.");
    }
  }

  private coverUrl(
    fileId: string,
    hasCover: boolean,
    coverVersion: string | null | undefined,
  ): string | null {
    if (!hasCover || !/^[A-Za-z0-9_-]{20,64}$/.test(fileId)) {
      return null;
    }
    const url = new URL(`/covers/${fileId}.webp`, this.baseUrl);
    if (coverVersion) {
      url.searchParams.set("v", coverVersion);
    }
    return url.toString();
  }
}
