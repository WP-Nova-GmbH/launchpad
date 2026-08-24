import type { ProviderDriverKind, ServerProviderAuth } from "@t3tools/contracts";

const ACCOUNT_AUTH_HOSTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  codex: ["openai.com", "chatgpt.com"],
  claudeAgent: ["anthropic.com", "claude.ai"],
  cursor: ["cursor.com", "cursor.sh"],
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function hostMatches(hostname: string, allowedSuffix: string): boolean {
  return hostname === allowedSuffix || hostname.endsWith(`.${allowedSuffix}`);
}

export function supportsProviderAccountAuth(driver: ProviderDriverKind): boolean {
  return ACCOUNT_AUTH_HOSTS[String(driver)] !== undefined;
}

export function hasProviderAccountSession(
  driver: ProviderDriverKind,
  auth: ServerProviderAuth,
): boolean {
  if (auth.status !== "authenticated") return false;

  const driverName = String(driver);
  const authType = auth.type?.toLowerCase().replace(/[\s_-]+/g, "");
  if (driverName === "codex") return authType === "chatgpt";
  if (driverName === "cursor") return true;
  if (driverName !== "claudeAgent") return false;

  return authType !== undefined && authType !== "apikey" && authType !== "bedrock";
}

export function extractProviderAccountAuthUrls(
  driver: ProviderDriverKind,
  output: string,
): ReadonlyArray<string> {
  const allowedHosts = ACCOUNT_AUTH_HOSTS[String(driver)];
  if (!allowedHosts) return [];

  const urls = new Set<string>();
  const plainOutput = output.replace(ANSI_ESCAPE_PATTERN, "");
  for (const rawMatch of plainOutput.match(URL_PATTERN) ?? []) {
    const candidate = rawMatch.replace(/[),.;\]}]+$/g, "");
    try {
      const parsed = new URL(candidate);
      if (allowedHosts.some((host) => hostMatches(parsed.hostname.toLowerCase(), host))) {
        urls.add(parsed.toString());
      }
    } catch {
      // Provider output is untrusted text; malformed URL-looking fragments are ignored.
    }
  }
  return [...urls];
}
