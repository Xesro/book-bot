import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadRejectedError, FourtouticiSource } from "../src/sources/fourtoutici.js";

describe("FourtouticiSource", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("reads the public JSON API and keeps EPUB/PDF files", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        files: [
          {
            description: "Edition integrale",
            downloads: 144,
            extension: "epub",
            file_id: "import_00120_8bc86d65636f",
            has_cover: 1,
            original_name: "EBOOK Le comte de Monte-Cristo – Alexandre Dumas.epub",
            cover_v: "6de7588b",
            size: 1_625_921,
          },
          {
            description: "ignore",
            downloads: 1,
            extension: "mobi",
            file_id: "import_00121_8bc86d65636f",
            original_name: "Un autre format.mobi",
            size: 100,
          },
        ],
        has_more: false,
        success: true,
      }),
    );
    const source = new FourtouticiSource("https://fourtoutici.cc", fetcher);

    const results = await source.search("Monte Cristo Alexandre Dumas");

    expect(results).toEqual([
      {
        description: "Edition integrale",
        downloads: 144,
        extension: "epub",
        fileId: "import_00120_8bc86d65636f",
        originalName: "EBOOK Le comte de Monte-Cristo – Alexandre Dumas.epub",
        providerCoverUrl: "https://fourtoutici.cc/covers/import_00120_8bc86d65636f.webp?v=6de7588b",
        providerId: "fourtoutici",
        size: 1_625_921,
      },
    ]);
    const requestedUrl = String(fetcher.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("/backend/api/files.php?");
    expect(requestedUrl).toContain("cat=EBOOK");
  });

  it("downloads a file while enforcing the size limit", async () => {
    const payload = new TextEncoder().encode("book");
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(payload, {
          headers: { "content-length": String(payload.byteLength) },
          status: 200,
        }),
    );
    const source = new FourtouticiSource("https://fourtoutici.cc", fetcher);
    const directory = await mkdtemp(join(tmpdir(), "books-bot-test-"));
    temporaryDirectories.push(directory);
    const destination = join(directory, "book.epub");
    const book = {
      description: "",
      downloads: 1,
      extension: "epub" as const,
      fileId: "import_00120_8bc86d65636f",
      originalName: "book.epub",
      providerCoverUrl: null,
      providerId: "fourtoutici",
      size: payload.byteLength,
    };

    await source.download(book, destination, 10);
    expect(await readFile(destination, "utf8")).toBe("book");

    await expect(source.download(book, join(directory, "too-big.epub"), 3)).rejects.toThrow(
      DownloadRejectedError,
    );
  });
});
