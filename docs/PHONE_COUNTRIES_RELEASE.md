# Update 065: country flags and the Country filter

Every lead's number shows its country's flag, and All leads and the Lead pipeline can be filtered by country. Builds on update 064, phone numbers from any country.

## What people see

- **A flag beside each number** the user may see: All leads, Assigned leads, both Lead pipeline pages, the lead page and the call dialog. A number that cannot be placed in one country gets a globe (🌐), never a guessed flag. Numbers are shown as stored.
- **Country filter** on All leads (administrators) and the Lead pipeline (agents: their own leads; administrators: one agent's pipeline):
  - a searchable list of every country the phone-number library knows, by name, code or calling code (`+971`);
  - **All countries** first, then Pakistan and **Unknown country**;
  - it works with the other filters, search, pages and Select all matching, and a chip removes it.
- **Counts:** totals and pages follow the filter. On an agent's pipeline as administrators see it, Personally contacted and the temperatures become that country's while a country is chosen; Follow-ups due stay the agent's whole pipeline. On an agent's own pipeline the temperature counts follow the filter, and My pipeline and Personally contacted stay totals (update 055's rule).

## How the country is decided

Owner decision (13 November 2026): derive it, store nothing per lead.

- The server uses libphonenumber-js, as for update 064. The database uses the same rules, generated from the library into `crm_private.phone_country_rules` by `scripts/phone-country-rules.mjs`.
- A calling code used by one country gives that country, so every `+92…` number is Pakistan's. A shared code (+1, +7, +44, +61 and eight others) is settled by area code or leading digits, as the library does: +1 416 is Canada, +1 212 the United States, +1 876 Jamaica. An unused area code (+1 555…) and non-geographic numbers are Unknown country.
- A test checks that the migration holds exactly the rules the installed library gives, and that the database and the library agree on over 2,000 numbers. When the library's numbering data changes, a new migration replaces the rules.

| Item            | Value                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| Migration       | `supabase/migrations/065_phone_countries.sql` (no changes to existing rows; safe to rerun) |
| Read-only check | `supabase/check-phone-countries-065.sql`                                                   |
| Requires        | update 064 in production                                                                   |

**What 065 changes in the database:**

- **Adds** the rules table (245 rows of reference data) and two helpers, `phone_country` and `lead_phone_country`. Only the list functions use them; browsers and the API server cannot call them.
- **Checked edits:**
  - `admin_lead_list`, `agent_lead_list` and `admin_agent_pipeline` accept `country`, a country code or `unknown`;
  - `admin_agent_pipeline` also returns the numbers of the leads it lists.

  Without a country, every list answers exactly as before (tested).

**Release:**

1. Back up the database and test the restore.
2. Run the check. It should read `at 064, ready for 065`.
3. Apply 065 and run the check again. It should read `at 065`, with `country_rules` = 245, both access counts 0 and the same record counts; `numbers_by_country` shows the spread.
4. Deploy the code.

Apply 065 before the code. Until it is applied, the new code shows flags but says "The Country filter needs CRM database update 065 after 064" when a country is chosen.

**Rollback:** roll back the application; the older code works with 065, which changes no data.

**Known limits:**

- **Windows:** Windows does not draw flag emoji, so Chrome and Edge there show the two letters instead (`PK`, `AE`). The country name is still given to screen readers and on hover.
- **Crown dependencies:** the library places some +44 mobile ranges in Guernsey, Jersey or the Isle of Man (+44 7911 is Guernsey), so those numbers show that flag.
- **Fictional numbers** such as Ofcom's +44 7700 900… are not valid numbers for the library, so they show a globe.
