export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".0", "")} Mo`;
}

export function maskEmail(email: string): string {
  const [localPart = "", domain = ""] = email.split("@");
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}${"*".repeat(Math.max(3, localPart.length - visible.length))}@${domain}`;
}

export function shortBookName(name: string, maximumLength = 52): string {
  const cleaned = name
    .replace(/^EBOOK\s+/i, "")
    .replace(/\.(epub|pdf)$/i, "")
    .trim();
  return cleaned.length <= maximumLength ? cleaned : `${cleaned.slice(0, maximumLength - 1)}…`;
}
