import { safeNextPath } from "./email.ts";

/**
 * Sign-in links land on `/auth/callback` as a GET. Mail scanners follow that
 * GET, so the token is only exchanged on a same-origin POST from the confirm page.
 */

export const LOGIN_ERROR_MESSAGES = {
  domain: "Only @exp-eng.com addresses can use this board. That sign-in was stopped.",
  auth: "That magic link could not be confirmed. Request a new one.",
  expired: "That magic link has expired or was already used. Request a new one.",
  pkce: "That link has to be confirmed in the browser that requested it. Request a new one and open it there.",
  config: "Supabase is not configured yet.",
  unavailable: "The auth service did not respond. Try again in a moment.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

const EMAIL_OTP_TYPES = ["email", "magiclink", "signup", "invite", "recovery", "email_change"] as const;

export type EmailOtpTypeName = (typeof EMAIL_OTP_TYPES)[number];

const EXPIRED_ERROR_CODES = new Set(["otp_expired", "flow_state_expired", "flow_state_not_found"]);

const CREDENTIAL_KEYS = ["token_hash", "type", "code", "next"] as const;

export type ConfirmOtp = {
  action: "confirm";
  method: "otp";
  tokenHash: string;
  otpType: EmailOtpTypeName;
  next: string;
};

export type ConfirmCode = {
  action: "confirm";
  method: "code";
  code: string;
  next: string;
};

export type AuthCallbackDecision = ConfirmOtp | ConfirmCode | { action: "login"; error: LoginErrorCode };

export type AuthCallbackPlan =
  | { consume: false; location: string }
  | { consume: true; decision: ConfirmOtp | ConfirmCode };

export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (Object.prototype.hasOwnProperty.call(LOGIN_ERROR_MESSAGES, code)) {
    return LOGIN_ERROR_MESSAGES[code as LoginErrorCode];
  }
  return "Sign-in failed.";
}

export function loginErrorForAuthFailure(error: { code?: string | null; message?: string | null }): LoginErrorCode {
  const code = error.code?.trim().toLowerCase() ?? "";
  const message = error.message ?? "";
  if (EXPIRED_ERROR_CODES.has(code) || /expired|one-time token not found|already been used/i.test(message)) {
    return "expired";
  }
  if (code === "bad_code_verifier" || /code verifier|pkce/i.test(message)) {
    return "pkce";
  }
  return "auth";
}

export function classifyAuthCallback(params: URLSearchParams): AuthCallbackDecision {
  const next = safeNextPath(params.get("next"));
  const tokenHash = credential(params.get("token_hash"));
  const otpType = emailOtpType(params.get("type"));
  if (tokenHash && otpType) {
    return { action: "confirm", method: "otp", tokenHash, otpType, next };
  }

  const code = credential(params.get("code"));
  if (code) {
    return { action: "confirm", method: "code", code, next };
  }

  const failure = params.get("error_code") || params.get("error") || params.get("error_description");
  if (failure) {
    return {
      action: "login",
      error: loginErrorForAuthFailure({
        code: params.get("error_code"),
        message: params.get("error_description") || params.get("error"),
      }),
    };
  }

  return { action: "login", error: "auth" };
}

export function planAuthCallback(method: "GET" | "HEAD" | "POST", params: URLSearchParams): AuthCallbackPlan {
  const decision = classifyAuthCallback(params);
  if (method !== "POST" || decision.action !== "confirm") {
    return {
      consume: false,
      location: decision.action === "confirm" ? confirmPath(decision) : loginPath(decision.error),
    };
  }
  return { consume: true, decision };
}

export function confirmPath(decision: ConfirmOtp | ConfirmCode): string {
  const params = new URLSearchParams();
  if (decision.method === "otp") {
    params.set("token_hash", decision.tokenHash);
    params.set("type", decision.otpType);
  } else {
    params.set("code", decision.code);
  }
  if (decision.next !== "/") params.set("next", decision.next);
  return `/auth/confirm?${params.toString()}`;
}

export function loginPath(error: LoginErrorCode): string {
  return `/login?error=${error}`;
}

export function credentialParamsFromEntries(entries: Iterable<[string, string]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if ((CREDENTIAL_KEYS as readonly string[]).includes(key) && !params.has(key)) {
      params.append(key, value);
    }
  }
  return params;
}

export function isTrustedAuthPost(
  requestUrl: string,
  headers: { origin: string | null; referer: string | null; host: string | null; secFetchSite: string | null },
): boolean {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    return false;
  }

  const site = headers.secFetchSite?.trim().toLowerCase() || null;
  if (site === "cross-site" || site === "same-site") return false;
  // Chrome sends Origin: null for a same-origin form when the page asks not to
  // leak the URL. Sec-Fetch-Site is set by the browser and cannot be forged from
  // another site, so a same-origin form is the confirmation click.
  if (site === "same-origin") return true;

  const allowed = new Set<string>([requestOrigin]);
  if (headers.host) {
    try {
      allowed.add(new URL(`${new URL(requestUrl).protocol}//${headers.host}`).origin);
    } catch {
      return false;
    }
  }

  if (headers.origin) return allowed.has(headers.origin);
  if (!headers.referer) return false;
  try {
    return allowed.has(new URL(headers.referer).origin);
  } catch {
    return false;
  }
}

function credential(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 2048) return null;
  if (/[\u0000-\u001f\u007f<>]/.test(trimmed)) return null;
  return trimmed;
}

function emailOtpType(value: string | null): EmailOtpTypeName | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return (EMAIL_OTP_TYPES as readonly string[]).includes(normalized) ? (normalized as EmailOtpTypeName) : null;
}
