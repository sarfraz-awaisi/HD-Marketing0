// Staff accounts (update 047) use only their own workspace: profile,
// notifications, attendance (with leave and corrections) and daily tasks.
// Every other API request from a staff account is refused here, so a route
// added later is closed to staff until it is listed below. The database
// functions check the role, ownership and dates again.
const allowed = [
  ["GET", /^\/me$/],
  ["GET", /^\/profile$/],
  ["GET", /^\/notifications$/],
  ["POST", /^\/notifications\/read$/],
  [null, /^\/attendance(\/[^/]+)*$/],
  [null, /^\/tasks(\/[^/]+)*$/],
];
export function staffAccess(req, res, next) {
  if (req.user?.role !== "staff") return next();
  const path = (req.baseUrl + req.path).replace(/^\/api/, "") || "/";
  if (
    allowed.some(
      ([method, pattern]) =>
        (!method || method === req.method) && pattern.test(path),
    )
  )
    return next();
  res.status(403).json({
    error: "This part of the CRM is not available to staff accounts.",
    code: "STAFF_NOT_ALLOWED",
  });
}
