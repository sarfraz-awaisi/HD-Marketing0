import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LockKeyhole,
  ShieldCheck,
  UserRound,
  UsersRound,
  Plus,
  Settings,
  KeyRound,
  Mail,
  Clock3,
  Trash2,
  Eye,
  Pencil,
  Power,
  Hash,
  CircleCheck,
  Briefcase,
} from "lucide-react";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import AgentHandover from "../../components/accounts/AgentHandover";
import PendingAccountVerification from "../../components/accounts/PendingAccountVerification";
import CreateAccountForm from "../../components/accounts/CreateAccountForm";
import AccountUid from "../../components/accounts/AccountUid";
import {
  Button,
  Modal,
  RecordForm,
  ErrorBox,
  Loader,
  Pagination,
  PasswordInput,
  useToast,
} from "../../components/common/UI";
// Update 047: Staff joins Admin and Agent.
const roleLabel = (role) =>
  ({ admin: "Admin", agent: "Agent", staff: "Staff" })[role] || role;
const needsInvitation = (account) =>
  (!!account.invitation_state || account.invitation_required) &&
  account.invitation_state !== "accepted";
const needsAccountCode = (account) =>
  (account.role === "agent" ||
    account.email_verification_method === "email_otp" ||
    (!account.active && account.email_verification_method !== "link")) &&
  (needsInvitation(account) || !account.email_confirmed_at);
const accountStatus = (account) =>
  account.account_status
    ? {
        pending_invitation:
          account.email_verification_method === "email_otp"
            ? "Pending email code"
            : "Pending invitation",
        pending_verification: "Pending verification",
        invitation_expired:
          account.email_verification_method === "email_otp"
            ? "Verification expired"
            : "Invitation expired",
        invitation_cancelled:
          account.email_verification_method === "email_otp"
            ? "Verification cancelled"
            : "Invitation cancelled",
        active: "Active",
        suspended: "Suspended",
        deletion_pending: "Deletion pending",
      }[account.account_status] || "Pending verification"
    : !account.active
      ? "Disabled"
      : account.email_confirmed_at
        ? "Active"
        : "Pending email confirmation";
const statusTone = (account) =>
  /^(pending_|invitation_expired$)/.test(account.account_status || "")
    ? "pending"
    : !account.active
      ? "disabled"
      : account.email_confirmed_at
        ? "active"
        : "pending";
