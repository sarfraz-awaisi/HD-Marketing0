const key = "hd-marketing-login-emails-v1";
const roles = ["agent", "admin", "staff"];
const limit = 5;
function emailAddress(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}
function history() {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "{}");
    return Object.fromEntries(
      roles.map((role) => [
        role,
        [
          ...new Set(
            (Array.isArray(stored?.[role]) ? stored[role] : [])
              .slice(0, 100)
              .map(emailAddress)
              .filter(Boolean),
          ),
        ].slice(0, limit),
      ]),
    );
  } catch {
    return { agent: [], admin: [], staff: [] };
  }
}
export function savedLoginEmails(role) {
  return roles.includes(role) ? history()[role] : [];
}
export function rememberLoginEmail(role, value) {
  const email = emailAddress(value);
  if (!roles.includes(role) || !email) return;
  try {
    const stored = history();
    stored[role] = [email, ...stored[role].filter((v) => v !== email)].slice(
      0,
      limit,
    );
    // This device history contains only email strings, never credentials.
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Remembering an email must never prevent authentication.
  }
}
