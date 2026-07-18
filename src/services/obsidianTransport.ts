import { requestUrl } from "obsidian";
import type { GeminiTransport } from "./geminiClient";

/**
 * Uses Obsidian's native network bridge on every platform. This avoids browser
 * CORS differences and follows the same transport contract on desktop, iOS,
 * and Android.
 */
export const obsidianGeminiTransport: GeminiTransport = async (url, init) => {
  const signal = init.signal;
  if (signal?.aborted) throw new DOMException("The request was stopped.", "AbortError");

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = typeof init.body === "string" ? init.body : undefined;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(new DOMException("The request was stopped.", "AbortError")));
    signal?.addEventListener("abort", onAbort, { once: true });

    void requestUrl({
      url,
      method: init.method ?? "POST",
      headers,
      body,
      throw: false
    }).then((response) => {
      finish(() => resolve(new Response(response.arrayBuffer, {
        status: response.status,
        headers: response.headers
      })));
    }).catch((error) => {
      finish(() => reject(error));
    });
  });
};
