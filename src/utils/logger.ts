const ts = () => new Date().toISOString();

interface AxiosLikeError {
  isAxiosError: true;
  message: string;
  code?: string;
  config?: { method?: string; url?: string };
  response?: { status?: number; data?: unknown };
}

function isAxiosError(a: unknown): a is AxiosLikeError {
  return !!a && typeof a === "object" && (a as { isAxiosError?: unknown }).isAxiosError === true;
}

/**
 * Axios errors carry the whole request — headers with API keys, signed query
 * strings — and print as hundreds of lines. Collapse them to one line that
 * keeps only what's useful for debugging: method, path, status, API message.
 */
interface TelegramLikeError {
  code: number;
  response: { description?: string };
  on?: { method?: string };
}

function isTelegramError(a: unknown): a is TelegramLikeError {
  return (
    !!a &&
    typeof a === "object" &&
    typeof (a as { code?: unknown }).code === "number" &&
    typeof (a as { response?: { description?: unknown } }).response?.description === "string"
  );
}

function describe(a: unknown): unknown {
  // Telegraf's errors dump the whole request payload; the description says it all.
  if (isTelegramError(a)) {
    return `Telegram ${a.on?.method ?? ""} → ${a.code} ${a.response.description}`;
  }
  if (!isAxiosError(a)) return a;
  const method = a.config?.method?.toUpperCase() ?? "";
  // The query string holds timestamps and signatures; the path is enough.
  const path = (a.config?.url ?? "").split("?")[0];
  const status = a.response?.status ?? a.code ?? "no response";
  const body = a.response?.data;
  const detail =
    body === undefined
      ? a.message
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  return `${method} ${path} → ${status} ${detail.slice(0, 300)}`;
}

export const logger = {
  info: (msg: string, ...a: unknown[]) =>
    console.log(`[${ts()}] INFO  ${msg}`, ...a.map(describe)),
  warn: (msg: string, ...a: unknown[]) =>
    console.warn(`[${ts()}] WARN  ${msg}`, ...a.map(describe)),
  error: (msg: string, ...a: unknown[]) =>
    console.error(`[${ts()}] ERROR ${msg}`, ...a.map(describe)),
};
