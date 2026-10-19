// Existing CRM tests use known, already-enrolled AAL2 identities. MFA boundary
// tests use their own Auth/SQL fixtures and never call this adapter.
export function trustedMfaFixture(db) {
  const user = async (token) => {
    const result = await db.auth.getUser(token);
    if (!result.data?.user) return result;
    return {
      ...result,
      data: {
        ...result.data,
        user: {
          ...result.data.user,
          factors: result.data.user.factors || [
            {
              id: "f1000000-0000-4000-8000-000000000001",
              factor_type: "totp",
              status: "verified",
            },
          ],
        },
      },
    };
  };
  return {
    ...db,
    auth: {
      ...db.auth,
      getUser: user,
      getClaims: async (token) => {
        const result = await user(token);
        return result.error || !result.data?.user
          ? { error: { code: "invalid_jwt" } }
          : {
              data: {
                claims: {
                  sub: result.data.user.id,
                  aal: "aal2",
                  iat: Math.floor(Date.now() / 1000),
                  amr: [
                    {
                      method: "totp",
                      timestamp: Math.floor(Date.now() / 1000),
                    },
                  ],
                },
              },
            };
      },
    },
    rpc: (name, args) =>
      name === "mfa_session_state"
        ? Promise.resolve({ data: { reset_pending: false, reset_after: null } })
        : db.rpc(name, args),
  };
}
