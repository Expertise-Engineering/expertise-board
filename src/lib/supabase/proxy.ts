import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail } from "@/lib/auth/email";
import { readPublicSupabaseEnv } from "@/lib/env";

function copySession(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach((cookie) => {
    to.cookies.set(cookie);
  });
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(header);
    if (value) to.headers.set(header, value);
  }
  return to;
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/mcp")) {
    return NextResponse.next({ request });
  }

  const env = readPublicSupabaseEnv();
  if (!env) {
    return NextResponse.next({ request });
  }

  const isAuthRoute = pathname.startsWith("/auth");
  const isLogin = pathname.startsWith("/login");

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([key, value]) => {
          supabaseResponse.headers.set(key, value);
        });
      },
    },
  });

  // Refresh and verify the session before any other auth decision.
  let userId: string | null = null;
  let email: string | null = null;
  try {
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    userId = typeof claims?.sub === "string" ? claims.sub : null;
    email = typeof claims?.email === "string" ? claims.email : null;
  } catch {
    if (!isLogin && !isAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("error", "unavailable");
      return copySession(supabaseResponse, NextResponse.redirect(url));
    }
    return supabaseResponse;
  }

  if (email && !isAllowedEmail(email) && pathname !== "/auth/rejected") {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/rejected";
    url.search = "";
    return copySession(supabaseResponse, NextResponse.redirect(url));
  }

  if (!userId && !isLogin && !isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const next = `${pathname}${request.nextUrl.search}`;
    if (next !== "/") url.searchParams.set("next", next);
    else url.search = "";
    return copySession(supabaseResponse, NextResponse.redirect(url));
  }

  if (userId && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return copySession(supabaseResponse, NextResponse.redirect(url));
  }

  return supabaseResponse;
}
