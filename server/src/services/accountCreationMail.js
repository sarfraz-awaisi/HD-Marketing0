import nodemailer from "nodemailer";
import { z } from "zod";
const unavailable = () =>
  Object.assign(
    new Error(
      "Configure the account verification email sender on the server. See docs/ACCOUNT_CREATION_OTP.md.",
    ),
    { status: 503 },
  );
export function accountMailConfig(env = process.env) {
  const provider = env.ACCOUNT_EMAIL_PROVIDER;
  const from = env.ACCOUNT_EMAIL_FROM?.trim();
  if (!z.email().safeParse(from).success) throw unavailable();
  if (provider === "resend" && env.RESEND_API_KEY?.trim())
    return { provider, from, key: env.RESEND_API_KEY };
  if (
    provider === "smtp" &&
    env.ACCOUNT_SMTP_HOST?.trim() &&
    env.ACCOUNT_SMTP_USER?.trim() &&
    env.ACCOUNT_SMTP_PASSWORD
  ) {
    const port = Number(env.ACCOUNT_SMTP_PORT || 587);
    if (![465, 587, 2525].includes(port)) throw unavailable();
    return {
      provider,
      from,
      host: env.ACCOUNT_SMTP_HOST,
      port,
      user: env.ACCOUNT_SMTP_USER,
      password: env.ACCOUNT_SMTP_PASSWORD,
    };
  }
  throw unavailable();
}
export async function sendAccountCreationEmail(
  { email, code, id, version },
  options = {},
) {
  const config = accountMailConfig(options.env);
  const text = `Hello,\n\nAn administrator has requested a new HD Marketing CRM account using this email address.\n\nYour verification code is:\n\n${code}\n\nThis code expires in 10 minutes.\n\nIf you were not expecting this request, you can ignore this email.\n\nHD Marketing CRM Team`;
  // Recipient names/addresses never enter HTML. The only interpolation is a
  // locally generated six-digit code, not caller-controlled markup.
  const html = `<div style="font-family:Arial,sans-serif;color:#172c43;max-width:520px;padding:24px"><h2>Verify your email address</h2><p>An administrator has requested a new HD Marketing CRM account using this email address.</p><p>Your verification code is:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes.</p><p>If you were not expecting this request, you can ignore this email.</p><p>HD Marketing CRM Team</p></div>`;
  try {
    if (config.provider === "resend") {
      const response = await (options.fetch || fetch)(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.key}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `account-${id}-${version}`,
          },
          body: JSON.stringify({
            from: `HD Marketing CRM <${config.from}>`,
            to: [email],
            subject: "HD Marketing CRM — Email Verification Code",
            text,
            html,
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok || typeof (await response.json()).id !== "string")
        throw new Error();
    } else {
      const transport = (options.createTransport || nodemailer.createTransport)(
        {
          host: config.host,
          port: config.port,
          secure: config.port === 465,
          requireTLS: true,
          tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
          auth: { user: config.user, pass: config.password },
          pool: false,
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
          disableFileAccess: true,
          disableUrlAccess: true,
          logger: false,
          debug: false,
        },
      );
      try {
        const result = await transport.sendMail({
          from: { name: "HD Marketing CRM", address: config.from },
          to: email,
          subject: "HD Marketing CRM — Email Verification Code",
          text,
          html,
        });
        if (
          !result.accepted?.some(
            (address) => String(address).toLowerCase() === email,
          )
        )
          throw new Error();
      } finally {
        transport.close();
      }
    }
  } catch {
    throw Object.assign(
      new Error(
        "Verification email could not be sent. Check the sender settings, wait for the cooldown, then resend. No account has been activated.",
      ),
      { status: 503 },
    );
  }
}
