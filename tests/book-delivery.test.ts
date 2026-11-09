import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { StoredSearchResult } from "../src/db/repositories.js";
import { BookDeliveryService } from "../src/services/book-delivery.js";
import type { Mailer } from "../src/services/email-service.js";
import type { BookSource } from "../src/sources/types.js";

describe("BookDeliveryService", () => {
  it("validates, emails, and deletes the temporary PDF", async () => {
    let attachmentPath = "";
    const source: BookSource = {
      download: vi.fn(async (_book, destination) => {
        await writeFile(destination, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
      }),
      search: vi.fn(),
    };
    const mailer: Mailer = {
      sendBook: vi.fn(async (_recipient, attachment) => {
        attachmentPath = attachment.path;
        expect((await readFile(attachment.path, "utf8")).startsWith("%PDF")).toBe(true);
        expect(attachment.contentType).toBe("application/pdf");
      }),
      sendVerificationCode: vi.fn(),
    };
    const service = new BookDeliveryService(source, mailer, 1024 * 1024);

    await service.deliver(book(), "mere@example.com");

    expect(mailer.sendBook).toHaveBeenCalledOnce();
    await expect(access(attachmentPath)).rejects.toThrow();
  });
});

function book(): StoredSearchResult {
  return {
    deliveredAt: null,
    description: "",
    downloads: 144,
    expiresAt: Date.now() + 60_000,
    extension: "pdf",
    fileId: "import_00120_8bc86d65636f",
    originalName: "Le comte de Monte-Cristo – Alexandre Dumas.pdf",
    providerCoverUrl: null,
    providerId: "test",
    size: 40,
    telegramId: 42,
    token: "abcdefghijkl",
  };
}
