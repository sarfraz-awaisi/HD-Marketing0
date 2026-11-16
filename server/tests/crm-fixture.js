import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
// An in-memory CRM database with every migration, plus a minimal Supabase
// client: rpc() calls the SQL function by named arguments, auth maps a bearer
// token to the user with that id, and from() reads profiles for sign-in.
export async function startCrmDatabase() {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pg.query(sql, args)).rows;
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(f, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  const db = {
    auth: {
      getUser: async (token) => ({
        data: {
          user: await one(
            "select id,email,email_confirmed_at from auth.users where id::text=$1",
            [token],
          ),
        },
      }),
    },
    rpc: async (name, args) => {
      try {
        const keys = Object.keys(args);
        const row = await one(
          `select to_jsonb(public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")})) value`,
          Object.values(args),
        );
        return { data: row.value };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    },
    from(table) {
      let fields = "*";
      const filters = [];
      const where = () =>
        filters
          .map(([k, , many], i) =>
            many ? `${k}=any($${i + 1})` : `${k}=$${i + 1}`,
          )
          .join(" and ");
      const q = {
        select: (f) => ((fields = f), q),
        eq: (k, v) => (filters.push([k, v]), q),
        in: (k, v) => (filters.push([k, v, true]), q),
        single: async () => ({
          data: await one(
            `select ${fields} from public.${table} where ${where()}`,
            filters.map(([, v]) => v),
          ),
        }),
        // As the Supabase client: the row, or null when there is none.
        maybeSingle: async () => ({ data: (await q.single()).data ?? null }),
        // As the Supabase client: awaiting the query gives every matching
        // row, or the database's error.
        then: (resolve, reject) =>
          all(
            `select ${fields} from public.${table}${filters.length ? " where " + where() : ""}`,
            filters.map(([, v]) => v),
          )
            .then(
              (data) => ({ data, error: null }),
              (e) => ({
                data: null,
                error: { code: e.code, message: e.message },
              }),
            )
            .then(resolve, reject),
        // As the Supabase client: one row added, or the database's error.
        insert: async (row) => {
          const keys = Object.keys(row);
          try {
            await pg.query(
              `insert into public.${table}(${keys.join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
              keys.map((k) =>
                row[k] && typeof row[k] === "object"
                  ? JSON.stringify(row[k])
                  : row[k],
              ),
            );
            return { error: null };
          } catch (e) {
            return { error: { code: e.code, message: e.message } };
          }
        },
      };
      return q;
    },
  };
  return { pg, db, one, all };
}
// Owner (admin) plus two agents, recreated for each test.
export async function resetPeople(pg, [admin, agent, other]) {
  await pg.exec(
    "truncate auth.users,public.notifications,public.audit_log cascade;insert into public.crm_settings(id) values(true) on conflict(id) do nothing;update public.crm_settings set work_days='{1,2,3,4,5,6}',work_start='10:00',work_end='18:00',first_call_grace_minutes=120,idle_days=7;",
  );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'agent@gmail.com',now()),($3,'other@gmail.com',now())",
    [admin, agent, other],
  );
  await pg.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case when id=$1 then 'admin' else 'agent' end",
    [admin, agent],
  );
}
