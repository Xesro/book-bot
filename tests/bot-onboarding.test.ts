import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot/create-bot.js";
import { openDatabase, type SqliteDatabase } from "../src/db/database.js";
import { SearchResultRepository, UserRepository } from "../src/db/repositories.js";
import { FieldCipher } from "../src/security/field-cipher.js";
import { BookDeliveryService } from "../src/services/book-delivery.js";
import type { Mailer } from "../src/services/email-service.js";
import { EmailVerificationService } from "../src/services/email-verification.js";
import type { BookSource } from "../src/sources/types.js";

describe("Telegram onboarding", () => {
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("registers multiple users from the private invite and asks each for an email", async () => {
    database = openDatabase(":memory:");
    const users = new UserRepository(database);
    const searchResults = new SearchResultRepository(database);
    const cipher = new FieldCipher(Buffer.alloc(32, 3));
    const source: BookSource = {
      download: vi.fn(),
      search: vi.fn(),
    };
    const covers = {
      async *findCovers() {
        // No cover is needed by this onboarding test.
      },
    };
    const mailer: Mailer = {
      sendBook: vi.fn(),
      sendVerificationCode: vi.fn(),
    };
    const bot = createBot("123456:TEST_TOKEN", {
      botInviteToken: "private_invite_123456",
      cipher,
      covers,
      delivery: new BookDeliveryService(source, mailer, 1024 * 1024),
      logger: pino({ enabled: false }),
      mailer,
      maxAttachmentBytes: 1024 * 1024,
      searchResultTtlMinutes: 30,
      searchResults,
      source,
      users,
      verification: new EmailVerificationService(users, cipher, "h".repeat(64)),
    });
    const sentMessages: string[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            can_join_groups: false,
            can_read_all_group_messages: false,
            first_name: "Books Bot",
            id: 123456,
            is_bot: true,
            supports_inline_queries: false,
            username: "books_test_bot",
          },
        } as never;
      }
      if (method === "sendMessage") {
        sentMessages.push(String((payload as { text?: unknown }).text));
      }
      return { ok: true, result: true } as never;
    });
    await bot.init();

    await bot.handleUpdate({
      message: {
        chat: { first_name: "Maman", id: 42, type: "private" },
        date: 1_700_000_000,
        entities: [{ length: 6, offset: 0, type: "bot_command" }],
        from: { first_name: "Maman", id: 42, is_bot: false },
        message_id: 1,
        text: "/start private_invite_123456",
      },
      update_id: 1,
    });

    await bot.handleUpdate({
      message: {
        chat: { first_name: "Arthur", id: 84, type: "private" },
        date: 1_700_000_001,
        entities: [{ length: 6, offset: 0, type: "bot_command" }],
        from: { first_name: "Arthur", id: 84, is_bot: false },
        message_id: 2,
        text: "/start private_invite_123456",
      },
      update_id: 2,
    });

    expect(users.findByTelegramId(42)?.state).toBe("awaiting_email");
    expect(users.findByTelegramId(84)?.state).toBe("awaiting_email");
    expect(sentMessages.at(-1)).toContain("quelle adresse e-mail");
  });
});
