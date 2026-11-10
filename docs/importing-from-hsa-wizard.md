# Importing from HSA Wizard

HSA Wizard was a Google Sheet plus an Apps Script that logged receipts from Gmail and Drive. This moves its log and files into HSA Locker.

## 1. Export the log

In the HSA Wizard spreadsheet, open the **📄 HSA Document Log** tab, then **File → Download → Comma-separated values (.csv)**. That downloads only the current tab.

## 2. Download the Drive folder

Open the folder HSA Wizard saved files into (its id is the “Drive Folder ID” on the ⚙️ Config tab). Select everything, including the year subfolders, and choose **Download**. Unzip it somewhere. File names may start with `[LOGGED] ` or `[DUPE SET n] `; that’s fine, the import strips those prefixes.

Files are matched to rows by their content hash (the sheet’s **Content Hash** column) and then by **Drive File Name**, so renamed files still match.

## 3. Dry run

From a clone of HSA Locker:

```sh
npm install
npm run import:hsa-wizard -- \
  --csv "HSA Document Log.csv" \
  --files ~/Downloads/HSA-Wizard \
  --family "Lastname" \
  --dry-run
```

`--family` is the sheet’s **Family Names** (comma-separated). The dry run prints counts by year (receipts, their total, EOB documents and EOB lines), the identical rows it will collapse, rows whose file wasn’t found, and amounts that don’t parse. Nothing is imported.

It also writes **`hsa-wizard-mapping.local.json`**: every patient and provider name as printed, and what it will become. Name variants are collapsed (`Sam` and `Example, Sam` → `Sam Example`) and truncated EOB provider names joined to the full one (`Riverside Physical Ther` → `Riverside Physical Therapy`). Open it and fix anything wrong. Each printed name becomes an alias of the person or provider, so future documents match too.

The mapping file is git-ignored. It contains your family’s names; don’t commit it.

## 4. Import

Point `--url` at your HSA Locker: `http://localhost:5173` while running `npm run dev`, or your deployed `https://…workers.dev` address.

```sh
npm run import:hsa-wizard -- \
  --csv "HSA Document Log.csv" \
  --files ~/Downloads/HSA-Wizard \
  --family "Lastname" \
  --url https://hsa-locker.you.workers.dev
```

It asks for your household password (or set `HSA_LOCKER_PASSWORD`). Then it creates people, providers and missing categories, uploads each file once, and adds its rows.

- **One document per Drive file.** An EOB that produced dozens of sheet rows becomes one document with dozens of lines.
- **Identical rows collapse.** Rows in the same file with the same date, provider, description and amount become one entry; the dry run lists them.
- **Flag for Review** carries over as “Flagged in HSA Wizard” in Review. **Additional Notes**, **Last Processed Date** and the **Content Hash** (as `legacy_md5`) are kept.
- Rows whose file wasn’t found are still imported, under a placeholder document marked “File not found during import”.
- Imported documents aren’t re-read by the AI. Use **Reprocess** on one if you want that.

Running it again is safe: files already stored are recognized by their SHA-256, and documents that already have entries are left alone.

## What changes from HSA Wizard

| HSA Wizard               | HSA Locker                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Apply Pending Label      | Gone: forwarded mail arrives directly.                                                                                             |
| Process Email → Drive    | Gone: Email Routing pushes mail to the Worker.                                                                                     |
| Run Drive → Sheet Sync   | Gone: the sweeper reads pending documents. Settings → Receipt forwarding address has **Process pending now** and **Retry failed**. |
| Deduplicate Sheet        | Prevented: files are unique by SHA-256, reading is idempotent, likely duplicates go to Review.                                     |
| Backfill Drive → Sheet   | Bulk upload, and this import.                                                                                                      |
| Remove [LOGGED] Prefixes | Gone: state lives in the database.                                                                                                 |
| Daily digest email       | The Review badge and Home banner, plus an optional daily email when something needs review (Settings → Daily reminder email).      |
| Summary tab              | Home. EOBs are counted as documents, not rows, and only receipts carry money.                                                      |
