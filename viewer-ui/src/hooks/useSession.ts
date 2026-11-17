/* Client-side session state: resolves the stored token into an identity, drives
 * the login gate, and re-arms the gate on any 401. This is auth handshake state
 * (not server data to be cached/polled) so it lives in a small hook rather than
 * the query layer. The session *value* is read through useSessionInfo so a
 * successful login can refetch the authoritative identity. */

import { useCallback, useEffect, useState } from "react";
import { fetchSession, onUnauthorized, prefillTokenFromUrl, setStoredToken } from "@/lib/api";
import { useSessionInfo } from "@/lib/queries";

export function useSession() {
  /* Strip a ?token= credential from the URL before the first session request
   * (idempotent: it only acts while the param is present). */
  prefillTokenFromUrl();

  const sessionQuery = useSessionInfo(true);
  const [forcedLogout, setForcedLogout] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  /* A 401 from any request (token expired mid-session, not just /api/session)
   * drops the identity and re-shows the login gate. The reset happens inside the
   * listener callback (not synchronously in the effect body), so it is safe. */
  useEffect(() => {
    const unsubscribe = onUnauthorized(() => setForcedLogout(true));
    return unsubscribe;
  }, []);

  /* The session is derived: authoritative while logged in, force-nulled on a 401. */
  const session = forcedLogout ? null : (sessionQuery.data ?? null);

  const login = useCallback(
    async (token: string) => {
      const trimmed = token.trim();
      if (!trimmed || loginBusy) return;
      setLoginBusy(true);
      setLoginError(null);
      try {
        setStoredToken(trimmed);
        const info = await fetchSession();
        if (info) {
          setForcedLogout(false);
          await sessionQuery.refetch();
        } else {
          /* The token was not accepted: drop it so the next attempt starts clean. */
          setStoredToken("");
          setLoginError("The token was not accepted.");
        }
      } finally {
        setLoginBusy(false);
      }
    },
    [loginBusy, sessionQuery],
  );

  const sessionChecked = sessionQuery.isFetched || sessionQuery.isError;
  return { session, sessionChecked, login, loginBusy, loginError };
}
