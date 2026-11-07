import { useCallback, useLayoutEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
// A list's search, filters, sort and page kept in the address (update 052),
// so going back from a lead's details returns to the same list. As in
// useDrillUrl, each change builds on the latest address, so two quick
// changes never lose the first.
export function useUrlFilters(keys) {
  const [url, setUrl] = useSearchParams();
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
  return [Object.fromEntries(keys.map((k) => [k, url.get(k) || ""])), change];
}
