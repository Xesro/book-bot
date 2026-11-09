import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export class FieldCipher {
  public constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error("La cle de chiffrement doit faire 32 octets.");
    }
  }

  public encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }

  public decrypt(payload: string): string {
    const [version, ivValue, tagValue, encryptedValue] = payload.split(".");
    if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) {
      throw new Error("Valeur chiffree invalide.");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  }
}
