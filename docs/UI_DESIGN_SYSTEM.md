# UI design system (October 2026 redesign)

The CRM frontend was restyled on 19 October 2026 after a reference dashboard: a white compact sidebar, a slim top bar, light grey page, small white cards with thin borders and soft shadows, compact KPI tiles, a navy highlight card and a recent-activity column. HD Marketing's navy and gold branding is kept. Only the frontend changed: no API, database, permission, attendance rule, job or business calculation was modified, and no new dependency was added.

## Stylesheet layers

They are loaded in this order (`client/src/main.jsx`, then per page):

| File | Role |
| --- | --- |
| `styles/index.css` | Original base and page-specific rules (unchanged except the record-table minimum width). |
| `styles/animations.css` | Motion system (`fx-*` classes), now subtler and faster. |
| `styles/tokens.css` | Design tokens: brand, surfaces, text, status colours, type scale, spacing, radii, shadows, layout sizes and motion timings. Legacy names (`--navy`, `--gold`, `--line`, `--muted`…) are aliases, so older rules and the attendance command center use the same palette. |
| `styles/theme.css` | Design layer for shared building blocks: shell, sidebar, top bar, menus, page heading, cards, KPI metrics, buttons, fields, tables, badges, segmented tabs, lists, empty/error/notice states, dialogs, toasts, loading, sign-in and responsive rules. |
| `styles/dashboard.css` | Overview dashboards only (imported by `pages/admin/Dashboard.jsx`). |
| `styles/attendance-command.css` | Attendance Command Center (unchanged; picks up the tokens). |

To change a colour, size or timing everywhere, edit `tokens.css`. To change how a shared element looks, edit `theme.css`. Page-specific tweaks stay in `index.css`.

## Key tokens

- Brand: navy `#14283F` (primary buttons, active navigation, highlight card), gold `#B68C45` (accents, focus ring, links in card headings).
- Page `#F4F6F9`, cards white with border `#E6EAF0`, radius 12 px (cards), 10 px (tiles), 8 px (buttons, fields), 6 px (badges).
- Text: headings `#142238`, body `#2B3A50`, muted `#66758A`.
- Status pairs (text on soft background): success, warning, danger, info and neutral.
- Type: Manrope for headings and figures, DM Sans for everything else; base text 14 px, page titles 22 px, card titles 15 px.
- Controls are 40 px high with a mouse and 44 px on touch screens (`pointer: coarse`).

## Layout

- **Sidebar** (`components/layout/Layout.jsx`, sections in `components/layout/navigation.js`): white, grouped into Sales, Resources, Team and Administration for admins (Sales, Resources and My work for agents). Every path, label and role restriction is the same as before. The active page is a navy pill with a gold icon. **Sign out** sits at the bottom.
- **Collapse**: the panel button in the top bar shrinks the sidebar to icons (names stay available to screen readers and as hover titles). The choice is remembered in this browser only. Below 801 px the sidebar is a slide-in drawer instead.
- **Top bar**: breadcrumb (HD Marketing / section / page), notification bell and a profile button that opens **My profile** (name, email, role, UID) with **Sign out**. The bar stays at the top while scrolling; the notification and profile menus are fixed below it.

## Dashboards

`pages/admin/Dashboard.jsx` with widgets from `components/dashboard/Widgets.jsx`:

- Greeting with the first name and today's date in Pakistan time.
- **Sales summary** and **First calls** sections of compact KPI tiles; the on-time rate is drawn as a ring.
- **Lead pipeline** (stacked stage bar and per-stage rows) beside **Follow-ups due**.
- Right column: a navy **Business this month / My month so far** card (closed revenue, won deals, upcoming visits and a leads-by-stage bar chart) and **Recent activity** (the latest notifications, from the same request the bell uses).
- Admin review tables (**Leads waiting for your decision**, **Today's calling**) or the agent's **My calls today** run full width below, followed by the attention, social, security, system-status and leaderboard cards and the scheduled visits.

Every figure comes from the existing `GET /api/dashboard` and `GET /api/notifications` responses. Nothing is estimated; there are no month-over-month comparisons because the API returns current-month totals only.

## Sign-in page (20 October 2026)

`pages/Login.jsx`, `components/login/GlassForm.jsx` and `styles/login.css` (scoped to `.glass-login-page`):

- Full-screen office photograph (`assets/login/office-sunset-1600.webp`, 56 KB; `office-sunset-960.webp`, 26 KB, for screens up to 960 px) with a light navy wash.
- A frosted-glass frame holding two sides: the active sign-in form in a brighter glass card, and a switch panel showing the other role (title, description and an **Open … Login** button). The circular ↔ button between them is labelled **Switch to Admin Login** / **Switch to Agent Login**.
- Switching slides the card and the switch panel past each other in 680 ms (`cubic-bezier(0.65, 0, 0.35, 1)`). The old form fades out, the new one appears halfway, and repeated clicks always end on the last choice. With reduced motion the swap is instant.
- Up to 960 px wide there is one card with a compact **Admin | Agent** pill switch at the top.
- Only one real form is on the page at a time. Sign-in still goes through `signInToPortal`, so the server-side role check, lockout, login history, two-factor step, saved-email suggestions and password reset behave exactly as before. There is no sign-up.
- **Remember me** from the reference design is not shown: the CRM keeps sessions with a fixed policy (30-minute inactivity sign-out), so a checkbox would not change anything.

## Motion

See `ANIMATIONS.md`. In short: 140–300 ms transitions, 1–2 px hover lifts, dialog fade-out on close, toast fade-out, segmented-tab easing and chart grow-in. Everything stops when the device asks for reduced motion.

## Preview locally

```sh
cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
npm run dev
```

Open the address Vite prints (normally http://127.0.0.1:5173). The local CRM still reads the database configured in `.env`; the redesign itself makes no data changes. To roll back, copy the files back from `/Users/air/Desktop/HD marketing/backup-before-ui-redesign/client/`.
