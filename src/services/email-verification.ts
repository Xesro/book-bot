import { createHmac, randomInt } from "node:crypto";
import type { UserRepository } from "../db/repositories.js";
import type { FieldCipher } from "../security/field-cipher.js";
import { secretsAreEqual } from "../security/secrets.js";

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

export class VerificationCooldownError extends Error {}

export type VerificationResult =
  | { email: string; status: "verified" }
  | { remainingAttempts: number; status: "invalid" }
  | { status: "expired" | "locked" | "missing" };

export class EmailVerificationService {
  public constructor(
    private readonly users: UserRepository,
    private readonly cipher: FieldCipher,
    private readonly hmacSecret: string,
  ) {}

  public begin(telegramId: number, email: string, now = Date.now()): string {
    const previous = this.users.findVerification(telegramId);
    if (previous && now - previous.sentAt < RESEND_COOLDOWN_MS) {
      throw new VerificationCooldownError(
        "Un code vient deja d'etre envoye. Patientez une minute.",
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = now + CODE_LIFETIME_MS;
    this.users.saveVerification({
      attempts: 0,
      codeMac: this.codeMac(telegramId, expiresAt, code),
      expiresAt,
      pendingEmailEncrypted: this.cipher.encrypt(email),
      sentAt: now,
      telegramId,
    });
    return code;
  }

  public cancelAfterSendFailure(telegramId: number): void {
    this.users.cancelVerification(telegramId, this.fallbackState(telegramId));
  }

  public verify(telegramId: number, code: string, now = Date.now()): VerificationResult {
    const record = this.users.findVerification(telegramId);
    if (!record) {
      return { status: "missing" };
    }

    if (record.expiresAt < now) {
      this.users.cancelVerification(telegramId, this.fallbackState(telegramId));
      return { status: "expired" };
    }

    const actualMac = this.codeMac(telegramId, record.expiresAt, code);
    if (!secretsAreEqual(actualMac, record.codeMac)) {
      const attempts = this.users.incrementVerificationAttempts(telegramId);
      if (attempts >= MAX_ATTEMPTS) {
        this.users.cancelVerification(telegramId, this.fallbackState(telegramId));
        return { status: "locked" };
      }
      return { remainingAttempts: MAX_ATTEMPTS - attempts, status: "invalid" };
    }

    const email = this.cipher.decrypt(record.pendingEmailEncrypted);
    this.users.completeVerification(telegramId, record.pendingEmailEncrypted);
    return { email, status: "verified" };
  }

  private codeMac(telegramId: number, expiresAt: number, code: string): string {
    return createHmac("sha256", this.hmacSecret)
      .update(`${telegramId}:${expiresAt}:${code}`)
      .digest("hex");
  }

  private fallbackState(telegramId: number): "awaiting_email" | "ready" {
    return this.users.findByTelegramId(telegramId)?.emailEncrypted ? "ready" : "awaiting_email";
  }
}
