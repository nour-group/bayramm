/* PKCE (RFC 7636, метод S256) и state для хаба входа: кабинет и панель создают verifier
   и state, хаб получает только challenge и state, сервер сверяет S256(verifier) при
   обмене кода. Web Crypto — есть и в браузере, и в Workers. */

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Случайная строка base64url из n байт: state — 16, verifier — 32 (43 символа) */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** challenge = base64url(SHA-256(verifier)) */
export async function codeChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

/** Новая пара verifier/challenge и state для одного входа */
export async function newPkce(): Promise<PkcePair> {
  const verifier = randomToken(32);
  return { verifier, challenge: await codeChallengeOf(verifier), state: randomToken(16) };
}
