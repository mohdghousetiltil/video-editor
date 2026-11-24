# Video Studio database (PostgreSQL)

Files
- `schema.sql`     tables, functions, triggers and views (22 tables)
- `seed.sql`       the single local user, the 19 looks, the model catalog and routes, the radio stations (made by `node db/make_seed.js`)
- `make_seed.js`   rebuilds `seed.sql` from the app's own code

## Create it on your PC (Windows, PowerShell)

Option A: Docker (nothing to install besides Docker Desktop)
```powershell
docker run -d --name videostudio-db -e POSTGRES_PASSWORD=change-me -p 5432:5432 -v videostudio-data:/var/lib/postgresql/data postgres:16
docker exec videostudio-db psql -U postgres -c "CREATE DATABASE videostudio;"
Get-Content db\schema.sql | docker exec -i videostudio-db psql -U postgres -d videostudio -v ON_ERROR_STOP=1
Get-Content db\seed.sql   | docker exec -i videostudio-db psql -U postgres -d videostudio -v ON_ERROR_STOP=1
```

Option B: the PostgreSQL installer (postgresql.org/download/windows), then
```powershell
psql -U postgres -c "CREATE DATABASE videostudio;"
psql -U postgres -d videostudio -v ON_ERROR_STOP=1 -f db\schema.sql
psql -U postgres -d videostudio -v ON_ERROR_STOP=1 -f db\seed.sql
```

Connection string: `postgres://postgres:change-me@localhost:5432/videostudio`

## Handy queries
```sql
SELECT * FROM v_credits;                                       -- cap, used, left
SELECT * FROM video_limits('00000000-0000-0000-0000-000000000001');   -- today / week / reserved
SELECT video_block('00000000-0000-0000-0000-000000000001', 0.40);     -- NULL = this video may start
SELECT system_reboot('00000000-0000-0000-0000-000000000001');         -- the cap counts from now
SELECT * FROM v_spend_by_feature ORDER BY cost_usd DESC;
SELECT * FROM v_history LIMIT 20;
```

## Back up and restore
```powershell
docker exec videostudio-db pg_dump -U postgres -Fc videostudio > videostudio.dump
Get-Content videostudio.dump -Encoding Byte -ReadCount 0 | docker exec -i videostudio-db pg_restore -U postgres -d videostudio --clean
```

## Notes
- Money is US dollars; the app shows it as credits (1 credit = $1).
- Files (videos, pictures, sound) stay on disk or in object storage; `assets` holds the path and details.
- The app itself still reads and writes its JSON files in `data/`; this database is the target to move to.
