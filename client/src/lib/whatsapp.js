// WhatsApp click-to-chat (update 053): opens a chat with the customer's
// number in WhatsApp; nothing is sent and no call is logged. Pakistani
// numbers may be written +92…, 92…, 0092…, 03… or 3… (ten digits); other
// numbers need their country code. Anything else gets no link.
export function whatsappNumber(phone) {
  if (typeof phone !== "string") return null;
  const text = phone.trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  let digits = text.replace(/\D/g, "");
  if (!text.startsWith("+")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (/^03\d{9}$/.test(digits)) digits = "92" + digits.slice(1);
    else if (/^3\d{9}$/.test(digits)) digits = "92" + digits;
  }
  // +92 0300… keeps the 0 by mistake; WhatsApp would not find that number.
  if (digits.startsWith("920")) return null;
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}
export function whatsappLink(phone) {
  const number = whatsappNumber(phone);
  return number ? `https://wa.me/${encodeURIComponent(number)}` : null;
}
