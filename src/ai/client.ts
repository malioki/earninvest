import Anthropic from "@anthropic-ai/sdk";

// One Anthropic client for every AI feature (questions, receipt photos).
// Off unless an API key is configured.

export const MODEL = "claude-opus-5-5";

/** Retry on Anthropic's recommended model if a safety classifier declines. */
export const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
} as const;

export function aiEnabled(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Tests swap in a stub so nothing leaves the machine. */
export function setClientForTests(c: unknown): void {
  client = c as Anthropic;
}
