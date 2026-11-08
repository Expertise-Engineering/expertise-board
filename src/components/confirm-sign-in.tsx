import { buttonVariants } from "@/components/ui/button";
import type { ConfirmCode, ConfirmOtp } from "@/lib/auth/callback";
import { cn } from "cn";

export function ConfirmSignIn({ decision }: { decision: ConfirmOtp | ConfirmCode }) {
  const crossBrowser = decision.method === "otp";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <div className="grid gap-3">
        <p className="text-sm font-medium tracking-wide text-primary uppercase">Expertise Engineering</p>
        <h1 className="text-4xl font-medium tracking-tight">Confirm sign-in</h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          {crossBrowser
            ? "This magic link is ready. Choose Sign in to finish. Opening the link does not sign you in, so it still works after a mail preview and in a different browser."
            : "This link uses the older sign-in flow. Choose Sign in in the same browser that requested it."}
        </p>
      </div>
      <form method="post" action="/auth/callback" autoComplete="off" className="grid gap-4 rounded-2xl border bg-card p-5 shadow-sm">
        {decision.method === "otp" ? (
          <>
            <input type="hidden" name="token_hash" value={decision.tokenHash} autoComplete="off" />
            <input type="hidden" name="type" value={decision.otpType} autoComplete="off" />
          </>
        ) : (
          <input type="hidden" name="code" value={decision.code} autoComplete="off" />
        )}
        <input type="hidden" name="next" value={decision.next} autoComplete="off" />
        <button type="submit" className={cn(buttonVariants(), "w-full")}>
          Sign in
        </button>
        <a href="/login" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Request a new link
        </a>
      </form>
    </main>
  );
}
