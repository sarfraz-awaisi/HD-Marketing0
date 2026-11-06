import { useCallback, useLayoutEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
// A report drill-down kept in the address (updates 050 and 051), so returning
// from a lead's details brings back the same list: which report (dr, where a
// page has more than one), metric (dm), key (dk; "none" means not set),
// search, status, assigned agent, sort and page.
export const drillParams = ["dr", "dm", "dk", "dq", "ds", "do", "dsort", "dp"];
export function useDrillUrl() {
  const [url, setUrl] = useSearchParams();
  // setUrl's updater sees the address of the last render, so two quick
  // changes (a tab, then a date) would lose the first. Each change builds on
  // the latest one instead.
  const latest = useRef(url);
  useLayoutEffect(() => {
    latest.current = url;
  }, [url]);
  const change = useCallback(
    (values) => {
      const next = new URLSearchParams(latest.current);
      for (const [k, v] of Object.entries(values))
        if (v === undefined || v === null || v === "") next.delete(k);
        else next.set(k, String(v));
      latest.current = next;
      setUrl(next, { replace: true });
    },
    [setUrl],
  );
  const rawKey = url.get("dk");
  const drill = {
    report: url.get("dr"),
    metric: url.get("dm"),
    rawKey,
    key: rawKey === null ? undefined : rawKey === "none" ? null : rawKey,
    state: {
      search: url.get("dq") || "",
      status: url.get("ds") || "",
      owner: url.get("do") || "",
      sort: url.get("dsort") || "",
      page: Number(url.get("dp")) || 1,
    },
  };
  const open = useCallback(
    (metric, key, report) =>
      change({
        dr: report,
        dm: metric,
        dk: key === undefined ? null : key === null ? "none" : key,
        dq: null,
        ds: null,
        do: null,
        dsort: null,
        dp: null,
      }),
    [change],
  );
  const close = useCallback(
    () => change(Object.fromEntries(drillParams.map((k) => [k, null]))),
    [change],
  );
  const setState = useCallback(
    (values) =>
      change({
        ...("search" in values ? { dq: values.search } : {}),
        ...("status" in values ? { ds: values.status } : {}),
        ...("owner" in values ? { do: values.owner } : {}),
        ...("sort" in values ? { dsort: values.sort } : {}),
        ...("page" in values
          ? { dp: values.page > 1 ? values.page : null }
          : {}),
      }),
    [change],
  );
  return { url, change, drill, open, close, setState };
}
