import { api } from "./api";
import { createLoginClient, supabase } from "./supabase";
import { rememberLoginEmail } from "./loginEmails";
const check = (result) => {
  if (result.error)
    throw new Error(
      "Authenticator setup could not be completed. Check your connection and try again.",
    );
  return result.data;
};
export async function prepareMfa(candidate, profile, email) {
  if (profile.mfa_reset_pending)
    throw new Error(
      "Your two-factor reset needs administrator recovery. Ask another administrator to retry the reset.",
    );
  const assurance = check(
    await candidate.auth.mfa.getAuthenticatorAssuranceLevel(),
  );
  if (!assurance?.currentLevel)
    throw new Error("Your sign-in session expired. Sign in again.");
  const factors = check(await candidate.auth.mfa.listFactors());
  const verified = (factors.totp || []).filter((f) => f.status === "verified");
  const flow = {
    candidate,
    profile,
    email,
    factors: verified,
    enrollment: null,
    disposed: false,
  };
  if (!verified.length) {
    // Remove only abandoned unverified TOTP setup, never an existing verified factor.
    for (const factor of (factors.all || []).filter(
      (f) => f.factor_type === "totp" && f.status === "unverified",
    ))
      check(await candidate.auth.mfa.unenroll({ factorId: factor.id }));
    const enrollment = check(
      await candidate.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "HD Marketing authenticator",
        issuer: "HD Marketing",
      }),
    );
    if (
      !enrollment?.id ||
      !enrollment.totp?.qr_code ||
      !enrollment.totp?.secret
    )
      throw new Error(
        "Authenticator setup is unavailable. Ask your administrator to enable TOTP in Supabase Auth.",
      );
    flow.enrollment = enrollment;
  }
  return flow;
}
export async function cancelMfa(flow) {
  if (!flow || flow.disposed) return;
  flow.disposed = true;
  try {
    if (flow.enrollment)
      await flow.candidate.auth.mfa.unenroll({ factorId: flow.enrollment.id });
  } finally {
    await flow.candidate.auth.signOut({ scope: "local" }).catch(() => {});
  }
}
export async function completeMfa(flow, factorId, code) {
  if (flow.disposed || !/^\d{6}$/.test(code))
    throw new Error("Enter the six-digit code from your authenticator app.");
  const current = check(await flow.candidate.auth.getSession()).session;
  if (!current?.access_token)
    throw new Error("Your sign-in session expired. Sign in again.");
  const session = await api("/mfa/verify", {
    method: "POST",
    headers: { Authorization: "Bearer " + current.access_token },
    body: { factor_id: factorId, code },
  });
  check(await flow.candidate.auth.setSession(session));
  const profile = await api("/me?portal=" + flow.profile.role, {
    headers: { Authorization: "Bearer " + session.access_token },
  });
  if (
    !profile.active ||
    profile.id !== flow.profile.id ||
    profile.role !== flow.profile.role ||
    profile.mfa_required
  )
    throw new Error(
      "Two-factor sign-in could not be confirmed. Sign in again.",
    );
  check(await supabase.auth.setSession(session));
  flow.disposed = true;
  flow.enrollment = null;
  rememberLoginEmail(profile.role, flow.email);
  return profile;
}
export async function restoreMfa(user) {
  const current = check(await supabase.auth.getSession()).session;
  if (!current?.access_token || !current.refresh_token)
    throw new Error("Sign in again to verify your authenticator.");
  const candidate = createLoginClient();
  check(
    await candidate.auth.setSession({
      access_token: current.access_token,
      refresh_token: current.refresh_token,
    }),
  );
  const profile = await api("/me?portal=" + user.role, {
    headers: { Authorization: "Bearer " + current.access_token },
  });
  if (profile.id !== user.id || !profile.active)
    throw new Error("Your sign-in session changed. Sign in again.");
  return prepareMfa(candidate, profile, current.user.email);
}
