// Landing page for a signed-in user whose role may not view the requested page (403).
export default function ForbiddenPage() {
  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold">403 Forbidden</h1>
      <p className="mt-2 text-sm">Your demo role cannot access that page.</p>
      <a href="/login" className="mt-4 inline-block text-sm underline">
        Switch role (demo auth)
      </a>
    </main>
  );
}
