import { Router } from "express";
import { reportLimit } from "../middleware/rateLimit.js";
import { reportDrilldownQuery } from "../utils/validators.js";
import { salesRpc } from "./sales.routes.js";
// Report drill-down (update 050): the records behind one report number.
// Administrators open anyone's; agents only their own (update 051): the
// database sets the agent to the signed-in agent and refuses everyone else.
// Staff are refused before this router. The database repeats the report's
// own conditions and writes nothing.
// Contact numbers stay masked here: a full number is shown, and its reveal
// audited, only when the lead itself is opened, so browsing reports (paging,
// searching, refreshing) never reveals numbers in bulk.
export function reportDrilldownRouter(db) {
  const router = Router();
  router.get("/", reportLimit, async (req, res) => {
    const { key, ...q } = reportDrilldownQuery.parse(req.query);
    res.set("Cache-Control", "no-store").json(
      await salesRpc(
        db,
        "report_drilldown",
        {
          p_actor: req.user.id,
          p_query: {
            ...q,
            ...(key === undefined ? {} : { key: key === "none" ? null : key }),
          },
        },
        "050 after 048",
      ),
    );
  });
  return router;
}
