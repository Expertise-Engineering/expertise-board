export const COMPANY_DOMAIN = "exp-eng.com";

const EMAIL_PATTERN = /^[^@\s]+@exp-eng\.com$/;

export function isAllowedEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim().toLowerCase());
}

export function displayNameFromEmail(email: string): string {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  return local || email.trim();
}

export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}
