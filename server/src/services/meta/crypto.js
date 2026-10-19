import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
export function encryptToken(token, key, context) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const value = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    "gcm1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    value.toString("hex"),
  ].join(":");
}
export function decryptToken(value, key, context) {
  try {
    const [version, iv, tag, data] = value.split(":");
    if (version !== "gcm1") throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      Buffer.from(iv, "hex"),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw Object.assign(
      new Error("Meta credentials could not be opened. Reconnect the account."),
      { code: "credential_error", retry: false },
    );
  }
}
export function validSignature(body, signature, secret) {
  if (!Buffer.isBuffer(body) || !/^sha256=[a-f0-9]{64}$/i.test(signature || ""))
    return false;
  const actual = Buffer.from(signature.slice(7), "hex"),
    expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(actual, expected);
}
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a || ""),
    right = Buffer.from(b || "");
  return left.length === right.length && timingSafeEqual(left, right);
}
