import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/db/database.js";
import { UserRepository } from "../src/db/repositories.js";
import { FieldCipher } from "../src/security/field-cipher.js";
import {
  EmailVerificationService,
  VerificationCooldownError,
} from "../src/services/email-verification.js";

describe("EmailVerificationService", () => {
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("verifies a code and stores an encrypted email", () => {
    const { cipher, service, users } = createService();
    const now = 1_700_000_000_000;
    const code = service.begin(42, "mere@example.com", now);

    const result = service.verify(42, code, now + 1_000);

    expect(result).toEqual({ email: "mere@example.com", status: "verified" });
    const user = users.findByTelegramId(42);
    expect(user?.state).toBe("ready");
    expect(user?.emailEncrypted).not.toContain("mere@example.com");
    expect(cipher.decrypt(user?.emailEncrypted ?? "")).toBe("mere@example.com");
  });

  it("locks verification after five invalid attempts", () => {
    const { service, users } = createService();
    const now = 1_700_000_000_000;
    const code = service.begin(42, "mere@example.com", now);
    const wrongCode = code === "000000" ? "000001" : "000000";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(service.verify(42, wrongCode, now + attempt + 1).status).toBe("invalid");
    }
    expect(service.verify(42, wrongCode, now + 10).status).toBe("locked");
    expect(users.findByTelegramId(42)?.state).toBe("awaiting_email");
  });

  it("prevents immediate code resends", () => {
    const { service } = createService();
    const now = 1_700_000_000_000;
    service.begin(42, "mere@example.com", now);

    expect(() => service.begin(42, "mere@example.com", now + 30_000)).toThrow(
      VerificationCooldownError,
    );
  });

  function createService(): {
    cipher: FieldCipher;
    service: EmailVerificationService;
    users: UserRepository;
  } {
    database = openDatabase(":memory:");
    const users = new UserRepository(database);
    users.registerUser(42, "Maman");
    const cipher = new FieldCipher(Buffer.alloc(32, 7));
    const service = new EmailVerificationService(users, cipher, "x".repeat(64));
    return { cipher, service, users };
  }
});
