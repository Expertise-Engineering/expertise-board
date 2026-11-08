"use client";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-medium">The board could not load</h1>
      <p className="text-muted-foreground">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="h-9 w-fit rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
      >
        Try again
      </button>
    </main>
  );
}
