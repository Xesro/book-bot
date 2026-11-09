import { Bot, type Context, InlineKeyboard, InputFile } from "grammy";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  SearchResultRepository,
  StoredSearchResult,
  UserRepository,
} from "../db/repositories.js";
import type { FieldCipher } from "../security/field-cipher.js";
import { secretsAreEqual } from "../security/secrets.js";
import {
  type BookDeliveryService,
  BookDeliveryValidationError,
} from "../services/book-delivery.js";
import { rankBooks } from "../services/book-ranking.js";
import type { Mailer } from "../services/email-service.js";
import {
  type EmailVerificationService,
  VerificationCooldownError,
} from "../services/email-verification.js";
import { DownloadRejectedError, SourceUnavailableError } from "../sources/fourtoutici.js";
import type { BookCover, BookCoverResolver, BookSource } from "../sources/types.js";
import { formatBytes, maskEmail, shortBookName } from "../utils/format.js";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const searchSchema = z.string().trim().min(2).max(120);
const codeSchema = /^\d{6}$/;
const maximumCoverBytes = 5 * 1024 * 1024;

interface BotDependencies {
  botInviteToken: string;
  cipher: FieldCipher;
  covers: BookCoverResolver;
  delivery: BookDeliveryService;
  logger: Logger;
  mailer: Mailer;
  maxAttachmentBytes: number;
  searchResultTtlMinutes: number;
  searchResults: SearchResultRepository;
  source: BookSource;
  users: UserRepository;
  verification: EmailVerificationService;
}

