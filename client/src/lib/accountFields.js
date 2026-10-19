import { z } from "zod";
// Mirrors server/src/services/accountProvisioning.js; the server re-checks all.
export const GMAIL_ONLY_MESSAGE =
  "Only valid @gmail.com email addresses are allowed.";
export const UID_TAKEN_MESSAGE =
  "This UID is already assigned to another account. Please choose a different UID.";
const emailSyntax = z.email();
export const normalizeEmail = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();
// Domain and syntax only; this cannot prove that Google registered the mailbox.
export function gmailError(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 &&
    emailSyntax.safeParse(email).success &&
    /^[^@]+@gmail\.com$/.test(email)
    ? ""
    : GMAIL_ONLY_MESSAGE;
}
export function uidError(value) {
  const uid = String(value ?? "");
  if (!uid) return "Enter the 6-digit UID.";
  if (!/^\d+$/.test(uid)) return "Use numbers only (0–9).";
  if (uid.length !== 6) return "Enter exactly 6 digits.";
  if (uid.startsWith("0")) return "The UID cannot begin with 0.";
  return "";
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older or non-secure browser contexts: fall back to a temporary selection.
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}
