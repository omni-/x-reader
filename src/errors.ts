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
      "Unexpected local failure. Run npm run diagnostics and check the server log. Browser exception contents are redacted.",
  };
}

export function logFailure(error: unknown): void {
  const safe = publicError(error);
  logEvent({
    level: safe.code === "internal_error" ? "error" : "warn",
    ...safe,
  });
}

export const requestContext = new AsyncLocalStorage<string>();
export function logEvent(fields: Record<string, unknown>): void {
  if (process.env.X_READER_LOG_FORMAT === "json") {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        request_id: requestContext.getStore(),
        ...fields,
      }),
    );
    return;
  }
  const {
    level = "info",
    event,
    message,
    tool,
    duration_ms,
    ...details
  } = fields;
  const clean = (value: unknown) =>
    String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const description =
    event === "request_started"
      ? `${tool} started`
      : event === "request_finished"
        ? `${tool} completed in ${duration_ms}ms`
        : event === "request_failed"
          ? `${tool} failed after ${duration_ms}ms: ${message}`
          : (message ?? String(event ?? "").replaceAll("_", " "));
  const context = Object.entries({
    request_id: requestContext.getStore(),
    ...details,
  })
    .filter(([key, value]) => key !== "request_id" && value !== undefined)
    .map(
      ([key, value]) =>
        `${key}=${key === "query" ? JSON.stringify(clean(value)) : clean(value)}`,
    )
    .join(" ");
  const time = new Date().toTimeString().slice(0, 8);
  console.error(
    `[${clean(level).toUpperCase()}][${time}] ${clean(description)}${context ? ` (${context})` : ""}`,
  );
}
