# Update 068: each lead shows the advertisement it came from

Leads from Meta advertisements now carry the advertisement's name (Meta's
`ad_name`). It shows under the customer's name in every lead list and on the
lead's page.

## Before and after

| Where the lead comes from            | Before 068                                                                                                      | From 068                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A CSV or Excel file (Import)         | An `ad_name` column could only be skipped in Match file columns. The advertisement was lost.                    | `ad_name`, `Ad Name`, `Ad`, `Advertisement` and `Ad title` are matched automatically. Any other column can be matched to **Ad name** by hand. |
| A Google Sheet (automatic sync, 056) | Kept with each inquiry, shown only in the lead page's "Advertisement inquiry" panel and in the pipeline export. | Also kept on the lead and shown in the lists. Leads already imported take their first inquiry's advertisement when 068 is applied.            |
| A lead added by hand                 | None.                                                                                                           | None (the API accepts one, the form does not ask).                                                                                            |

Where it shows:

- under the customer's name in **All leads**, **Lead pipeline** (an agent's
  pipeline, for administrators), **Assigned leads** and an agent's **Lead
  pipeline**, as "Ad: …", cut short with the full name on hover;
- in **Lead details** on the lead's page, as "Advertisement";
- in the **pipeline export**'s Advertisement column, when the lead has no
  Google Sheet inquiry.

## Rules

- **A lead keeps the first advertisement it is given.** When the customer
  inquires again from another advertisement, the lead keeps its first one;
  the new inquiry shows in the lead page's panel, with its own advertisement,
  and the agent is told, as before.
- **A lead without one takes the next that names one.** For example a lead
  added by hand that later inquires through a Google Sheet. Nothing else on
  the lead changes, as before.
- **Blank stays blank.** A name over 500 characters is shortened from a file
  or a Sheet, and refused when typed in through the API.
- **No one edits it afterwards.** Edit lead does not offer it, and the API
  refuses it.
- **A lead's new agent sees it** (update 067): it is the customer's answer,
  like the budget, not the earlier agent's work.
- Leads from Meta's own connection (Incoming social leads) are unchanged:
  their advertisement still shows there.

## Release

| Item            | Value                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration       | `supabase/migrations/068_lead_ad_names.sql`: adds `leads.ad_name` (no default, no table rewrite), checked edits of `create_lead_031`, `sheet_sync_import` and the three lists, one backfill. |
| Read-only check | `supabase/check-lead-ad-names-068.sql`                                                                                                                                                       |
| Requires        | update 067 in production                                                                                                                                                                     |
| Code            | Upload column, list line, Lead details row. Before 068 the lists send no ad name, so nothing shows, and an uploaded ad name is not kept: apply 068 first.                                    |

1. Back up the database and test the restore.
2. Run the check. It should read `at 067, ready for 068`, with
   `transactions_open_over_1_min = 0` and `leads_with_ad_name = 0`. Note
   `sheet_leads_with_ad_name`.
3. Apply 068 and run the check again. It should read `at 068`, with
   `leads_with_ad_name` equal to `sheet_leads_with_ad_name` and every other
   count unchanged.
4. Deploy the code.

The backfill changes only `ad_name` (and with it `updated_at`, which no
screen shows) on the leads a Google Sheet brought in. Applying 068 again
changes nothing.

**Rollback:** the code before 068 ignores the column. To undo the database
change as well, apply update 067's versions of the five functions again and
drop the column; advertisement names stored meanwhile are lost from the leads
but stay on each Google Sheet inquiry.
