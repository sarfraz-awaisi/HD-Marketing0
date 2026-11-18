// JPEG, PNG or WebP, from the file's first bytes (never its name or the
// browser's word for it).
export function signatureType(buffer) {
  if (
    buffer
      ?.subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer?.[0] === 255 && buffer?.[1] === 216 && buffer?.[2] === 255)
    return "image/jpeg";
  if (
    buffer?.subarray(0, 4).toString() === "RIFF" &&
    buffer?.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
