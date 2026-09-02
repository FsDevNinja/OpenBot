/** Compare the caller's Bot token without leaking its contents through timing. */
export function matchesToken(expected: string, offered: string): boolean {
  if (expected.length === 0 || offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** The one header accepted from OpenBot's server when it calls a managed Bot. */
export function hasManagedAgentToken(
  request: Request,
  expected: string,
): boolean {
  return matchesToken(
    expected,
    request.headers.get("x-openbot-agent-token")?.trim() ?? "",
  );
}

/** Internal headers added by the API server after resolving the runner's own provider account. */
export const PROVIDER_TYPE_HEADER = "x-openbot-provider-type";
export const PROVIDER_CREDENTIAL_HEADER = "x-openbot-provider-credential";
export const PROVIDER_CONNECTION_HEADER = "x-openbot-provider-connection";

export function providerTypeFrom(request: Request): string {
  return request.headers.get(PROVIDER_TYPE_HEADER)?.trim().toLowerCase() ?? "";
}

export function providerCredentialFrom(request: Request): string {
  return request.headers.get(PROVIDER_CREDENTIAL_HEADER)?.trim() ?? "";
}

/** Opaque id for a runtime-managed OAuth account. It is never a vendor access token. */
export function providerConnectionFrom(request: Request): string {
  return request.headers.get(PROVIDER_CONNECTION_HEADER)?.trim() ?? "";
}
