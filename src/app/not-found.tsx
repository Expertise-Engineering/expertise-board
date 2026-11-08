import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-medium">That page is not on the board</h1>
      <p className="text-muted-foreground">The project may have been renamed or removed.</p>
      <Link href="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
        Back to projects
      </Link>
    </main>
  );
}
