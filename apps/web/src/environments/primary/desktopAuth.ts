import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopLocalSession } from "@t3tools/contracts";

export const DESKTOP_PRIMARY_AUTH_CHANGED = "launchpad:desktop-primary-auth-changed";
let account: { id: string; readToken: () => Promise<string | null> } | null = null;
let initialized = false;
let transition: Promise<void> = Promise.resolve();
let revision = 0;
let reportFailure: () => void = () => {};
const tokens = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
const retryAfter = new Map<string, number>();

export const desktopAuthRevision = () => revision;

function credentialsChanged(backendId: string, token: string) {
  const previous = tokens.get(backendId);
  tokens.set(backendId, token);
  if (previous === token) return;
  revision++;
  if (previous !== undefined && backendId === PRIMARY_LOCAL_ENVIRONMENT_ID) {
    window.dispatchEvent(new Event(DESKTOP_PRIMARY_AUTH_CHANGED));
  }
}

/** Clerk owns the account choice; Electron owns all local environment credentials. */
export function setDesktopLocalAccount(
  next: { id: string; readToken: () => Promise<string | null> } | null,
  onFailure: () => void = reportFailure,
): void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge) return;
  reportFailure = onFailure;
  const unchanged = initialized && account?.id === next?.id;
  account = next;
  if (unchanged) return;
  initialized = true;
  revision++;
  retryAfter.clear();
  pending.clear();
  // Start detachment before retrieving a token for the next account. Do not
  // serialize it behind an outstanding token read or relay verification.
  const attempt = bridge.setLocalEnvironmentAccount(next?.id ?? null).catch((error: unknown) => {
    if (transition === attempt) initialized = false;
    throw error;
  });
  transition = attempt;
  window.dispatchEvent(new Event(DESKTOP_PRIMARY_AUTH_CHANGED));
  void attempt
    .then(() => {
      for (const entry of bridge.getLocalEnvironmentBootstraps()) {
        if (entry.httpBaseUrl !== null) void readDesktopLocalSession(entry.id).catch(reportFailure);
      }
    })
    .catch(reportFailure);
}

export async function readDesktopLocalSession(backendId: string): Promise<DesktopLocalSession> {
  const bridge = window.desktopBridge;
  if (!bridge) throw new Error("Desktop local credentials require the desktop app.");
  // A renderer reload must not reuse an account before Clerk has resolved it.
  if (!initialized) setDesktopLocalAccount(account);
  let session: DesktopLocalSession;
  for (;;) {
    const currentTransition = transition;
    await currentTransition;
    session = await bridge.getLocalEnvironmentSession(backendId);
    if (currentTransition === transition && session.accountId === (account?.id ?? null)) break;
  }
  credentialsChanged(backendId, session.token);
  const current = account;
  if (
    current &&
    session.accountId === current.id &&
    session.user?.userId !== current.id &&
    !pending.has(backendId) &&
    Date.now() >= (retryAfter.get(backendId) ?? 0)
  ) {
    const task = (async () => {
      try {
        const token = await current.readToken();
        if (account?.id !== current.id) return;
        if (!token) throw new Error("No cloud session available");
        const attached = await bridge.attachLocalEnvironmentIdentity({
          backendId,
          generation: session.generation,
          token,
        });
        if (attached !== null && account?.id === current.id) {
          credentialsChanged(backendId, attached.token);
          retryAfter.delete(backendId);
        }
      } catch {
        if (account?.id !== current.id) return;
        // Local access stays usable; retry on later topology/connection reads.
        retryAfter.set(backendId, Date.now() + 30_000);
        reportFailure();
        const recovered = await bridge.getLocalEnvironmentSession(backendId);
        credentialsChanged(backendId, recovered.token);
      }
    })()
      .catch(reportFailure)
      .finally(() => {
        if (pending.get(backendId) === task) pending.delete(backendId);
      });
    pending.set(backendId, task);
  }
  return session;
}

export async function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined" || !window.desktopBridge) return null;
  return (await readDesktopLocalSession(PRIMARY_LOCAL_ENVIRONMENT_ID)).token;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  account = null;
  initialized = false;
  transition = Promise.resolve();
  revision = 0;
  tokens.clear();
  pending.clear();
  retryAfter.clear();
  reportFailure = () => {};
}
