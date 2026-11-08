"use client";

import { useState } from "react";
import { loginErrorMessage } from "@/lib/auth/callback";
import { isAllowedEmail } from "@/lib/auth/email";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ errorCode }: { errorCode?: string }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(loginErrorMessage(errorCode));
  const [sent, setSent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSent(false);
    if (!isAllowedEmail(email)) {
      setMessage("Use your @exp-eng.com email. Other domains cannot sign up or sign in.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) {
        setMessage(error.message);
      } else {
        setSent(true);
        setMessage("Check your inbox for a magic link. Open it, then choose Sign in.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send the magic link.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <div className="grid gap-3">
        <p className="text-sm font-medium tracking-wide text-primary uppercase">Expertise Engineering</p>
        <h1 className="text-4xl font-medium tracking-tight">Sign in to the board</h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          People sign in with a magic link, then confirm on the board. Only @exp-eng.com mailboxes can join. Agents do not use this page — they connect with an API key.
        </p>
      </div>
      <form onSubmit={onSubmit} className="grid gap-4 rounded-2xl border bg-card p-5 shadow-sm">
        <div className="grid gap-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            placeholder="ada@exp-eng.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending link…" : "Email me a magic link"}
        </Button>
        {message ? (
          <p role="status" className={sent ? "text-sm text-foreground" : "text-sm text-destructive"}>
            {message}
          </p>
        ) : null}
      </form>
    </main>
  );
}
