import { NextResponse } from "next/server";
import { normalizeRole, sessionAccess } from "@/lib/access/access";
import { isAllowedEmail } from "@/lib/auth/email";
import {
  credentialParamsFromEntries,
  isTrustedAuthPost,
  loginErrorForAuthFailure,
  loginPath,
  planAuthCallback,
  type LoginErrorCode,
} from "@/lib/auth/callback";
import { readPublicSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

function redirectTo(requestUrl: string, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, requestUrl), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function GET(request: Request) {
  return showOrReject(request, "GET");
}

export async function HEAD(request: Request) {
  const response = await showOrReject(request, "HEAD");
  return new NextResponse(null, { status: response.status, headers: response.headers });
}

async function showOrReject(request: Request, method: "GET" | "HEAD") {
  const url = new URL(request.url);
  if (!readPublicSupabaseEnv()) return redirectTo(request.url, loginPath("config"));
  const plan = planAuthCallback(method, url.searchParams);
  if (plan.consume) return redirectTo(request.url, loginPath("auth"));
  return redirectTo(request.url, plan.location);
}

export async function POST(request: Request) {
  if (!readPublicSupabaseEnv()) return redirectTo(request.url, loginPath("config"));
  if (
    !isTrustedAuthPost(request.url, {
      origin: request.headers.get("origin"),
      referer: request.headers.get("referer"),
      host: request.headers.get("host"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    })
  ) {
    return redirectTo(request.url, loginPath("auth"));
  }

  let entries: [string, string][];
  try {
    const form = await request.formData();
    entries = [];
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") entries.push([key, value]);
    }
  } catch {
    return redirectTo(request.url, loginPath("auth"));
  }

  const plan = planAuthCallback("POST", credentialParamsFromEntries(entries));
  if (!plan.consume) return redirectTo(request.url, plan.location);

  let failure: LoginErrorCode = "auth";
  try {
    const supabase = await createClient();
    const { error } =
      plan.decision.method === "otp"
        ? await supabase.auth.verifyOtp({
            token_hash: plan.decision.tokenHash,
            type: plan.decision.otpType,
          })
        : await supabase.auth.exchangeCodeForSession(plan.decision.code);
    if (error) {
      failure = loginErrorForAuthFailure(error);
    } else {
      const { data, error: userError } = await supabase.auth.getUser();
      if (userError) {
        await supabase.auth.signOut();
        failure = "unavailable";
      } else if (!data.user?.email || !isAllowedEmail(data.user.email)) {
        await supabase.auth.signOut();
        failure = "domain";
      } else {
        const { data: access, error: accessError } = await supabase
          .from("directory")
          .select("role, revoked_at")
          .eq("user_id", data.user.id)
          .maybeSingle();
        const decision = !accessError && access
          ? sessionAccess({ role: normalizeRole(access.role), revokedAt: access.revoked_at })
          : null;
        if (decision?.state === "removed") {
          await supabase.auth.signOut({ scope: "global" });
          failure = "removed";
        } else {
          return redirectTo(request.url, plan.decision.next);
        }
      }
    }
  } catch {
    failure = "unavailable";
  }

  return redirectTo(request.url, loginPath(failure));
}