const accountFields = (own) => [
  { key: "name", label: "Full name", required: true },
  ...(!own
    ? [
        {
          key: "role",
          label: "Account role",
          options: [
            { value: "agent", label: "Agent" },
            { value: "staff", label: "Staff" },
            { value: "admin", label: "Admin" },
          ],
          required: true,
          default: "agent",
        },
        {
          key: "access",
          label: "Account access",
          options: [
            { value: "active", label: "Active" },
            { value: "disabled", label: "Disabled" },
          ],
          required: true,
          default: "active",
        },
      ]
    : []),
];
function checkPassword(data) {
  if (
    data.password.length < 12 ||
    data.password.length > 72 ||
    new TextEncoder().encode(data.password).length > 72
  )
    throw new Error(
      "Use a password of at least 12 characters and no more than 72 bytes.",
    );
  if (data.password !== data.confirm_password)
    throw new Error("Passwords must match.");
}
const passwordFields = [
  {
    key: "password",
    label: "New password",
    type: "password",
    autoComplete: "new-password",
    required: true,
  },
  {
    key: "confirm_password",
    label: "Confirm password",
    type: "password",
    autoComplete: "new-password",
    required: true,
  },
];
function AccountDetails({
  account,
  request,
  onEdit,
  onPassword,
  onVerify,
  onEmailCode,
  onHandover,
  onCancelInvitation,
  onMfaReset,
  onDelete,
  busy,
  own,
}) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request(`/accounts/${account.id}`)
      .then((value) => {
        if (live) setData(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [account.id, request]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loader />;
  return (
    <div className="account-details">
      <div className="account-person">
        <span className="account-avatar">
          {data.name.charAt(0).toUpperCase()}
        </span>
        <div>
          <h3>{data.name}</h3>
          <p>{data.email || "No email available"}</p>
        </div>
      </div>
      <div className="account-labels">
        <span className="account-role">{roleLabel(data.role)}</span>
        <span className={`account-status ${statusTone(data)}`}>
          {accountStatus(data)}
        </span>
        {own && <span className="account-role">Your account</span>}
      </div>
      <dl className="account-detail-grid">
        {[
          ["UID", <AccountUid uid={data.uid} />],
          ["Account ID", data.id],
          ["Created", date(data.created_at)],
          [
            data.email_verification_method === "email_otp"
              ? "Code requested"
              : "Invitation requested",
            date(data.invitation_date),
          ],
          [
            data.email_verification_method === "email_otp"
              ? "Code expires"
              : "Invitation expires",
            date(data.invitation_expires_at),
          ],
          [
            "Last sign-in",
            data.last_sign_in_at
              ? date(data.last_sign_in_at)
              : "Never signed in",
          ],
          [
            "Email confirmation",
            data.email_confirmed_at ? "Confirmed" : "Unconfirmed",
          ],
          ["Assigned leads", data.assigned_leads],
          ["Completed calls", data.completed_calls],
          ["Open follow-ups", data.open_followups],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {data.banned_until && new Date(data.banned_until) > new Date() && (
        <p className="security-note">
          Sign-in is also blocked in Supabase. Enabling account access will lift
          that block.
        </p>
      )}
      <div className="account-actions">
        {!own && (
          <Button variant="danger" disabled={busy} onClick={onDelete}>
            <Trash2 size={16} />
            {data.account_status === "deletion_pending"
              ? "Retry delete"
              : "Delete account"}
          </Button>
        )}
        {data.account_status !== "deletion_pending" &&
          !data.account_creation_pending && (
            <>
              {!own && data.role !== "admin" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={onMfaReset}
                >
                  <ShieldCheck size={16} />
                  Reset two-factor
                </Button>
              )}
              {data.role === "agent" &&
                !data.active &&
                data.assigned_leads > 0 && (
                  <Button variant="danger" disabled={busy} onClick={onHandover}>
                    Hand over remaining work
                  </Button>
                )}
              <Button disabled={busy} onClick={onEdit}>
                Edit account
              </Button>
              {!own && data.email_confirmed_at && !needsInvitation(data) && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={onPassword}
                >
                  <KeyRound size={16} />
                  Set password
                </Button>
              )}
              {(needsInvitation(data) || !data.email_confirmed_at) && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={needsAccountCode(data) ? onEmailCode : onVerify}
                >
                  <Mail size={16} />
                  {needsAccountCode(data)
                    ? "Verify email code"
                    : busy
                      ? "Requesting email…"
                      : needsInvitation(data)
                        ? "Resend invitation"
                        : "Resend confirmation email"}
                </Button>
              )}
              {needsInvitation(data) &&
                data.invitation_state !== "cancelled" && (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={onCancelInvitation}
                  >
                    {needsAccountCode(data)
                      ? "Cancel email verification"
                      : "Cancel pending invitation"}
                  </Button>
                )}
            </>
          )}
      </div>
      {data.account_creation_pending && (
        <p className="security-note">
          Account setup is incomplete. The administrator who started this
          request can use Resume verification in Pending account verification to
          finish.
        </p>
      )}
      {data.account_status === "deletion_pending" && (
        <p className="security-note">
          Account access is blocked. Choose Retry delete to finish removing this
          account.
        </p>
      )}
      {needsInvitation(data) && data.account_status !== "deletion_pending" && (
        <p className="security-note">
          {needsAccountCode(data)
            ? "Enter the latest code sent to this agent's email and set an initial password in Accounts. Access stays blocked until verification is complete."
            : "The user must open the latest invitation and set their own password. Sending an email does not verify the mailbox or grant CRM access."}
        </p>
      )}
      {!data.email_confirmed_at &&
        data.account_status !== "deletion_pending" && (
          <p className="security-note">
            The email must be verified before CRM access. Enabling access or
            setting a password cannot confirm it.
          </p>
        )}
      {own && (
        <p>
          To change your own login password, sign out and choose Forgot your
          password.
        </p>
      )}
    </div>
  );
}
function AccountDialog({ dialog, onClose, request, user, onSaved, onChanged }) {
  const pending = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const account = dialog.account,
    own = account?.id === user.id;
  const [kind, setKind] = useState(dialog.kind);
  const [handoverChanges, setHandoverChanges] = useState(null);
  const [handoverRequested, setHandoverRequested] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [codeNotice, setCodeNotice] = useState("");
  const [resendingCode, setResendingCode] = useState(false);
  const title =
    kind === "create"
      ? "Create account"
      : kind === "password"
        ? "Set a new password"
        : kind === "email_code"
          ? "Verify account email"
          : kind === "access"
            ? handoverRequested || handoverChanges
              ? "Hand over agent work"
              : `${account.active ? "Disable" : "Enable"} account access`
            : kind === "edit"
              ? "Edit account"
              : kind === "cancel_invitation"
                ? needsAccountCode(account)
                  ? "Cancel email verification"
                  : "Cancel pending invitation"
                : kind === "mfa_reset"
                  ? "Reset two-factor login"
                  : kind === "delete"
                    ? "Delete account"
                    : "Account details";
  async function run(action) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await action();
      onSaved(value);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      <ErrorBox error={error} />
      {kind === "details" ? (
        <AccountDetails
          account={account}
          request={request}
          own={own}
          busy={busy}
          onVerify={async () => {
            try {
              await run(async () => {
                const result = await request(
                  `/accounts/${account.id}/${needsInvitation(account) ? "invitation" : "verification"}`,
                  { method: "POST", body: {} },
                );
                return {
                  ...result,
                  message: result.invitation_required
                    ? result.warning || result.message
                    : result.already_confirmed
                      ? "Email is already confirmed."
                      : "Verification email requested. Ask the owner to check their inbox and spam folder.",
                };
              });
            } catch (failure) {
              setError(failure.message);
            }
          }}
          onEdit={() => setKind("edit")}
          onEmailCode={() => setKind("email_code")}
          onHandover={() => {
            setHandoverRequested(true);
            setKind("access");
          }}
          onCancelInvitation={() => setKind("cancel_invitation")}
          onPassword={() => setKind("password")}
          onMfaReset={() => setKind("mfa_reset")}
          onDelete={() => setKind("delete")}
        />
      ) : kind === "email_code" ? (
        <>
          <p>
            {account.name} · {account.email}
          </p>
          <p className="security-note">
            Enter the 6-digit code from this account's latest email, then set an
            initial password. Access stays blocked until verification is
            complete.
          </p>
          {codeNotice && <p role="status">{codeNotice}</p>}
          <RecordForm
            autoComplete="off"
            disabled={busy}
            fields={[
              {
                key: "code",
                label: "Email verification code",
                autoComplete: "one-time-code",
                inputMode: "numeric",
                required: true,
              },
              ...passwordFields,
            ]}
            submit="Verify email and save password"
            onSave={async (data) => {
              if (!/^\d{6}$/.test(data.code.trim()))
                throw new Error(
                  "Enter the 6-digit code from the latest email.",
                );
              checkPassword(data);
              await run(() =>
                request(`/accounts/${account.id}/email-code/verify`, {
                  method: "POST",
                  body: { code: data.code.trim(), password: data.password },
                }),
              );
            }}
          >
            {({ isSubmitting }) => (
              <Button
                type="button"
                variant="secondary"
                disabled={busy || isSubmitting}
                onClick={async () => {
                  if (pending.current) return;
                  pending.current = true;
                  setBusy(true);
                  setResendingCode(true);
                  setError("");
                  setCodeNotice("");
                  try {
                    const result = await request(
                      `/accounts/${account.id}/email-code`,
                      { method: "POST", body: {} },
                    );
                    setCodeNotice(result.warning || result.message);
                    onChanged();
                  } catch (failure) {
                    setError(failure.message);
                  } finally {
                    pending.current = false;
                    setBusy(false);
                    setResendingCode(false);
                  }
                }}
              >
                {resendingCode
                  ? "Requesting code…"
                  : "Resend verification code"}
              </Button>
            )}
          </RecordForm>
        </>
      ) : kind === "delete" ? (
        <form
          className="account-delete-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              confirmationEmail.trim().toLowerCase() !==
              account.email?.toLowerCase()
            )
              return;
            try {
              await run(() =>
                request(`/accounts/${account.id}`, {
                  method: "DELETE",
                  body: { confirm: true, email: confirmationEmail.trim() },
                }),
              );
            } catch (failure) {
              setError(failure.message);
              if (failure.code === "ACCOUNTS_DELETE_PENDING") onChanged?.();
            }
          }}
        >
          <p>
            Permanently delete sign-in access for{" "}
            <strong>{account.name}</strong> ({account.email})?
          </p>
          <p>
            The account will be removed from Accounts. Assigned leads and files
            return to the admin pool, and pending work moves to its current
            owner or your administrator account. Completed calls, deals and
            audit history are retained.
          </p>
          <label>
            Type the account email to confirm *
            <input
              aria-label="Confirm account email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              required
              value={confirmationEmail}
              disabled={busy}
              onChange={(event) => setConfirmationEmail(event.target.value)}
            />
          </label>
          <footer>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={
                busy ||
                own ||
                confirmationEmail.trim().toLowerCase() !==
                  account.email?.toLowerCase()
              }
            >
              <Trash2 size={16} />
              {busy ? "Deleting…" : "Delete account"}
            </Button>
          </footer>
        </form>
      ) : kind === "mfa_reset" ? (
        <>
          <p>
            Reset two-factor login for <strong>{account.name}</strong>? Their
            authenticator factors will be removed and existing sessions will
            lose CRM access. They must sign in again and set up an authenticator
            when required.
          </p>
          <p>
            Confirm the person's identity before resetting access. This keeps
            their password, role and customer assignments.
          </p>
          <footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setKind("details")}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                try {
                  await run(() =>
                    request(`/accounts/${account.id}/mfa-reset`, {
                      method: "POST",
                      body: { confirm: true },
                    }),
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              {busy ? "Resetting…" : "Confirm two-factor reset"}
            </Button>
          </footer>
        </>
      ) : kind === "cancel_invitation" ? (
        <>
          <p>
            Cancel{" "}
            {needsAccountCode(account)
              ? "email verification"
              : "the invitation"}{" "}
            for {account.name}? The user will have no CRM access. Their account
            record is retained.
          </p>
          <footer>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {needsAccountCode(account)
                ? "Keep verification"
                : "Keep invitation"}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                try {
                  await run(async () => {
                    await request(`/accounts/${account.id}/invitation`, {
                      method: "DELETE",
                      body: {},
                    });
                    return {
                      message: needsAccountCode(account)
                        ? "Email verification cancelled. Access remains blocked."
                        : "Invitation cancelled. Access remains blocked.",
                    };
                  });
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              {busy
                ? "Cancelling…"
                : needsAccountCode(account)
                  ? "Cancel verification"
                  : "Cancel invitation"}
            </Button>
          </footer>
        </>
      ) : kind === "access" &&
        account.role === "agent" &&
        (account.active || handoverChanges || handoverRequested) ? (
        <AgentHandover
          account={account}
          request={request}
          changes={handoverChanges}
          onClose={onClose}
          onSaved={onSaved}
          onPending={(value) => {
            pending.current = value;
            setBusy(value);
          }}
        />
      ) : kind === "access" ? (
        <>
          <p>
            {account.active
              ? `Disable CRM access for ${account.name}? Existing leads and activity history will be retained.`
              : `Enable CRM access for ${account.name}? Email confirmation is also required to sign in as ${roleLabel(account.role)}.`}
          </p>
          {account.active && (
            <p>
              Reassign any remaining leads from Task assign or the lead profile
              when needed.
            </p>
          )}
          <footer>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={account.active ? "danger" : ""}
              disabled={busy}
              onClick={async () => {
                try {
                  await run(() =>
                    request(`/accounts/${account.id}`, {
                      method: "PATCH",
                      body: { active: !account.active },
                    }),
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              {busy
                ? "Saving…"
                : account.active
                  ? "Disable access"
                  : "Enable access"}
            </Button>
          </footer>
        </>
      ) : kind === "create" ? (
        <CreateAccountForm
          request={request}
          disabled={busy}
          onIncomplete={onChanged}
          onCreate={(body) =>
            run(async () => ({
              ...(await request("/accounts", { method: "POST", body })),
              created: true,
            }))
          }
        />
      ) : (
        <>
          <p>
            {account.name} · {account.email || "No email available"}
          </p>
          <RecordForm
            fields={
              kind === "password"
                ? passwordFields
                : accountFields(own).filter(
                    (f) =>
                      f.key !== "access" ||
                      (!needsInvitation(account) &&
                        !!account.email_confirmed_at),
                  )
            }
            initial={
              account
                ? { ...account, access: account.active ? "active" : "disabled" }
                : {}
            }
            autoComplete="off"
            submit={kind === "password" ? "Update password" : "Save account"}
            onSave={async (data) => {
              if (kind === "password") checkPassword(data);
              if (
                data.name?.trim().length > 200 ||
                (data.name !== undefined && !data.name.trim())
              )
                throw new Error("Enter a name up to 200 characters.");
              if (
                kind === "edit" &&
                account.role === "agent" &&
                // An agent becoming staff hands over their leads first, as
                // when disabling (update 047).
                (data.access === "disabled" ||
                  (data.role === "staff" && account.assigned_leads > 0)) &&
                !needsInvitation(account) &&
                !!account.email_confirmed_at
              ) {
                setHandoverChanges({ name: data.name.trim(), role: data.role });
                setKind("access");
                return;
              }
              await run(() =>
                kind === "password"
                  ? request(`/accounts/${account.id}/password`, {
                      method: "POST",
                      body: { password: data.password },
                    })
                  : request(`/accounts/${account.id}`, {
                      method: "PATCH",
                      body: {
                        name: data.name.trim(),
                        ...(!own
                          ? {
                              role: data.role,
                              ...(!needsInvitation(account) &&
                              account.email_confirmed_at
                                ? { active: data.access === "active" }
                                : {}),
                            }
                          : {}),
                      },
                    }),
              );
            }}
          >
            {kind === "password" && (
              <p className="security-note">
                Use at least 12 characters. The new password takes effect
                immediately; the old password will stop working.
              </p>
            )}
            {kind === "edit" && own && (
              <p className="security-note">
                Your own administrator role and access cannot be removed here.
              </p>
            )}
          </RecordForm>
        </>
      )}
    </Modal>
  );
}
// Shown only after the server confirms the Auth user and profile were saved.
function AccountCreated({ account, onClose }) {
  return (
    <Modal title="Account Created Successfully!" onClose={onClose}>
      <div className="account-created">
        <span className="account-created-symbol">
          <CircleCheck size={28} aria-hidden="true" />
        </span>
        <dl className="account-detail-grid">
          {[
            ["Name", account.name],
            ["Email", account.email],
            ["Role", roleLabel(account.role)],
            ["UID", <AccountUid uid={account.uid} />],
            [
              "Status",
              <span className={`account-status ${statusTone(account)}`}>
                {accountStatus(account)}
              </span>,
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <footer>
          <Button onClick={onClose}>Done</Button>
        </footer>
      </div>
    </Modal>
  );
}
export default function Accounts() {
  const { user } = useAuth(),
    qc = useQueryClient(),
    toast = useToast();
  const security = useQuery({
    queryKey: ["account-security", user.id],
    queryFn: () => api("/account-security"),
  });
  const [grant, setGrant] = useState(null),
    grantRef = useRef(null),
    abortRef = useRef(null),
    liveRef = useRef(true);
  const [pin, setPin] = useState(""),
    [unlocking, setUnlocking] = useState(false),
    unlockPending = useRef(false);
  const [error, setError] = useState(""),
    [pageError, setPageError] = useState(""),
    [data, setData] = useState(null),
    [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [role, setRole] = useState(""),
    [access, setAccess] = useState(""),
    [refresh, setRefresh] = useState(0),
    [dialog, setDialog] = useState(null);
  const [pendingRequests, setPendingRequests] = useState([]),
    [pendingError, setPendingError] = useState("");
  const lock = useCallback((message = "") => {
    const current = grantRef.current;
    abortRef.current?.abort();
    grantRef.current = null;
    setGrant(null);
    setData(null);
    setDialog(null);
    setPendingRequests([]);
    setPendingError("");
    setPin("");
    setPageError("");
    setError(message);
    if (current)
      api("/account-security/lock", {
        method: "POST",
        headers: { "X-Accounts-Unlock": current.token },
      }).catch(() => {});
  }, []);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      abortRef.current?.abort();
      if (grantRef.current)
        api("/account-security/lock", {
          method: "POST",
          headers: { "X-Accounts-Unlock": grantRef.current.token },
        }).catch(() => {});
      grantRef.current = null;
    };
  }, [user.id]);
  useEffect(() => {
    if (!grant) return;
    const timer = setTimeout(
      () => lock("Your Accounts session expired. Enter your PIN again."),
      Math.max(0, new Date(grant.expires_at).getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [grant, lock]);
  const request = useCallback(
    async (path, options = {}) => {
      const current = grantRef.current;
      if (!current || new Date(current.expires_at) <= new Date()) {
        lock("Unlock Accounts with your PIN to continue.");
        throw new Error("Accounts is locked.");
      }
      try {
        const result = await api(path, {
          ...options,
          signal: options.signal || abortRef.current?.signal,
          headers: { ...options.headers, "X-Accounts-Unlock": current.token },
        });
        if (grantRef.current !== current)
          throw new Error("Accounts is locked.");
        return result;
      } catch (e) {
        if ([401, 403, 423].includes(e.status))
          lock("Accounts is locked. Enter your PIN again to continue.");
        throw e;
      }
    },
    [lock],
  );
  useEffect(() => {
    if (!grant) return;
    let live = true;
    request("/accounts/pending")
      .then((rows) => {
        if (live) {
          setPendingRequests(Array.isArray(rows) ? rows : []);
          setPendingError("");
        }
      })
      .catch((e) => {
        if (live) setPendingError(e.message);
      });
    return () => {
      live = false;
    };
  }, [grant, refresh, request]);
  useEffect(() => {
    if (!grant) return;
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    setPageError("");
    const params = new URLSearchParams({
      page: String(page),
      limit: "20",
      search,
    });
    if (role) params.set("role", role);
    if (access) params.set("access", access);
    request("/accounts?" + params, { signal: controller.signal })
      .then((result) => {
        if (live) setData(result);
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setPageError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [grant, page, search, role, access, refresh, request]);
  async function unlock(event) {
    event.preventDefault();
    if (unlockPending.current) return;
    unlockPending.current = true;
    setUnlocking(true);
    setError("");
    try {
      const value = await api("/account-security/unlock", {
        method: "POST",
        body: { pin },
      });
      if (!liveRef.current) {
        api("/account-security/lock", {
          method: "POST",
          headers: { "X-Accounts-Unlock": value.token },
        }).catch(() => {});
        return;
      }
      abortRef.current = new AbortController();
      grantRef.current = value;
      setGrant(value);
      setPin("");
      setPage(1);
    } catch (e) {
      setError(e.message);
      setPin("");
      if (e.code === "ACCOUNTS_PIN_REQUIRED")
        qc.invalidateQueries({ queryKey: ["account-security", user.id] });
    } finally {
      unlockPending.current = false;
      setUnlocking(false);
    }
  }
  function saved(value) {
    setDialog(
      value?.created
        ? { kind: "created", account: value }
        : value?.email_code_required
          ? {
              kind: "email_code",
              account: {
                id: value.id,
                name: value.name,
                email: value.email,
                role: value.role,
                email_verification_method: "email_otp",
              },
            }
          : null,
    );
    setRefresh((v) => v + 1);
    qc.invalidateQueries({ queryKey: ["users"] });
    if (value?.mode || value?.deleted) {
      qc.invalidateQueries();
    }
    if (!value?.created)
      toast(
        value?.warning ||
          value?.message ||
          (value?.email_confirmation_required
            ? "Account created. The owner must confirm their email before access."
            : "Account saved."),
      );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONTROL ACCESS WITH CONFIDENCE</span>
          <h1>Accounts</h1>
          <p>Create and manage your team’s Agent, Staff and Admin accounts.</p>
        </div>
        <div className="actions account-header-actions">
          <Link className="button secondary" to="/settings/security">
            <Settings size={17} />
            Security settings
          </Link>
          {grant && (
            <Button variant="secondary" onClick={() => lock()}>
              <LockKeyhole size={17} />
              Lock Accounts
            </Button>
          )}
          {grant && (
            <Button onClick={() => setDialog({ kind: "create" })}>
              <Plus size={18} />
              Create account
            </Button>
          )}
        </div>
      </div>
      {!grant ? (
        <section
          className="panel fx-card accounts-lock"
          aria-label="Unlock Accounts"
        >
          <span className="security-symbol">
            <LockKeyhole size={30} aria-hidden="true" />
          </span>
          <h2>Accounts is protected</h2>
          <p>
            Only signed-in administrators can open this page. Enter your
            personal four-digit PIN to continue.
          </p>
          {security.isPending ? (
            <Loader />
          ) : security.error ? (
            <ErrorBox error={security.error} />
          ) : !security.data.configured ? (
            <div className="accounts-setup">
              <p>
                Set your PIN using your current login password in Security
                settings.
              </p>
              <Link className="button" to="/settings/security">
                Set up Accounts PIN
              </Link>
            </div>
          ) : (
            <form onSubmit={unlock}>
              <label>
                4-digit PIN
                <PasswordInput
                  className="accounts-pin-input"
                  aria-label="4-digit PIN"
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  autoComplete="off"
                  required
                  value={pin}
                  disabled={unlocking}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                />
              </label>
              <ErrorBox error={error} />
              <Button disabled={unlocking || pin.length !== 4}>
                {unlocking ? "Unlocking…" : "Unlock Accounts"}
              </Button>
              <Link className="text-button" to="/settings/security">
                Forgot PIN? Change / reset it
              </Link>
            </form>
          )}
        </section>
      ) : (
        <>
          <div className="accounts-unlocked">
            <ShieldCheck size={18} />
            <span>
              Accounts unlocked until {date(grant.expires_at)}. Leaving this
              page locks it again.
            </span>
          </div>
          <ErrorBox error={pendingError} />
          {pendingRequests.length > 0 && (
            <section className="panel">
              <h2>Pending account verification</h2>
              <p>
                Only your requests appear here. Resume with the original account
                password if you closed the form.
              </p>
              <div className="account-grid">
                {pendingRequests.map((pending) => (
                  <article className="account-card" key={pending.request_id}>
                    <h3>{pending.name}</h3>
                    <p>
                      {pending.masked_email} · {roleLabel(pending.role)}
                    </p>
                    <p>
                      {pending.status === "creating"
                        ? "Setup needs completion"
                        : "Waiting for email verification"}
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setDialog({ kind: "pending_creation", pending })
                      }
                    >
                      Resume verification for {pending.name}
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          )}
          {data?.summary && (
            <div className="metric-grid fx-stagger account-metrics">
              {[
                ["Total accounts", data.summary.total, UsersRound],
                ["Active admins", data.summary.admins, ShieldCheck],
                ["Active agents", data.summary.agents, UserRound],
                ["Active staff", data.summary.staff ?? 0, Briefcase],
                ["Disabled accounts", data.summary.disabled, LockKeyhole],
              ].map(([label, value, Icon]) => (
                <section className="metric fx-card" key={label}>
                  <div>
                    <span>{label}</span>
                    <Icon size={20} />
                  </div>
                  <strong>{value}</strong>
                </section>
              ))}
            </div>
          )}
          <section className="panel">
            <div className="toolbar">
              <input
                type="search"
                aria-label="Search accounts"
                placeholder="Search by name, email or UID…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
              <select
                aria-label="Filter account role"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All roles</option>
                <option value="admin">Admins</option>
                <option value="agent">Agents</option>
                <option value="staff">Staff</option>
              </select>
              <select
                aria-label="Filter account access"
                value={access}
                onChange={(e) => {
                  setAccess(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All access</option>
                <option value="active">Active</option>
                <option value="disabled">Suspended</option>
                <option value="pending">Pending verification</option>
                <option value="expired">Expired invitations</option>
                <option value="cancelled">Cancelled invitations</option>
                <option value="deleting">Deletion pending</option>
              </select>
            </div>
            <ErrorBox error={pageError} />
            {loading ? (
              <Loader />
            ) : data?.data?.length ? (
              <div className="account-grid fx-stagger">
                {data.data.map((account) => (
                  <article className="account-card fx-card" key={account.id}>
                    <div className="account-person">
                      <span className="account-avatar">
                        {account.name.charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <h3>{account.name}</h3>
                        <span className="account-role">
                          {roleLabel(account.role)}
                          {account.id === user.id ? " · You" : ""}
                        </span>
                      </div>
                      <span className={`account-status ${statusTone(account)}`}>
                        {accountStatus(account)}
                      </span>
                    </div>
                    <p className="account-uid-line">
                      <Hash size={16} aria-hidden="true" />
                      <span className="account-uid-label">UID</span>
                      <AccountUid uid={account.uid} />
                    </p>
                    <p className="account-email">
                      <Mail size={16} aria-hidden="true" />
                      {account.email || "No email available"}
                    </p>
                    <p className="account-signin">
                      <Clock3 size={16} aria-hidden="true" />
                      {account.last_sign_in_at
                        ? date(account.last_sign_in_at)
                        : "Never signed in"}
                    </p>
                    <div className="account-actions account-card-actions">
                      <Button
                        variant="secondary"
                        aria-label={`Details for ${account.name}`}
                        onClick={() => setDialog({ kind: "details", account })}
                      >
                        <Eye size={16} aria-hidden="true" /> Details
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={`Edit ${account.name}`}
                        disabled={
                          account.account_status === "deletion_pending" ||
                          account.account_creation_pending
                        }
                        onClick={() => setDialog({ kind: "edit", account })}
                      >
                        <Pencil size={16} aria-hidden="true" /> Edit
                      </Button>
                      {needsAccountCode(account) &&
                        !account.account_creation_pending &&
                        account.account_status !== "deletion_pending" && (
                          <Button
                            variant="secondary"
                            aria-label={`Verify email for ${account.name}`}
                            onClick={() =>
                              setDialog({ kind: "email_code", account })
                            }
                          >
                            <Mail size={16} aria-hidden="true" />
                            Verify email
                          </Button>
                        )}
                      {account.id !== user.id &&
                        !account.account_creation_pending &&
                        account.account_status !== "deletion_pending" &&
                        !needsInvitation(account) &&
                        !!account.email_confirmed_at && (
                          <Button
                            variant="secondary"
                            aria-label={`${account.active ? "Disable" : "Enable"} ${account.name}`}
                            onClick={() =>
                              setDialog({ kind: "access", account })
                            }
                          >
                            <Power size={16} aria-hidden="true" />
                            {account.active ? "Disable" : "Enable"}
                          </Button>
                        )}
                      {account.id !== user.id && (
                        <Button
                          variant="danger"
                          className="account-delete-button"
                          aria-label={`Delete ${account.name}`}
                          onClick={() => setDialog({ kind: "delete", account })}
                        >
                          <Trash2 size={16} />
                          {account.account_status === "deletion_pending"
                            ? "Retry delete"
                            : "Delete"}
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              !pageError && (
                <div className="empty">No accounts match your filters.</div>
              )
            )}
            <Pagination page={page} count={data?.count || 0} onPage={setPage} />
          </section>
        </>
      )}
      {grant && dialog?.kind === "pending_creation" && (
        <PendingAccountVerification
          key={dialog.pending.request_id}
          pending={dialog.pending}
          request={request}
          onClose={() => setDialog(null)}
          onSaved={saved}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
      {grant && dialog?.kind === "created" && (
        <AccountCreated
          account={dialog.account}
          onClose={() => setDialog(null)}
        />
      )}
      {grant &&
        dialog &&
        !["pending_creation", "created"].includes(dialog.kind) && (
          <AccountDialog
            key={`${dialog.kind}:${dialog.account?.id || "new"}`}
            dialog={dialog}
            user={user}
            request={request}
            onClose={() => setDialog(null)}
            onSaved={saved}
            onChanged={() => setRefresh((value) => value + 1)}
          />
        )}
    </>
  );
}
