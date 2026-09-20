export class ReaderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ReaderError)
    return { code: error.code, message: error.message };
  // Browser/HTTP exception strings can contain headers, page content or local paths.
  return {
    code: "internal_error",
    message:
      "Unexpected local failure. Run npm run diagnostics; no browser details were logged.",
  };
}

export function logFailure(error: unknown): void {
  const safe = publicError(error);
  console.error(
    JSON.stringify({
      level: safe.code === "internal_error" ? "error" : "warn",
      ...safe,
    }),
  );
}
