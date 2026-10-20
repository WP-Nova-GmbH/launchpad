import { fetchSessionState, replaceBrowserIdentity } from "./auth";

/** Bind only this paired cookie, never a reusable dev credential or a remote bearer session. */
export async function synchronizeBrowserIdentity(
  account: { id: string; readToken: () => Promise<string | null> } | null,
  isCurrent: () => boolean,
): Promise<boolean> {
  const session = await fetchSessionState();
  if (!isCurrent() || !session.authenticated || session.sessionMethod !== "browser-session-cookie")
    return false;
  const expectedId = account?.id ?? null;
  if ((session.user?.userId ?? null) === expectedId) return false;
  if (session.user && account) {
    await replaceBrowserIdentity(null);
  }
  const token = account ? await account.readToken() : null;
  if (!isCurrent()) return false;
  if (account && !token) throw new Error("No Launchpad Connect session is available.");
  try {
    await replaceBrowserIdentity(account && token ? { accountId: account.id, token } : null);
  } catch (error) {
    // Another tab may have rotated the shared cookie while this request was in flight.
    const current = await fetchSessionState();
    if (current.authenticated && (current.user?.userId ?? null) === expectedId) return true;
    throw error;
  }
  return true;
}
