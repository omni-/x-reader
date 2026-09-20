import { AsyncLocalStorage } from "node:async_hooks";
import { ZodError } from "zod";

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
  if (error instanceof ZodError)
    return {
      code: "invalid_input",
      message:
        "Check the tool arguments against its schema, including query length, sort, limits and cursor format.",
    };
  if (
    ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "")
  )
    return {
      code: "local_permission",
      message:
        "The OS denied a local browser or file operation. Check process-launch and dedicated-profile permissions, then run npm run diagnostics.",
    };
  // Browser/HTTP exception strings can contain headers, page content or local paths.
  return {
    code: "internal_error",
    message:
      "Unexpected local failure. Use the request ID in the server log and run npm run diagnostics. Browser exception contents are redacted.",
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

export const requestContext = new AsyncLocalStorage<string>();
export function logEvent(fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      request_id: requestContext.getStore(),
      ...fields,
    }),
  );
}