export function createBot(token: string, dependencies: BotDependencies): Bot<Context> {
  const bot = new Bot(token);
  const activeDeliveries = new Set<number>();

  bot.command("start", async (context) => {
    if (!isPrivateConversation(context)) {
      await context.reply("Utilisez ce bot dans une conversation privee.");
      return;
    }

    const sender = context.from;
    if (!sender) {
      return;
    }
    const telegramId = sender.id;
    let user = dependencies.users.findByTelegramId(telegramId);
    if (!user) {
      const invitation = typeof context.match === "string" ? context.match.trim() : "";
      if (!invitation || !secretsAreEqual(invitation, dependencies.botInviteToken)) {
        await context.reply(
          "Ce bot est prive. Utilisez le lien d'invitation qui vous a ete transmis.",
        );
        return;
      }

      const displayName = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
      dependencies.users.registerUser(telegramId, displayName);
      user = dependencies.users.findByTelegramId(telegramId);
    }

    if (user?.state === "ready" && user.emailEncrypted) {
      const email = dependencies.cipher.decrypt(user.emailEncrypted);
      await context.reply(
        `Bonjour ! Votre adresse ${maskEmail(email)} est verifiee.\n\nEnvoyez-moi le titre et l'auteur du livre recherche.`,
      );
      return;
    }

    if (user?.state === "awaiting_code") {
      await context.reply("Un code a 6 chiffres vous a ete envoye par e-mail. Saisissez-le ici.");
      return;
    }

    dependencies.users.setState(telegramId, "awaiting_email");
    await context.reply(
      "Bonjour ! Pour commencer, quelle adresse e-mail dois-je utiliser pour envoyer les livres ?",
    );
  });

  bot.command(["email", "changer_email"], async (context) => {
    const telegramId = await requireAuthorizedUser(context, dependencies.users);
    if (telegramId === null) {
      return;
    }

    dependencies.users.cancelVerification(telegramId, "awaiting_email");
    await context.reply("Quelle nouvelle adresse e-mail dois-je utiliser ?");
  });

  bot.command("annuler", async (context) => {
    const telegramId = await requireAuthorizedUser(context, dependencies.users);
    if (telegramId === null) {
      return;
    }

    const user = dependencies.users.findByTelegramId(telegramId);
    const nextState = user?.emailEncrypted ? "ready" : "awaiting_email";
    dependencies.users.cancelVerification(telegramId, nextState);
    await context.reply(
      nextState === "ready"
        ? "Modification annulee. Envoyez le titre et l'auteur d'un livre."
        : "Operation annulee. Utilisez /email pour configurer votre adresse.",
    );
  });

  bot.command("supprimer_email", async (context) => {
    const telegramId = await requireAuthorizedUser(context, dependencies.users);
    if (telegramId === null) {
      return;
    }

    dependencies.users.clearVerifiedEmail(telegramId);
    await context.reply(
      "Votre adresse e-mail a ete supprimee. Utilisez /email pour en configurer une autre.",
    );
  });

  bot.command("aide", async (context) => {
    const telegramId = await requireAuthorizedUser(context, dependencies.users);
    if (telegramId === null) {
      return;
    }

    await context.reply(
      [
        "Envoyez simplement le titre et l'auteur du livre.",
        "",
        "/email ou /changer_email - modifier l'adresse d'envoi",
        "/annuler - annuler la verification en cours",
        "/supprimer_email - effacer l'adresse enregistree",
        "/aide - afficher cette aide",
      ].join("\n"),
    );
  });

  bot.callbackQuery(/^book:([A-Za-z0-9_-]{12})$/, async (context) => {
    const telegramId = await requireAuthorizedUser(context, dependencies.users, false);
    if (telegramId === null) {
      await context.answerCallbackQuery({ text: "Ce bouton n'est pas disponible." });
      return;
    }

    await context.answerCallbackQuery({ text: "Preparation du livre…" });
    const resultToken = context.match[1];
    if (!resultToken) {
      return;
    }

    const book = dependencies.searchResults.findForUser(resultToken, telegramId);
    if (!book || book.expiresAt < Date.now()) {
      await context.reply("Cette selection a expire. Relancez simplement la recherche.");
      return;
    }
    if (book.deliveredAt) {
      await context.reply("Ce livre a deja ete envoye. Relancez la recherche pour le renvoyer.");
      return;
    }
    if (activeDeliveries.has(telegramId)) {
      await context.reply("Un livre est deja en cours de preparation. Patientez un instant.");
      return;
    }

    const user = dependencies.users.findByTelegramId(telegramId);
    if (!user?.emailEncrypted) {
      dependencies.users.setState(telegramId, "awaiting_email");
      await context.reply("Votre adresse e-mail doit etre configuree avec /email.");
      return;
    }

    const email = dependencies.cipher.decrypt(user.emailEncrypted);
    activeDeliveries.add(telegramId);
    await context.reply(`Je prepare « ${shortBookName(book.originalName, 80)} »…`);

    try {
      await dependencies.delivery.deliver(book, email);
      dependencies.searchResults.markDelivered(book.token, telegramId);
      await context.reply(`Le livre a ete envoye a ${maskEmail(email)}.`);
    } catch (error) {
      dependencies.logger.error({ err: error }, "book delivery failed");
      await context.reply(userFacingDeliveryError(error));
    } finally {
      activeDeliveries.delete(telegramId);
    }
  });

  bot.on("message:text", async (context) => {
    const telegramId = await requireAuthorizedUser(context, dependencies.users);
    if (telegramId === null) {
      return;
    }

    const user = dependencies.users.findByTelegramId(telegramId);
    if (!user) {
      return;
    }

    if (user.state === "awaiting_email") {
      const emailResult = emailSchema.safeParse(context.message.text);
      if (!emailResult.success) {
        await context.reply(
          "Cette adresse e-mail ne semble pas valide. Verifiez-la puis reessayez.",
        );
        return;
      }

      try {
        const code = dependencies.verification.begin(telegramId, emailResult.data);
        try {
          await dependencies.mailer.sendVerificationCode(emailResult.data, code);
        } catch (error) {
          dependencies.verification.cancelAfterSendFailure(telegramId);
          dependencies.logger.error({ err: error }, "verification email failed");
          await context.reply("Je n'ai pas pu envoyer le code. Reessayez dans quelques instants.");
          return;
        }
        await context.reply(
          `Un code a 6 chiffres vient d'etre envoye a ${maskEmail(emailResult.data)}. Saisissez-le ici.`,
        );
      } catch (error) {
        if (error instanceof VerificationCooldownError) {
          await context.reply(error.message);
          return;
        }
        throw error;
      }
      return;
    }

    if (user.state === "awaiting_code") {
      const code = context.message.text.trim();
      if (!codeSchema.test(code)) {
        await context.reply(
          "Saisissez le code a 6 chiffres recu par e-mail, ou utilisez /annuler.",
        );
        return;
      }

      const result = dependencies.verification.verify(telegramId, code);
      switch (result.status) {
        case "verified":
          await context.reply(
            `Adresse ${maskEmail(result.email)} verifiee ! Envoyez maintenant le titre et l'auteur d'un livre.`,
          );
          break;
        case "invalid":
          await context.reply(`Code incorrect. Il reste ${result.remainingAttempts} tentative(s).`);
          break;
        case "expired":
          await context.reply("Ce code a expire. Utilisez /email pour en demander un nouveau.");
          break;
        case "locked":
          await context.reply("Trop de tentatives. Utilisez /email pour demander un nouveau code.");
          break;
        case "missing":
          await context.reply("Aucune verification n'est en cours. Utilisez /email.");
          break;
      }
      return;
    }

    const queryResult = searchSchema.safeParse(context.message.text);
    if (!queryResult.success) {
      await context.reply("Indiquez un titre et un auteur en 2 a 120 caracteres.");
      return;
    }

    const searchStartedAt = Date.now();
    dependencies.logger.debug(
      { event: "book_search_started", query: queryResult.data, telegramId },
      "book search started",
    );
    await context.reply("Je cherche dans le catalogue…");
    try {
      const found = await dependencies.source.search(queryResult.data);
      const eligible = found.filter(
        (book) => book.size > 0 && book.size <= dependencies.maxAttachmentBytes,
      );
      dependencies.logger.debug(
        {
          elapsedMs: Date.now() - searchStartedAt,
          eligibleCount: eligible.length,
          event: "catalog_search_completed",
          foundCount: found.length,
          query: queryResult.data,
          telegramId,
        },
        "catalog search completed and results were filtered",
      );
      if (eligible.length === 0) {
        await context.reply(
          found.length > 0
            ? "Des resultats existent, mais ils sont trop volumineux pour etre envoyes par e-mail."
            : "Je n'ai trouve aucun EPUB ou PDF correspondant. Essayez avec moins de mots.",
        );
        return;
      }

      const ranked = rankBooks(queryResult.data, eligible, 5);
      dependencies.logger.debug(
        {
          event: "book_results_ranked",
          query: queryResult.data,
          results: ranked.map((book) => ({
            fileId: book.fileId,
            name: book.originalName,
            size: book.size,
          })),
          telegramId,
        },
        "best catalog results selected",
      );
      const expiresAt = Date.now() + dependencies.searchResultTtlMinutes * 60 * 1000;
      dependencies.searchResults.deleteExpired();
      const stored = dependencies.searchResults.replaceForUser(telegramId, ranked, expiresAt);
      await sendSearchResults(
        context,
        stored,
        queryResult.data,
        dependencies.covers,
        dependencies.logger,
      );
    } catch (error) {
      dependencies.logger.error({ err: error }, "book search failed");
      await context.reply(
        error instanceof SourceUnavailableError
          ? error.message
          : "La recherche a echoue. Reessayez dans quelques instants.",
      );
    }
  });

  bot.catch((error) => {
    dependencies.logger.error({ err: error.error }, "unhandled Telegram update error");
  });

  return bot;
}

