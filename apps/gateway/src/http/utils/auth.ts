/**
 * Shared HTTP authentication helpers used by route handlers and WS upgrade
 * handlers across the gateway.
 */

/** Extracts the token value from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? (match[1] ?? null) : null;
}
