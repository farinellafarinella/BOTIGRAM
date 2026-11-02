# Instagram Auto Bot — Starter MVP

Creates a template-based branded JPEG for Instagram feed posts (1080x1350) or Stories (1080x1920), uploads to Supabase Storage, and optionally publishes using Meta's official Content Publishing API. The scheduler runs every 15 minutes with GitHub Actions. **Default: dry run** (`PUBLISH_ENABLED=false`).

## Requirements
- Node 22+, GitHub repo, Supabase project.
- Instagram professional account with a properly authorized Meta app, valid content-publish permissions and token.
- If you use Facebook Login for Meta API access, Stories publication is supported for eligible **Business** accounts; check the exact login/permission model for your account.
- Graph API version in `.env` must be supported for your app at deployment time.

## Setup
1. In Supabase SQL Editor run `supabase/schema.sql`.
2. In Storage verify `instagram-public` exists and its files can be fetched by an unauthenticated URL. **Never store tokens here**. Assets are public until removed.
3. Create a private GitHub repository with these files. Optionally run `npm install` locally to generate and commit a `package-lock.json` for reproducible builds.
4. Configure GitHub Actions Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INSTAGRAM_IG_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`.
5. Configure Actions Variables: `PUBLISH_ENABLED=false`, `META_GRAPH_VERSION` to your tested Meta version.
6. Populate Supabase tables with one `social_accounts` row, one `events` row (optional) and `publication_jobs` rows. Example:

```sql
insert into public.social_accounts (handle, ig_user_id) values ('your_handle','YOUR_IG_ID');
insert into public.publication_jobs(account_id,media_kind,scheduled_at,headline,subhead,caption)
select id,'POST',now(),'PROSSIMO TORNEO','PRESTO TUTTE LE INFO','Seguiteci per aggiornamenti.'
from public.social_accounts where handle='your_handle';
```
7. Manually run `Instagram autopublisher` from GitHub Actions. In dry run a JPG is generated and status becomes `ready` (NOT published). Inspect the public asset URL and verify graphic, spellings and layout.
8. To publish a reviewed test image, update that job status to `queued`, ensure its `scheduled_at <= now()`, set `PUBLISH_ENABLED=true`, and trigger the action. The live code will create a Meta media container, poll status and publish it.

## Caveats and production checklist
- **Never use example placeholder event details for real publication.** Only schedule verified dates/prices and accurate copy.
- Supabase RLS policies deny client access: only service-role backend reads/writes these rows. Keep secrets in GitHub Secrets.
- The access token must be refreshed/renewed as required by Meta's exact login flow; this starter does not implement OAuth exchange or token rotation.
- Each deployment supports only one Instagram account/token. For multiple accounts use distinct deployments or implement encrypted per-account tokens.
- This is an MVP. Before unsupervised use, add a reliable transactional claim RPC, timeout recovery, remote publish reconciliation to avoid duplicate posts, retry scheduling with backoff, token-expiration alerts, human-reviewed brand templates, and robust text overflow handling.
- GitHub Actions schedules can be delayed; not suitable for exact-minute guarantees.
- The job planner automatically creates one post 7 days before, plus three Stories 3 days before, 1 day before, and 8 hours before the event. Scheduling uses elapsed hours before the stored UTC event instant; for precise Rome wall-clock publishing times across daylight saving transitions, adapt with a zoned-time library. Only confirmed `events` data is used.
- Story interactive stickers, music, and some Instagram-native features cannot be added through ordinary content publishing API.
- Consult official Meta API documentation for your specific token/login flow and current media limitations.
