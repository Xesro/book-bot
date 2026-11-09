import pino from "pino";
import { createBot } from "./bot/create-bot.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { SearchResultRepository, UserRepository } from "./db/repositories.js";
import { FieldCipher } from "./security/field-cipher.js";
import { BookCatalogService } from "./services/book-catalog.js";
import { BookDeliveryService } from "./services/book-delivery.js";
import { EmailService } from "./services/email-service.js";
import { EmailVerificationService } from "./services/email-verification.js";
import { FourtouticiSource } from "./sources/fourtoutici.js";
import { OpenLibraryCoverSource } from "./sources/open-library-covers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    base: undefined,
    level: config.logLevel,
    redact: {
      censor: "[REDACTED]",
      paths: ["email", "code", "token", "*.email", "*.code", "*.token"],
    },
  });
  const database = openDatabase(config.databasePath);
  const users = new UserRepository(database);
  const searchResults = new SearchResultRepository(database);
  const cipher = new FieldCipher(config.emailEncryptionKey);
  const fourtoutici = new FourtouticiSource(config.fourtouticiBaseUrl);
  const openLibrary = new OpenLibraryCoverSource(fetch, logger);
  const catalog = new BookCatalogService([fourtoutici], [openLibrary], logger);
  const mailer = new EmailService({
    ...config.smtp,
    from: config.mailFrom,
  });
  const verification = new EmailVerificationService(users, cipher, config.otpHmacSecret);
  const delivery = new BookDeliveryService(catalog, mailer, config.maxAttachmentBytes);
  const bot = createBot(config.telegramBotToken, {
    botInviteToken: config.botInviteToken,
    cipher,
    covers: catalog,
    delivery,
    logger,
    mailer,
    maxAttachmentBytes: config.maxAttachmentBytes,
    searchResultTtlMinutes: config.searchResultTtlMinutes,
    searchResults,
    source: catalog,
    users,
    verification,
  });

  if (!config.skipSmtpVerify) {
    await mailer.verifyConnection();
  }

  await bot.init();
  await bot.api.setMyCommands([
    { command: "email", description: "Configurer ou modifier l'adresse e-mail" },
    { command: "annuler", description: "Annuler l'operation en cours" },
    { command: "supprimer_email", description: "Supprimer l'adresse enregistree" },
    { command: "aide", description: "Afficher l'aide" },
  ]);

  const shutdown = (): void => {
    bot.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  logger.info({ bot: bot.botInfo.username }, "books bot started");
  await bot.start({ drop_pending_updates: true });
  database.close();
}

main().catch((error: unknown) => {
  const logger = pino({ base: undefined });
  logger.fatal({ err: error }, "books bot failed to start");
  process.exitCode = 1;
});
