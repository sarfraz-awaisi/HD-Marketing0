import { it, expect, vi } from "vitest";
import {
  accountMailConfig,
  sendAccountCreationEmail,
} from "../src/services/accountCreationMail.js";
import {
  creationSecret,
  creationDigest,
} from "../src/services/accountCreation.js";
const data = {
  id: "synthetic-request",
  version: "synthetic-version",
  email: "recipient@example.test",
  code: "001234",
};
it("fails closed when sender credentials or the independent hash key are missing", () => {
  expect(() => accountMailConfig({})).toThrow("Configure");
  expect(() =>
    accountMailConfig({
      ACCOUNT_EMAIL_PROVIDER: "smtp",
      ACCOUNT_EMAIL_FROM: "a@example.test",
      ACCOUNT_SMTP_HOST: "smtp.example.test",
      ACCOUNT_SMTP_USER: "u",
      ACCOUNT_SMTP_PASSWORD: "secret",
      ACCOUNT_SMTP_PORT: "25",
    }),
  ).toThrow("Configure");
  expect(() => creationSecret({})).toThrow("ACCOUNT_OTP_SECRET");
  expect(() => creationSecret({ ACCOUNT_OTP_SECRET: "short" })).toThrow(
    "ACCOUNT_OTP_SECRET",
  );
});
it("binds digests to purpose, request, version and code without retaining the input", () => {
  const secret = "a".repeat(64);
  const hash = creationDigest(secret, "otp-v1", "r", "v", "001234");
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(creationDigest(secret, "otp-v1", "r", "v2", "001234")).not.toBe(hash);
  expect(creationDigest(secret, "binding-v1", "r", "v", "001234")).not.toBe(
    hash,
  );
});
it("sends through Resend with bounded timeout and an idempotency key", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "provider-id" }) });
  await sendAccountCreationEmail(data, {
    env: {
      ACCOUNT_EMAIL_PROVIDER: "resend",
      ACCOUNT_EMAIL_FROM: "sender@example.test",
      RESEND_API_KEY: "private-test-key",
    },
    fetch,
  });
  const [url, args] = fetch.mock.calls[0];
  expect(url).toBe("https://api.resend.com/emails");
  expect(args.headers["Idempotency-Key"]).toBe(
    "account-synthetic-request-synthetic-version",
  );
  const body = JSON.parse(args.body);
  expect(body.to).toEqual([data.email]);
  expect(body.text).toContain("001234");
  expect(body.html).toContain("001234");
  expect(body.subject).toContain("Email Verification");
  expect(args.signal).toBeInstanceOf(AbortSignal);
});
it("sanitizes provider errors without printing the email or code", async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ message: "private response 001234" }),
  });
  await expect(
    sendAccountCreationEmail(data, {
      env: {
        ACCOUNT_EMAIL_PROVIDER: "resend",
        ACCOUNT_EMAIL_FROM: "sender@example.test",
        RESEND_API_KEY: "private-test-key",
      },
      fetch,
    }),
  ).rejects.toThrow("Verification email could not be sent");
});
it("uses authenticated TLS SMTP without pools, debug logs, files or URLs and closes the connection", async () => {
  const sendMail = vi.fn().mockResolvedValue({ accepted: [data.email] });
  const close = vi.fn();
  const createTransport = vi.fn().mockReturnValue({ sendMail, close });
  await sendAccountCreationEmail(data, {
    env: {
      ACCOUNT_EMAIL_PROVIDER: "smtp",
      ACCOUNT_EMAIL_FROM: "sender@example.test",
      ACCOUNT_SMTP_HOST: "smtp.gmail.com",
      ACCOUNT_SMTP_USER: "sender@example.test",
      ACCOUNT_SMTP_PASSWORD: "private-app-password",
      ACCOUNT_SMTP_PORT: "587",
    },
    createTransport,
  });
  expect(createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      port: 587,
      secure: false,
      requireTLS: true,
      pool: false,
      debug: false,
      logger: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    }),
  );
  expect(sendMail.mock.calls[0][0].text).toContain("001234");
  expect(close).toHaveBeenCalledTimes(1);
});
it("treats SMTP recipient rejection as a send failure", async () => {
  const close = vi.fn();
  await expect(
    sendAccountCreationEmail(data, {
      env: {
        ACCOUNT_EMAIL_PROVIDER: "smtp",
        ACCOUNT_EMAIL_FROM: "sender@example.test",
        ACCOUNT_SMTP_HOST: "smtp.example.test",
        ACCOUNT_SMTP_USER: "sender@example.test",
        ACCOUNT_SMTP_PASSWORD: "private-app-password",
      },
      createTransport: () => ({
        sendMail: async () => ({ accepted: [] }),
        close,
      }),
    }),
  ).rejects.toThrow("could not be sent");
  expect(close).toHaveBeenCalled();
});
