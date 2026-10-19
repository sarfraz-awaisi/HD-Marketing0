import { createHash } from "node:crypto";
const clients = new WeakMap();
// Share only overlapping native Auth requests. Never retain completed decisions.
export function authRequest(db, method, token) {
  let pending = clients.get(db);
  if (!pending) {
    pending = new Map();
    clients.set(db, pending);
  }
  const key = method + ":" + createHash("sha256").update(token).digest("hex");
  if (pending.has(key)) return pending.get(key);
  const request = Promise.resolve().then(() => db.auth[method](token));
  if (pending.size < 256) {
    pending.set(key, request);
    const remove = () => {
      if (pending.get(key) === request) pending.delete(key);
    };
    request.then(remove, remove);
  }
  return request;
}