async function requireAuthorizedUser(
  context: Context,
  users: UserRepository,
  sendReply = true,
): Promise<number | null> {
  if (!isPrivateConversation(context) || !context.from) {
    if (sendReply && context.chat) {
      await context.reply("Utilisez ce bot dans une conversation privee.");
    }
    return null;
  }

  if (!users.findByTelegramId(context.from.id)) {
    if (sendReply) {
      await context.reply("Ce bot est prive. Ouvrez d'abord votre lien d'invitation.");
    }
    return null;
  }
  return context.from.id;
}

function isPrivateConversation(context: Context): boolean {
  return context.chat?.type === "private" && Boolean(context.from);
}

async function sendSearchResults(
  context: Context,
  results: StoredSearchResult[],
  searchQuery: string,
  covers: BookCoverResolver,
  logger: Logger,
): Promise<void> {
  const telegramId = context.from?.id;
  await context.reply("Voici les meilleurs resultats. Touchez le bouton du livre souhaite :");
  logger.debug(
    { event: "cover_batch_started", resultCount: results.length, telegramId },
    "looking up covers for Telegram results",
  );

  for (const [index, result] of results.entries()) {
    const number = index + 1;
    const caption = `${number}. ${shortBookName(result.originalName, 800)}\n${result.extension.toUpperCase()} · ${formatBytes(result.size)}`;
    const keyboard = new InlineKeyboard().text(
      "Recevoir ce livre par e-mail",
      `book:${result.token}`,
    );
    let coverSent = false;
    for await (const cover of covers.findCovers(result, searchQuery)) {
      try {
        logger.debug(
          {
            bookName: result.originalName,
            coverSourceId: cover.sourceId,
            coverUrl: cover.url,
            event: "telegram_cover_send_started",
            telegramId,
          },
          "sending book result with a cover",
        );
        const photo = await loadCoverImage(cover);
        await context.replyWithPhoto(photo, { caption, reply_markup: keyboard });
        logger.debug(
          {
            bookName: result.originalName,
            coverSourceId: cover.sourceId,
            event: "telegram_cover_sent",
            telegramId,
          },
          "Telegram displayed the book cover",
        );
        coverSent = true;
        break;
      } catch (error) {
        logger.debug(
          {
            bookName: result.originalName,
            coverSourceId: cover.sourceId,
            coverUrl: cover.url,
            err: error,
            event: "telegram_cover_rejected",
            telegramId,
          },
          "cover could not be loaded or displayed; trying the next source",
        );
      }
    }

    if (!coverSent) {
      logger.debug(
        { bookName: result.originalName, event: "telegram_cover_unavailable", telegramId },
        "no cover is available; sending a text result",
      );
      await context.reply(caption, { reply_markup: keyboard });
    }
  }

  logger.debug(
    { event: "cover_batch_completed", resultCount: results.length, telegramId },
    "all Telegram book results were sent",
  );
}

async function loadCoverImage(cover: BookCover): Promise<InputFile> {
  const url = new URL(cover.url);
  if (url.protocol !== "https:") {
    throw new Error("L'URL de couverture doit utiliser HTTPS.");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg",
      "User-Agent": "books-bot/0.1 (private-use)",
    },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`La couverture a repondu avec le statut ${response.status}.`);
  }

  const announcedLength = Number(response.headers.get("content-length") ?? "0");
  if (announcedLength > maximumCoverBytes) {
    throw new Error("La couverture est trop volumineuse pour Telegram.");
  }

  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = coverExtension(mime);
  if (!extension) {
    throw new Error(`Type de couverture non pris en charge : ${mime ?? "inconnu"}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximumCoverBytes) {
    throw new Error("La taille de la couverture est invalide.");
  }
  return new InputFile(bytes, `cover.${extension}`);
}

function coverExtension(mime: string | undefined): "jpg" | "png" | "webp" | null {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

function userFacingDeliveryError(error: unknown): string {
  if (
    error instanceof BookDeliveryValidationError ||
    error instanceof DownloadRejectedError ||
    error instanceof SourceUnavailableError
  ) {
    return error.message;
  }
  return "L'envoi du livre a echoue. Reessayez dans quelques instants.";
}
