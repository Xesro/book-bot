import { randomBytes } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export type UserState = "awaiting_email" | "awaiting_code" | "ready";

export interface UserRecord {
  displayName: string;
  emailEncrypted: string | null;
  emailVerifiedAt: number | null;
  state: UserState;
  telegramId: number;
}

export interface VerificationRecord {
  attempts: number;
  codeMac: string;
  expiresAt: number;
  pendingEmailEncrypted: string;
  sentAt: number;
  telegramId: number;
}

export interface StoredSearchResult {
  deliveredAt: number | null;
  description: string;
  downloads: number;
  expiresAt: number;
  extension: "epub" | "pdf";
  fileId: string;
  originalName: string;
  providerCoverUrl: string | null;
  providerId: string;
  size: number;
  telegramId: number;
  token: string;
}

interface UserRow {
  display_name: string;
  email_encrypted: string | null;
  email_verified_at: number | null;
  state: UserState;
  telegram_id: number;
}

interface VerificationRow {
  attempts: number;
  code_mac: string;
  expires_at: number;
  pending_email_encrypted: string;
  sent_at: number;
  telegram_id: number;
}

interface SearchResultRow {
  delivered_at: number | null;
  description: string;
  downloads: number;
  expires_at: number;
  extension: string;
  file_id: string;
  original_name: string;
  provider_cover_url: string | null;
  provider_id: string;
  size: number;
  telegram_id: number;
  token: string;
}

export class UserRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public registerUser(telegramId: number, displayName: string): void {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO users
          (telegram_id, display_name, state, created_at, updated_at)
         VALUES (?, ?, 'awaiting_email', ?, ?)
         ON CONFLICT(telegram_id) DO NOTHING`,
      )
      .run(telegramId, displayName, now, now);
  }

  public findByTelegramId(telegramId: number): UserRecord | null {
    const row = this.database
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  public setState(telegramId: number, state: UserState): void {
    this.database
      .prepare("UPDATE users SET state = ?, updated_at = ? WHERE telegram_id = ?")
      .run(state, Date.now(), telegramId);
  }

  public saveVerification(record: VerificationRecord): void {
    const save = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO email_verifications
            (telegram_id, pending_email_encrypted, code_mac, expires_at, attempts, sent_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(telegram_id) DO UPDATE SET
             pending_email_encrypted = excluded.pending_email_encrypted,
             code_mac = excluded.code_mac,
             expires_at = excluded.expires_at,
             attempts = excluded.attempts,
             sent_at = excluded.sent_at`,
        )
        .run(
          record.telegramId,
          record.pendingEmailEncrypted,
          record.codeMac,
          record.expiresAt,
          record.attempts,
          record.sentAt,
        );
      this.setState(record.telegramId, "awaiting_code");
    });
    save();
  }

  public findVerification(telegramId: number): VerificationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM email_verifications WHERE telegram_id = ?")
      .get(telegramId) as VerificationRow | undefined;
    return row ? mapVerification(row) : null;
  }

  public incrementVerificationAttempts(telegramId: number): number {
    this.database
      .prepare("UPDATE email_verifications SET attempts = attempts + 1 WHERE telegram_id = ?")
      .run(telegramId);
    return this.findVerification(telegramId)?.attempts ?? 0;
  }

  public cancelVerification(telegramId: number, nextState: UserState): void {
    const cancel = this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM email_verifications WHERE telegram_id = ?")
        .run(telegramId);
      this.setState(telegramId, nextState);
    });
    cancel();
  }

  public completeVerification(telegramId: number, emailEncrypted: string): void {
    const complete = this.database.transaction(() => {
      const now = Date.now();
      this.database
        .prepare(
          `UPDATE users
           SET email_encrypted = ?, email_verified_at = ?, state = 'ready', updated_at = ?
           WHERE telegram_id = ?`,
        )
        .run(emailEncrypted, now, now, telegramId);
      this.database
        .prepare("DELETE FROM email_verifications WHERE telegram_id = ?")
        .run(telegramId);
    });
    complete();
  }

  public clearVerifiedEmail(telegramId: number): void {
    const clear = this.database.transaction(() => {
      const now = Date.now();
      this.database
        .prepare("DELETE FROM email_verifications WHERE telegram_id = ?")
        .run(telegramId);
      this.database.prepare("DELETE FROM search_results WHERE telegram_id = ?").run(telegramId);
      this.database
        .prepare(
          `UPDATE users
           SET email_encrypted = NULL, email_verified_at = NULL, state = 'awaiting_email', updated_at = ?
           WHERE telegram_id = ?`,
        )
        .run(now, telegramId);
    });
    clear();
  }
}

export class SearchResultRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public replaceForUser(
    telegramId: number,
    results: Array<Omit<StoredSearchResult, "deliveredAt" | "expiresAt" | "telegramId" | "token">>,
    expiresAt: number,
  ): StoredSearchResult[] {
    const replace = this.database.transaction(() => {
      this.database.prepare("DELETE FROM search_results WHERE telegram_id = ?").run(telegramId);
      const insert = this.database.prepare(
        `INSERT INTO search_results
          (token, telegram_id, provider_id, file_id, original_name, provider_cover_url,
           extension, size, description, downloads, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      return results.map((result) => {
        const stored: StoredSearchResult = {
          ...result,
          deliveredAt: null,
          expiresAt,
          telegramId,
          token: randomBytes(9).toString("base64url"),
        };
        insert.run(
          stored.token,
          stored.telegramId,
          stored.providerId,
          stored.fileId,
          stored.originalName,
          stored.providerCoverUrl,
          stored.extension,
          stored.size,
          stored.description,
          stored.downloads,
          stored.expiresAt,
        );
        return stored;
      });
    });
    return replace();
  }

  public findForUser(token: string, telegramId: number): StoredSearchResult | null {
    const row = this.database
      .prepare("SELECT * FROM search_results WHERE token = ? AND telegram_id = ?")
      .get(token, telegramId) as SearchResultRow | undefined;
    return row ? mapSearchResult(row) : null;
  }

  public markDelivered(token: string, telegramId: number): void {
    this.database
      .prepare("UPDATE search_results SET delivered_at = ? WHERE token = ? AND telegram_id = ?")
      .run(Date.now(), token, telegramId);
  }

  public deleteExpired(now = Date.now()): void {
    this.database.prepare("DELETE FROM search_results WHERE expires_at < ?").run(now);
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    displayName: row.display_name,
    emailEncrypted: row.email_encrypted,
    emailVerifiedAt: row.email_verified_at,
    state: row.state,
    telegramId: row.telegram_id,
  };
}

function mapVerification(row: VerificationRow): VerificationRecord {
  return {
    attempts: row.attempts,
    codeMac: row.code_mac,
    expiresAt: row.expires_at,
    pendingEmailEncrypted: row.pending_email_encrypted,
    sentAt: row.sent_at,
    telegramId: row.telegram_id,
  };
}

function mapSearchResult(row: SearchResultRow): StoredSearchResult {
  if (row.extension !== "epub" && row.extension !== "pdf") {
    throw new Error(`Extension stockee invalide: ${row.extension}`);
  }
  return {
    deliveredAt: row.delivered_at,
    description: row.description,
    downloads: row.downloads,
    expiresAt: row.expires_at,
    extension: row.extension,
    fileId: row.file_id,
    originalName: row.original_name,
    providerCoverUrl: row.provider_cover_url,
    providerId: row.provider_id,
    size: row.size,
    telegramId: row.telegram_id,
    token: row.token,
  };
}
