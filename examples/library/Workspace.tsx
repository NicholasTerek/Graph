import { useState } from "react";
import type { GraphClient } from "@graph/sdk";
export default function LibraryWorkspace({ client }: { client: GraphClient }) {
  const [result, setResult] = useState<{
    available: number;
    books: { id: string; name: string; authors: string[] }[];
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="operations">
      <h1>Library circulation</h1>
      <p>
        This application is registered by the library extension. Its calculation
        reads the same generic ontology API.
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void client
            .runFunction<NonNullable<typeof result>>(
              "library",
              "availability",
              {},
            )
            .then((run) => setResult(run.output))
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        Calculate availability
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status">
          <h2>{result.available} available books</h2>
          {result.books.map((book) => (
            <article key={book.id}>
              <strong>{book.name}</strong>
              <p>{book.authors.join(", ")}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
