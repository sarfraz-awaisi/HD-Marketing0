import { useCallback, useEffect, useRef, useState } from "react";
// Shared by every open tab, so activity in one tab keeps the others alive.
export const ACTIVITY_KEY = "hd-crm-last-activity";
export const SIGNED_OUT_KEY = "hd-crm-signed-out";
export function idleSettings(
  value = import.meta.env.VITE_IDLE_TIMEOUT_MINUTES,
) {
  const minutes = Number(value || 30);
  const limit =
    Number.isFinite(minutes) && minutes >= 5 && minutes <= 480 ? minutes : 30;
  return { limit: limit * 60000, warning: Math.min(5, limit / 2) * 60000 };
}
const readShared = () => {
  try {
    return Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeShared = (time) => {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(time));
  } catch {
    // Storage can be blocked; this tab still tracks its own activity.
  }
};
// Wall-clock based, so a laptop that slept past the limit signs out on wake.
export function useIdleLogout(onTimeout, settings = idleSettings()) {
  const last = useRef(Date.now());
  const written = useRef(0);
  const fired = useRef(false);
  const [remaining, setRemaining] = useState(null);
  const touch = useCallback(() => {
    const now = Date.now();
    // Throttle shared writes by the last write, so continuous mouse movement
    // still refreshes the shared time other tabs read.
    if (now - written.current > 5000) {
      writeShared(now);
      written.current = now;
    }
    last.current = now;
    setRemaining(null);
  }, []);
  useEffect(() => {
    writeShared(last.current);
    written.current = last.current;
    const events = [
      "mousedown",
      "mousemove",
      "keydown",
      "touchstart",
      "wheel",
      "scroll",
    ];
    for (const name of events)
      window.addEventListener(name, touch, { passive: true, capture: true });
    const visible = () => {
      if (document.visibilityState === "visible") check();
    };
    const check = () => {
      if (fired.current) return;
      const idle = Date.now() - Math.max(last.current, readShared());
      if (idle >= settings.limit) {
        fired.current = true;
        setRemaining(null);
        onTimeout();
      } else if (idle >= settings.limit - settings.warning)
        setRemaining(Math.ceil((settings.limit - idle) / 1000));
      else setRemaining(null);
    };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(check, 1000);
    return () => {
      for (const name of events)
        window.removeEventListener(name, touch, { capture: true });
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
    };
  }, [onTimeout, settings.limit, settings.warning, touch]);
  return { remaining, stay: touch };
}
