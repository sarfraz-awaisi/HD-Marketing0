export function whatsapp() {
  throw Object.assign(
    new Error(
      "WhatsApp integration disabled: explicit messaging workflow required",
    ),
    { status: 503 },
  );
}
