import { normalizePhone, phoneMask } from "../utils/phoneMask.js";

const identity =
  /^(?:mock-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const phoneText =
  /(?<![\p{L}\p{N}])(?:\+(?:\d[ ().-]?){9,14}\d|00(?:\d[ ().-]?){9,14}\d|03(?:\d[ ().-]?){8}\d|92(?:\d[ ().-]?){9}\d)(?!\d)/gu;

// Defend JSON free-text fields as well as structured records. Numeric business
// amounts and real UUID identities are preserved. Reveals opt in only after SQL.
export function maskAgentResponse(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    if (identity.test(value)) return value;
    return value.replace(phoneText, (match) => {
      try {
        return phoneMask(normalizePhone(match));
      } catch {
        return "[number hidden]";
      }
    });
  }
  if (Array.isArray(value)) return value.map(maskAgentResponse);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        maskAgentResponse(item),
      ]),
    );
  return value;
}
export function protectAgentPhones(req, res, next) {
  if (req.user.role === "agent") {
    const json = res.json.bind(res);
    res.json = (data) => {
      if (req.phoneRevealResponse === true) return json(data);
      const safe = maskAgentResponse(data);
      if (req.visibleLeadPhones) {
        const restore = (row) => ({
          ...row,
          phone: req.visibleLeadPhones[row.id] || null,
        });
        if (Array.isArray(safe.data)) safe.data = safe.data.map(restore);
        else if (safe.id) return json(restore(safe));
      }
      return json(safe);
    };
  }
  next();
}
