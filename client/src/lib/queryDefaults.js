import { retryQuery } from "./api";

// Defaults for every query (main.jsx). Switching back to the CRM within a
// minute (for example from a call or WhatsApp) reuses what is on screen
// instead of reloading every list on the page. Changes made here still
// refresh what they change, and polling pauses while the tab is hidden.
export const queryDefaults = {
  queries: {
    retry: retryQuery,
    staleTime: 60000,
    refetchOnWindowFocus: true,
  },
};
