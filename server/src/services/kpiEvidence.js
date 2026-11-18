import { createHash } from "node:crypto";
export { signatureType } from "../utils/imageType.js";
// Evidence for KPIs the CRM fills in (update 072): links to social media
// posts and videos, and project-visit photos. The database checks again.

// Facebook, Instagram, TikTok and YouTube, on their own domains or any
// subdomain of them (www., m., web., vm.).
const PLATFORMS = [
  ["facebook", ["facebook.com", "fb.watch"]],
  ["instagram", ["instagram.com"]],
  ["tiktok", ["tiktok.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
];
// Query parameters that name the post or video; the rest (tracking, share
// sources) do not make a link different.
const NAMING = { facebook: ["v", "story_fbid", "fbid", "id"], youtube: ["v"] };
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

// A link an agent adds, checked: https only (http is upgraded, a bare
// "www.…" gets https://), no user name, password or port, on a supported
// platform, and naming a page rather than the site itself. Returns the link
// to keep, its platform and a key that two forms of one link share (so a
// video added as youtu.be/ID and youtube.com/watch?v=ID is the same), or
// null when the link is not accepted.
export function evidenceLink(input) {
  const text = String(input ?? "").trim();
  if (!text || text.length > 600 || /[\s<>"']/.test(text)) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text);
  } catch {
    return null;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  const host = url.hostname.toLowerCase();
  const platform = PLATFORMS.find(([, domains]) =>
    domains.some((d) => host === d || host.endsWith("." + d)),
  )?.[0];
  if (!platform || url.pathname.length < 2) return null;
  url.hash = "";
  const bare = host.replace(/^(www|m|mobile|web)\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  let key = null;
  if (platform === "youtube") {
    const id =
      bare === "youtu.be"
        ? path.slice(1)
        : path === "/watch"
          ? url.searchParams.get("v")
          : /^\/(shorts|live|embed)\/([^/]+)$/.exec(path)?.[2];
    if (id && YOUTUBE_ID.test(id)) key = "youtube:" + id;
  }
  if (!key) {
    const naming = (NAMING[platform] || [])
      .filter((name) => url.searchParams.get(name))
      .map((name) => name + "=" + url.searchParams.get(name));
    key = bare + path + (naming.length ? "?" + naming.join("&") : "");
  }
  const href = url.href;
  if (href.length < 12 || href.length > 600 || key.length > 600) return null;
  return { url: href, url_key: key, platform };
}

// The same image file, whoever sends it, has the same hash.
export const fileHash = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
