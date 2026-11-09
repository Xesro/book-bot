import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  BOT_INVITE_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  EMAIL_ENCRYPTION_KEY: z.string().min(1),
  OTP_HMAC_SECRET: z.string().min(32),
  DATABASE_PATH: z.string().min(1).default("./data/books-bot.sqlite"),
  FOURTOUTICI_BASE_URL: z.url().default("https://fourtoutici.cc"),
  MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(25 * 1024 * 1024)
    .default(18 * 1024 * 1024),
  SEARCH_RESULT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanFromString,
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  SKIP_SMTP_VERIFY: booleanFromString,
});

export interface AppConfig {
  botInviteToken: string;
  databasePath: string;
  emailEncryptionKey: Buffer;
  fourtouticiBaseUrl: string;
  logLevel: string;
  mailFrom: string;
  maxAttachmentBytes: number;
  nodeEnv: "development" | "test" | "production";
  otpHmacSecret: string;
  searchResultTtlMinutes: number;
  skipSmtpVerify: boolean;
  smtp: {
    host: string;
    pass: string;
    port: number;
    secure: boolean;
    user: string;
  };
  telegramBotToken: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(environment);
  const emailEncryptionKey = Buffer.from(parsed.EMAIL_ENCRYPTION_KEY, "base64");

  if (emailEncryptionKey.length !== 32) {
    throw new Error("EMAIL_ENCRYPTION_KEY doit contenir exactement 32 octets encodes en base64.");
  }

  return {
    botInviteToken: parsed.BOT_INVITE_TOKEN,
    databasePath: parsed.DATABASE_PATH,
    emailEncryptionKey,
    fourtouticiBaseUrl: parsed.FOURTOUTICI_BASE_URL.replace(/\/$/, ""),
    logLevel: parsed.LOG_LEVEL,
    mailFrom: parsed.MAIL_FROM,
    maxAttachmentBytes: parsed.MAX_ATTACHMENT_BYTES,
    nodeEnv: parsed.NODE_ENV,
    otpHmacSecret: parsed.OTP_HMAC_SECRET,
    searchResultTtlMinutes: parsed.SEARCH_RESULT_TTL_MINUTES,
    skipSmtpVerify: parsed.SKIP_SMTP_VERIFY,
    smtp: {
      host: parsed.SMTP_HOST,
      pass: parsed.SMTP_PASS,
      port: parsed.SMTP_PORT,
      secure: parsed.SMTP_SECURE,
      user: parsed.SMTP_USER,
    },
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
  };
}
