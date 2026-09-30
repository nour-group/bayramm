import { describe, expect, it } from "vitest";
import { isCodeChallenge, isCodeVerifier, isHubState } from "./api/account";
import { codeChallengeOf, newPkce, randomToken } from "./pkce";

describe("PKCE S256", () => {
  it("challenge по RFC 7636 (приложение B)", async () => {
    expect(await codeChallengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("новая пара проходит проверки формата сервера", async () => {
    const pair = await newPkce();
    expect(isCodeVerifier(pair.verifier)).toBe(true);
    expect(isCodeChallenge(pair.challenge)).toBe(true);
    expect(isHubState(pair.state)).toBe(true);
    expect(pair.challenge).toBe(await codeChallengeOf(pair.verifier));
  });

  it("случайные строки не повторяются", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken(16)));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
