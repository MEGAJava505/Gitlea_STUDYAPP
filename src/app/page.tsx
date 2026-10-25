/**
 * Root page - foundation placeholder.
 *
 * This is intentionally a plain landing stub. Educational product screens
 * (student / teacher / admin panels) are delivered in later phases and must
 * build on the domain and API primitives from Tasks B and C rather than
 * reaching into Gitea or the database directly.
 */
export default function HomePage() {
  return (
    <main className="container">
      <h1>Local GitHub</h1>
      <p>Foundation scaffold. Phase 0 Gitea validation harness is available via:</p>
      <pre>
        {`docker compose --profile validation up -d gitea proxy
npm run validate:gitea
npm run validate:gitea:negative`}
      </pre>
      <a href="/api/health">Health check</a>
    </main>
  );
}
