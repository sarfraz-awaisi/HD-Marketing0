import { createContext, useContext, useEffect, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { api } from "../lib/api";
import { authErrorMessage } from "../lib/authErrors";
import { rememberLoginEmail } from "../lib/loginEmails";
const Context = createContext();
export function AuthProvider({ children }) {
  const queryClient = useContext(QueryClientContext);
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [recovering, setRecovering] = useState(false);
  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let live = true;
    let revision = 0;
    let authorizedUserId = null;
    let authorizedRole = null;
    const clearWorkspace = () => queryClient?.clear();
    const requireMfa = () => {
      ++revision;
      clearWorkspace();
      setUser((current) =>
        current ? { ...current, mfa_required: true } : current,
      );
      setLoading(false);
    };
    window.addEventListener("hd:mfa-required", requireMfa);
    const isCurrent = (request) => live && request === revision;
    const refresh = async (session, request) => {
      if (!isCurrent(request)) return;
      if (!session) {
        clearWorkspace();
        authorizedUserId = null;
        authorizedRole = null;
        setUser(null);
        setError("");
        setRecovering(false);
        setLoading(false);
        return;
      }
      // Keep the current page mounted while rechecking the same account.
      // A different account must be authorized before its workspace opens.
      if (session.user.id !== authorizedUserId) {
        clearWorkspace();
        authorizedUserId = null;
        authorizedRole = null;
        setUser(null);
        setLoading(true);
      }
      try {
        const profile = await api("/me", {
          headers: { Authorization: "Bearer " + session.access_token },
        });
        if (isCurrent(request)) {
          if (
            authorizedRole !== profile.role ||
            !profile.active ||
            profile.mfa_required
          )
            clearWorkspace();
          if (
            profile.active &&
            !profile.mfa_required &&
            profile.id === session.user.id
          )
            rememberLoginEmail(profile.role, session.user.email);
          authorizedUserId = profile.id;
          authorizedRole = profile.role;
          setUser(profile);
          setError("");
        }
      } catch (e) {
        if (isCurrent(request)) {
          clearWorkspace();
          authorizedUserId = null;
          authorizedRole = null;
          setUser(null);
          setError(e.message);
        }
      } finally {
        if (isCurrent(request)) setLoading(false);
      }
    };
    const restore = async () => {
      const request = ++revision;
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        await refresh(data.session, request);
      } catch (e) {
        if (isCurrent(request)) {
          clearWorkspace();
          authorizedUserId = null;
          authorizedRole = null;
          setUser(null);
          setError(authErrorMessage(e));
          setLoading(false);
        }
      }
    };
    restore();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Invalidate pending checks immediately, including before deferred sign-out.
      const request = ++revision;
      if (!session || session.user.id !== authorizedUserId) clearWorkspace();
      if (_event === "PASSWORD_RECOVERY") setRecovering(true);
      setTimeout(() => refresh(session, request), 0);
    });
    const interval = setInterval(restore, 60000);
    return () => {
      live = false;
      clearInterval(interval);
      data.subscription.unsubscribe();
      window.removeEventListener("hd:mfa-required", requireMfa);
    };
  }, [queryClient]);
  return (
    <Context.Provider
      value={{
        user,
        loading,
        error,
        recovering,
        finishRecovery: () => setRecovering(false),
        logout: async () => {
          await supabase.auth.signOut();
          queryClient?.clear();
          setUser(null);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useAuth = () => useContext(Context);
