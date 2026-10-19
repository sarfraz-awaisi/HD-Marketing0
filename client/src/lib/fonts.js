export function loadFonts() {
  const load = () => {
    if (document.getElementById("crm-fonts")) return;
    const link = document.createElement("link");
    link.id = "crm-fonts";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap";
    document.head.append(link);
  };
  if (window.requestIdleCallback)
    window.requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 0);
}
