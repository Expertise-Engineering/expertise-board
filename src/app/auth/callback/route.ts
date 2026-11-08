import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { isAllowedEmail, safeNextPath } from "@/lib/auth/email";
import { readPublicSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!readPublicSupabaseEnv()) {
    return NextResponse.redirect(new URL("/login?error=config", url.origin));
  }

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = safeNextPath(url.searchParams.get("next"));
  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL("/login?error=auth", url.origin));
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error) return NextResponse.redirect(new URL("/login?error=auth", url.origin));
  } else {
    return NextResponse.redirect(new URL("/login?error=auth", url.origin));
  }

  const { data } = await supabase.auth.getUser();
  if (!data.user?.email || !isAllowedEmail(data.user.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=domain", url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
