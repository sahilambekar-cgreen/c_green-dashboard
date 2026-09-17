import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { maskLoanAccountNumber } from "./src/privacy";
import { resolveAgentName } from "./src/agent-name";

// Vite reads .env for the frontend, but the separately started Express process
// does not. Load the same root file before creating the MySQL pool so local
// `npm run dev` uses the documented database settings without shell setup.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

type DashboardRow = {
  id: number;
  client_name: string | null;
  raw_bucket: string | null;
  loan_no: string | null;
  customer_name: string | null;
  amount_collected: number | null;
  points: number | null;
  bucket_weight: number | null;
  lender_name: string | null;
  agent_name: string | null;
  emp_id: string | null;
  email_id: string | null;
  date_of_message_sent: string | null;
  roster_name: string | null;
  caller_empcode: string | null;
  dossier_code: string | null;
  dpd_bucket_id: number | null;
  bucket_name: string | null;
  dossier_bucket: string | null;
};

type LeaderboardRow = {
  roster_name: string | null;
  sheet_name: string | null;
  emp_id: string | null;
  email_id: string | null;
  total_points: number | null;
  collection_count: number | null;
};

type LenderPointsRow = {
  lender_id: number | null;
  lender_name: string | null;
  total_points: number | null;
  collection_count: number | null;
};

type EmployeePhotoTarget = {
  emailId: string | null;
  photoUrl: string | null;
};

type PeriodMetricsRow = {
  monthly_points: number | null;
  monthly_amount_collected: number | null;
  monthly_collections: number | null;
  daily_points: number | null;
  daily_amount_collected: number | null;
  daily_collections: number | null;
};

// Only default to the local macOS socket. Anywhere else — Linux containers in
// particular — fall through to DB_HOST/DB_PORT, because a non-empty socket path
// makes mysql2 ignore host and port entirely.
const dbSocketPath =
  process.env.DB_SOCKET_PATH ??
  (process.platform === "darwin" ? "/private/tmp/mysql.sock" : undefined);

const pool = mysql.createPool({
  ...(dbSocketPath
    ? { socketPath: dbSocketPath }
    : {
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "3306")
      }),
  user: process.env.DB_USER ?? "root",
  password: process.env.DB_PASSWORD ?? "1234",
  database: process.env.DB_NAME ?? "c_green",
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true
});

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const distDir = path.join(__dirname, "dist");
const dashboardStreamPollMs = Number(process.env.DASHBOARD_STREAM_POLL_MS ?? "2000");
const zohoFlowWebhookSecret = process.env.ZOHO_FLOW_WEBHOOK_SECRET;
const zohoFlowMaxBodyBytes = process.env.ZOHO_FLOW_MAX_BODY_BYTES ?? "64kb";
const businessTimeZone = process.env.TZ ?? "Asia/Kolkata";
const CELEBRATION_MIN_RP = 500;
const RP_MULTIPLIER_SCALE = 0.1;
// A collection posted in Zoho Cliq can be retracted after the fact. The ETL
// keeps the row for audit and flags it, so every read of collections_messages
// must exclude it here — miss one query and a retracted collection keeps
// scoring on that panel. NULL means live: rows written before the column
// existed, and every row Zoho still considers current.
const liveCollectionsFilter = `(version_status IS NULL OR version_status <> 'DELETED')`;
const bucketWeightSql = `
  (
    CASE
      WHEN d.dpd_bucket_id = 7 THEN
        CASE
          WHEN TRIM(COALESCE(d.dpd_days, '')) REGEXP '^[0-9]+(\\\\.[0-9]+)?$'
          THEN
            CASE
              WHEN CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) >= 1
               AND CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) <= 30 THEN 1
              WHEN CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) > 30
               AND CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) <= 60 THEN 1.25
              WHEN CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) > 60
               AND CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) <= 90 THEN 1.6
              WHEN CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) > 90
               AND CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) <= 180 THEN 2.1
              WHEN CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) > 180
               AND CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) <= 360 THEN 2.75
              WHEN CAST(TRIM(d.dpd_days) AS DECIMAL(18,6)) > 360 THEN 3.5
              ELSE 0
            END
          ELSE 0
        END
      WHEN TRIM(COALESCE(b.weights, '')) REGEXP '^-?[0-9]+(\\\\.[0-9]+)?$'
      THEN CAST(TRIM(b.weights) AS DECIMAL(18,6))
      ELSE 0
    END
  ) * ${RP_MULTIPLIER_SCALE}
`;
const employeePhotoPublicPath = "/employee-photos";
const employeePhotoDir = path.join(publicDir, "employee-photos");
const employeePhotoExtensions = [".jpg", ".jpeg", ".png", ".webp", ".avif"];
const GOOGLE_PHOTOS_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const googlePhotosCredentialsPath = path.resolve(__dirname, process.env.GOOGLE_PHOTOS_CREDENTIALS ?? "credentials1.json");
const googlePhotosTokenPath = path.resolve(__dirname, process.env.GOOGLE_PHOTOS_TOKEN ?? "token1.json");
const googlePhotoCacheTtlMs = Number(process.env.GOOGLE_PHOTO_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000);
const googlePhotoMissingCacheTtlMs = Number(process.env.GOOGLE_PHOTO_MISSING_CACHE_TTL_MS ?? 15 * 60 * 1000);

type GoogleOAuthClient = {
  client_id: string;
  client_secret: string;
  token_uri?: string;
};

type GoogleOAuthCredentialsFile = {
  installed?: GoogleOAuthClient;
  web?: GoogleOAuthClient;
};

type GoogleOAuthToken = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
};

type GoogleUserPhotoResponse = {
  photoData?: string;
  mimeType?: string;
};

type GooglePhotoCacheEntry = {
  photoUrl: string | null;
  expiresAt: number;
};

type GooglePhotoHydrationStats = {
  requested: number;
  loaded: number;
  missing: number;
};

let googlePhotoCredentials: GoogleOAuthClient | null | undefined;
let googlePhotoToken: GoogleOAuthToken | null | undefined;
let googlePhotoAuthWarningShown = false;
const googlePhotoCache = new Map<string, GooglePhotoCacheEntry>();
const googlePhotoInFlight = new Map<string, Promise<string | null>>();
let lastGooglePhotoHydrationStats: GooglePhotoHydrationStats = {
  requested: 0,
  loaded: 0,
  missing: 0
};

const employeeMapSql = `
  SELECT
    caller_emailid,
    MAX(caller_empcode) AS caller_empcode,
    MAX(caller_name) AS caller_name,
    MAX(dossier_code) AS dossier_code
  FROM (
    SELECT
      LOWER(TRIM(caller_emailid)) COLLATE utf8mb4_unicode_ci AS caller_emailid,
      caller_empcode,
      caller_name,
      dossier_code
    FROM emp_details
    WHERE caller_emailid IS NOT NULL AND TRIM(caller_emailid) != ''
  ) normalized_emp_details
  GROUP BY caller_emailid
`;

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// This is intentionally global so malformed or oversized JSON is rejected
// before it reaches the Zoho Flow integration route. The dashboard endpoints
// remain GET-only and do not consume request bodies.
app.use(express.json({ limit: zohoFlowMaxBodyBytes }));
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "Malformed JSON request body." });
    return;
  }
  next(error);
});

function warnGooglePhotoAuth(message: string) {
  if (googlePhotoAuthWarningShown) return;
  googlePhotoAuthWarningShown = true;
  console.warn(`[employee-photos] ${message}`);
}

function normalizeEmployeeEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function getEmployeePhotoSlug(email: string) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function readJsonFile<T>(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadGooglePhotoCredentials() {
  if (googlePhotoCredentials !== undefined) return googlePhotoCredentials;

  try {
    const credentialsFile = await readJsonFile<GoogleOAuthCredentialsFile>(googlePhotosCredentialsPath);
    googlePhotoCredentials = credentialsFile.installed ?? credentialsFile.web ?? null;
    if (!googlePhotoCredentials?.client_id || !googlePhotoCredentials.client_secret) {
      warnGooglePhotoAuth("credentials1.json is present but does not contain an OAuth client.");
      googlePhotoCredentials = null;
    }
  } catch {
    warnGooglePhotoAuth("credentials1.json not found yet; employee photo API is disabled.");
    googlePhotoCredentials = null;
  }

  return googlePhotoCredentials;
}

async function loadGooglePhotoToken() {
  if (googlePhotoToken !== undefined) return googlePhotoToken;

  try {
    googlePhotoToken = await readJsonFile<GoogleOAuthToken>(googlePhotosTokenPath);
  } catch {
    warnGooglePhotoAuth("token1.json not found yet; run npm run google:photos:auth after adding credentials1.json.");
    googlePhotoToken = null;
  }

  return googlePhotoToken;
}

async function saveGooglePhotoToken(token: GoogleOAuthToken) {
  googlePhotoToken = token;
  await writeFile(googlePhotosTokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
}

async function getLocalEmployeePhotoUrl(email: string) {
  const slug = getEmployeePhotoSlug(email);

  for (const extension of employeePhotoExtensions) {
    const fileName = `${slug}${extension}`;
    if (await fileExists(path.join(employeePhotoDir, fileName))) {
      return `${employeePhotoPublicPath}/${fileName}`;
    }
  }

  return null;
}

function normalizeGooglePhotoBase64(photoData: string) {
  const standardBase64 = photoData.replace(/-/g, "+").replace(/_/g, "/");
  const padding = standardBase64.length % 4;
  return padding ? standardBase64.padEnd(standardBase64.length + 4 - padding, "=") : standardBase64;
}

async function getGooglePhotoAccessToken() {
  const credentials = await loadGooglePhotoCredentials();
  const token = await loadGooglePhotoToken();
  if (!credentials || !token?.refresh_token) return null;

  const now = Date.now();
  if (token.access_token && token.expiry_date && token.expiry_date > now + 60_000) {
    return token.access_token;
  }

  const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    warnGooglePhotoAuth(`unable to refresh Google photo token: HTTP ${response.status}`);
    return null;
  }

  const refreshed = (await response.json()) as GoogleOAuthToken & { expires_in?: number };
  const updatedToken: GoogleOAuthToken = {
    ...token,
    ...refreshed,
    refresh_token: token.refresh_token,
    expiry_date: refreshed.expires_in ? now + refreshed.expires_in * 1000 : token.expiry_date
  };
  await saveGooglePhotoToken(updatedToken);
  return updatedToken.access_token ?? null;
}

async function fetchEmployeePhotoUrl(email: string) {
  const accessToken = await getGooglePhotoAccessToken();
  if (!accessToken) return null;

  const response = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}/photos/thumbnail`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    console.warn(`[employee-photos] unable to fetch ${email}: HTTP ${response.status}`);
    return null;
  }

  const photo = (await response.json()) as GoogleUserPhotoResponse;
  if (!photo.photoData) return null;

  return `data:${photo.mimeType ?? "image/jpeg"};base64,${normalizeGooglePhotoBase64(photo.photoData)}`;
}

async function getEmployeePhotoUrl(email: string | null | undefined) {
  const normalizedEmail = normalizeEmployeeEmail(email);
  if (!normalizedEmail) return null;

  const localPhotoUrl = await getLocalEmployeePhotoUrl(normalizedEmail);
  if (localPhotoUrl) return localPhotoUrl;

  const cached = googlePhotoCache.get(normalizedEmail);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.photoUrl;
  }

  const existingRequest = googlePhotoInFlight.get(normalizedEmail);
  if (existingRequest) return existingRequest;

  const request = fetchEmployeePhotoUrl(normalizedEmail)
    .then((photoUrl) => {
      googlePhotoCache.set(normalizedEmail, {
        photoUrl,
        expiresAt: Date.now() + (photoUrl ? googlePhotoCacheTtlMs : googlePhotoMissingCacheTtlMs)
      });
      return photoUrl;
    })
    .catch((error) => {
      console.warn(
        `[employee-photos] unable to fetch ${normalizedEmail}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      googlePhotoCache.set(normalizedEmail, {
        photoUrl: null,
        expiresAt: Date.now() + googlePhotoMissingCacheTtlMs
      });
      return null;
    })
    .finally(() => {
      googlePhotoInFlight.delete(normalizedEmail);
    });

  googlePhotoInFlight.set(normalizedEmail, request);
  return request;
}

async function hydrateEmployeePhotos<T extends EmployeePhotoTarget>(items: T[]) {
  const photoByEmail = new Map<string, string | null>();
  const uniqueEmails = Array.from(
    new Set(items.map((item) => normalizeEmployeeEmail(item.emailId)).filter((email): email is string => Boolean(email)))
  );

  await Promise.all(
    uniqueEmails.map(async (email) => {
      photoByEmail.set(email, await getEmployeePhotoUrl(email));
    })
  );

  items.forEach((item) => {
    const email = normalizeEmployeeEmail(item.emailId);
    if (email) item.photoUrl = photoByEmail.get(email) ?? null;
  });
  lastGooglePhotoHydrationStats = {
    requested: uniqueEmails.length,
    loaded: Array.from(photoByEmail.values()).filter(Boolean).length,
    missing: Array.from(photoByEmail.values()).filter((photoUrl) => !photoUrl).length
  };
}

export async function buildDashboardPayload() {
  const [latestBatchRows] = await pool.query<mysql.RowDataPacket[]>(
    `
      SELECT
        DATE_FORMAT(MAX(date_of_message_sent), '%Y-%m-%d') AS latest_batch_date,
        MAX(date_of_message_sent) AS latest_seen_at,
        COUNT(*) AS total_rows
      FROM collections_messages
      WHERE ${liveCollectionsFilter}
    `
  );

  const latestBatchDate = latestBatchRows[0]?.latest_batch_date ?? null;
 

  const [periodMetricRows] = await pool.query<mysql.RowDataPacket[]>(
    `
      WITH bounds AS (
        SELECT
          business_date AS today_start,
          DATE_ADD(business_date, INTERVAL 1 DAY) AS tomorrow_start,
          DATE_FORMAT(business_date, '%Y-%m-01') AS month_start,
          DATE_ADD(DATE_FORMAT(business_date, '%Y-%m-01'), INTERVAL 1 MONTH) AS next_month_start
        FROM (
          SELECT COALESCE(DATE(?), CURDATE()) AS business_date
        ) anchor
      ),
      scoped_cm AS (
        SELECT cm.*
        FROM collections_messages cm
        JOIN bounds b
          ON cm.date_of_message_sent >= b.month_start
         AND cm.date_of_message_sent < b.next_month_start
        WHERE ${liveCollectionsFilter}
      ),
      dossier_matches AS (
        SELECT
          cm.id AS collection_id,
          d.lender_id,
          d.dpd_bucket_id,
          d.dpd_days,
          ROW_NUMBER() OVER (
            PARTITION BY cm.id
            ORDER BY
              CASE WHEN d.due_date IS NULL THEN 1 ELSE 0 END,
              d.due_date DESC,
              d.id DESC
          ) AS rn
        FROM scoped_cm cm
        LEFT JOIN dossier d
          ON d.loan_account_number = TRIM(cm.loan_no) COLLATE utf8mb4_0900_ai_ci
      ),
      point_rows AS (
        SELECT
          cm.id,
          cm.date_of_message_sent,
          COALESCE(cm.amount_collected, 0) AS amount_collected,
          COALESCE(cm.amount_collected, 0) * ${bucketWeightSql} AS points
        FROM scoped_cm cm
        LEFT JOIN dossier_matches d
          ON d.collection_id = cm.id AND d.rn = 1
        LEFT JOIN lenders l
          ON d.lender_id = l.id
        LEFT JOIN bucket b
          ON d.dpd_bucket_id = b.id
      )
      SELECT
        COALESCE(SUM(COALESCE(pr.points, 0)), 0) AS monthly_points,
        COALESCE(SUM(COALESCE(pr.amount_collected, 0)), 0) AS monthly_amount_collected,
        COUNT(pr.id) AS monthly_collections,
        COALESCE(SUM(
          CASE
            WHEN pr.date_of_message_sent >= b.today_start
             AND pr.date_of_message_sent < b.tomorrow_start
            THEN COALESCE(pr.points, 0)
            ELSE 0
          END
        ), 0) AS daily_points,
        COALESCE(SUM(
          CASE
            WHEN pr.date_of_message_sent >= b.today_start
             AND pr.date_of_message_sent < b.tomorrow_start
            THEN COALESCE(pr.amount_collected, 0)
            ELSE 0
          END
        ), 0) AS daily_amount_collected,
        COUNT(
          CASE
            WHEN pr.date_of_message_sent >= b.today_start
             AND pr.date_of_message_sent < b.tomorrow_start
            THEN pr.id
          END
        ) AS daily_collections
      FROM bounds b
      LEFT JOIN point_rows pr
        ON TRUE
    `,
    [latestBatchDate]
  );

  const [leaderboardRows] = await pool.query<mysql.RowDataPacket[]>(
    `
      WITH bounds AS (
        SELECT
          business_date AS today_start,
          DATE_ADD(business_date, INTERVAL 1 DAY) AS tomorrow_start
        FROM (
          SELECT COALESCE(DATE(?), CURDATE()) AS business_date
        ) anchor
      ),
      today_cm AS (
        SELECT *
        FROM collections_messages
        JOIN bounds b
          ON date_of_message_sent >= b.today_start
         AND date_of_message_sent < b.tomorrow_start
        WHERE ${liveCollectionsFilter}
      ),
      dossier_matches AS (
        SELECT
          cm.id AS collection_id,
          d.lender_id,
          d.dpd_bucket_id,
          d.dpd_days,
          ROW_NUMBER() OVER (
            PARTITION BY cm.id
            ORDER BY
              CASE WHEN d.due_date IS NULL THEN 1 ELSE 0 END,
              d.due_date DESC,
              d.id DESC
          ) AS rn
        FROM today_cm cm
        LEFT JOIN dossier d
          ON d.loan_account_number = TRIM(cm.loan_no) COLLATE utf8mb4_0900_ai_ci
      ),
      point_rows AS (
        SELECT
          cm.*,
          COALESCE(cm.amount_collected, 0) * ${bucketWeightSql} AS points
        FROM today_cm cm
        LEFT JOIN dossier_matches d
          ON d.collection_id = cm.id AND d.rn = 1
        LEFT JOIN lenders l
          ON d.lender_id = l.id
        LEFT JOIN bucket b
          ON d.dpd_bucket_id = b.id
      )
      SELECT
        NULLIF(MAX(ed.caller_name), '') AS roster_name,
        NULLIF(MAX(cm.agent_name), '') AS sheet_name,
        COALESCE(NULLIF(MAX(ed.caller_empcode), ''), NULLIF(MAX(cm.emp_id), '')) AS emp_id,
        NULLIF(MAX(cm.email_id), '') AS email_id,
        SUM(COALESCE(cm.points, 0)) AS total_points,
        COUNT(*) AS collection_count
      FROM point_rows cm
      LEFT JOIN (${employeeMapSql}) ed
        ON LOWER(TRIM(CONVERT(cm.email_id USING utf8mb4))) COLLATE utf8mb4_unicode_ci = ed.caller_emailid
      GROUP BY COALESCE(NULLIF(ed.caller_empcode, ''), NULLIF(cm.email_id, ''), NULLIF(cm.agent_name, ''), CONCAT('row-', cm.id))
      ORDER BY total_points DESC, collection_count DESC
      LIMIT 6
    `,
    [latestBatchDate]
  );

  const [lenderPointRows] = await pool.query<mysql.RowDataPacket[]>(
    `
      WITH bounds AS (
        SELECT
          DATE_FORMAT(business_date, '%Y-%m-01') AS month_start,
          DATE_ADD(DATE_FORMAT(business_date, '%Y-%m-01'), INTERVAL 1 MONTH) AS next_month_start
        FROM (
          SELECT COALESCE(DATE(?), CURDATE()) AS business_date
        ) anchor
      ),
      month_cm AS (
        SELECT *
        FROM collections_messages
        JOIN bounds b
          ON date_of_message_sent >= b.month_start
         AND date_of_message_sent < b.next_month_start
        WHERE ${liveCollectionsFilter}
      ),
      dossier_matches AS (
        SELECT
          cm.id AS collection_id,
          d.lender_id,
          d.dpd_bucket_id,
          d.dpd_days,
          ROW_NUMBER() OVER (
            PARTITION BY cm.id
            ORDER BY
              CASE WHEN d.due_date IS NULL THEN 1 ELSE 0 END,
              d.due_date DESC,
              d.id DESC
          ) AS rn
        FROM month_cm cm
        LEFT JOIN dossier d
          ON d.loan_account_number = TRIM(cm.loan_no) COLLATE utf8mb4_0900_ai_ci
      ),
      point_rows AS (
        SELECT
          cm.id,
          d.lender_id,
          COALESCE(
            NULLIF(l.name, ''),
            CASE
              WHEN d.lender_id IS NOT NULL THEN CONCAT('Lender #', d.lender_id)
              ELSE 'Unmapped lender'
            END
          ) AS lender_name,
          COALESCE(cm.amount_collected, 0) * ${bucketWeightSql} AS points
        FROM month_cm cm
        LEFT JOIN dossier_matches d
          ON d.collection_id = cm.id AND d.rn = 1
        LEFT JOIN lenders l
          ON d.lender_id = l.id
        LEFT JOIN bucket b
          ON d.dpd_bucket_id = b.id
      )
      SELECT
        lender_id,
        lender_name,
        COALESCE(SUM(COALESCE(points, 0)), 0) AS total_points,
        COUNT(id) AS collection_count
      FROM point_rows
      GROUP BY lender_id, lender_name
      ORDER BY total_points DESC, collection_count DESC, lender_name ASC
    `,
    [latestBatchDate]
  );

  const [monthlyTopRows] = await pool.query<mysql.RowDataPacket[]>(
    `
      WITH bounds AS (
        SELECT
          DATE_FORMAT(business_date, '%Y-%m-01') AS month_start,
          DATE_ADD(DATE_FORMAT(business_date, '%Y-%m-01'), INTERVAL 1 MONTH) AS next_month_start
        FROM (
          SELECT COALESCE(DATE(?), CURDATE()) AS business_date
        ) anchor
      ),
      month_cm AS (
        SELECT *
        FROM collections_messages
        JOIN bounds b
          ON date_of_message_sent >= b.month_start
         AND date_of_message_sent < b.next_month_start
        WHERE ${liveCollectionsFilter}
      ),
      dossier_matches AS (
        SELECT
          cm.id AS collection_id,
          d.lender_id,
          d.dpd_bucket_id,
          d.dpd_days,
          ROW_NUMBER() OVER (
            PARTITION BY cm.id
            ORDER BY
              CASE WHEN d.due_date IS NULL THEN 1 ELSE 0 END,
              d.due_date DESC,
              d.id DESC
          ) AS rn
        FROM month_cm cm
        LEFT JOIN dossier d
          ON d.loan_account_number = TRIM(cm.loan_no) COLLATE utf8mb4_0900_ai_ci
      ),
      point_rows AS (
        SELECT
          cm.*,
          COALESCE(cm.amount_collected, 0) * ${bucketWeightSql} AS points
        FROM month_cm cm
        LEFT JOIN dossier_matches d
          ON d.collection_id = cm.id AND d.rn = 1
        LEFT JOIN lenders l
          ON d.lender_id = l.id
        LEFT JOIN bucket b
          ON d.dpd_bucket_id = b.id
      )
      SELECT
        NULLIF(MAX(ed.caller_name), '') AS roster_name,
        NULLIF(MAX(cm.agent_name), '') AS sheet_name,
        COALESCE(NULLIF(MAX(ed.caller_empcode), ''), NULLIF(MAX(cm.emp_id), '')) AS emp_id,
        NULLIF(MAX(cm.email_id), '') AS email_id,
        SUM(COALESCE(cm.points, 0)) AS total_points,
        COUNT(*) AS collection_count
      FROM point_rows cm
      LEFT JOIN (${employeeMapSql}) ed
        ON LOWER(TRIM(CONVERT(cm.email_id USING utf8mb4))) COLLATE utf8mb4_unicode_ci = ed.caller_emailid
      GROUP BY COALESCE(NULLIF(ed.caller_empcode, ''), NULLIF(cm.email_id, ''), NULLIF(cm.agent_name, ''), CONCAT('row-', cm.id))
      ORDER BY total_points DESC, collection_count DESC
      LIMIT 1
    `,
    [latestBatchDate]
  );

  const [recentRows] = await pool.query<mysql.RowDataPacket[]>(
    `
      WITH recent_cm AS (
        SELECT
          id,
          client_name,
          bucket,
          loan_no,
          customer_name,
          amount_collected,
          agent_name,
          emp_id,
          email_id,
          date_of_message_sent
        FROM collections_messages
        WHERE ${liveCollectionsFilter}
        ORDER BY date_of_message_sent DESC, id DESC
        LIMIT 12
      ),
      dossier_matches AS (
        SELECT
          rc.id AS collection_id,
          d.dossier_code,
          d.lender_id,
          d.dpd_bucket_id,
          d.dpd_days,
          d.dpd_bucket,
          ROW_NUMBER() OVER (
            PARTITION BY rc.id
            ORDER BY
              CASE WHEN d.due_date IS NULL THEN 1 ELSE 0 END,
              d.due_date DESC,
              d.id DESC
          ) AS rn
        FROM recent_cm rc
        LEFT JOIN dossier d
          ON d.loan_account_number = TRIM(rc.loan_no) COLLATE utf8mb4_0900_ai_ci
      )
      SELECT
        cm.id,
        cm.client_name,
        cm.bucket AS raw_bucket,
        cm.loan_no,
        cm.customer_name,
        cm.amount_collected,
        cm.agent_name,
        cm.emp_id,
        cm.email_id,
        cm.date_of_message_sent,
        NULLIF(ed.caller_name, '') AS roster_name,
        ed.caller_empcode,
        d.dossier_code,
        l.name AS lender_name,
        d.dpd_bucket_id,
        d.dpd_bucket AS dossier_bucket,
        b.name AS bucket_name,
        ${bucketWeightSql} AS bucket_weight,
        COALESCE(cm.amount_collected, 0) * ${bucketWeightSql} AS points
      FROM recent_cm cm
      LEFT JOIN (${employeeMapSql}) ed
        ON LOWER(TRIM(CONVERT(cm.email_id USING utf8mb4))) COLLATE utf8mb4_unicode_ci = ed.caller_emailid
      LEFT JOIN dossier_matches d
        ON d.collection_id = cm.id AND d.rn = 1
      LEFT JOIN lenders l
        ON d.lender_id = l.id
      LEFT JOIN bucket b
        ON d.dpd_bucket_id = b.id
      ORDER BY cm.date_of_message_sent DESC, cm.id DESC
      LIMIT 12
    `
  );

  const recentCollections = (recentRows as DashboardRow[]).map((row) => {
    const amount = row.amount_collected ?? 0;
    const points = row.points ?? 0;
    const target = CELEBRATION_MIN_RP;
    return {
      id: row.id,
      clientName: row.client_name,
      bucketLabel: row.bucket_name ?? row.dossier_bucket ?? row.raw_bucket,
      lenderName: row.lender_name,
      loanNo: maskLoanAccountNumber(row.loan_no),
      customerName: row.customer_name,
      amountCollected: amount,
      points,
      bucketWeight: row.bucket_weight ?? 0,
      agentName: resolveAgentName({
        rosterName: row.roster_name,
        emailId: row.email_id,
        sheetName: row.agent_name
      }),
      empId: row.caller_empcode ?? row.emp_id,
      emailId: row.email_id,
      photoUrl: null,
      messageSentAt: row.date_of_message_sent,
      dossierCode: row.dossier_code,
      targetPoints: target,
      qualifies: points > target
    };
  });

  const qualifiedCelebrations = recentCollections.filter((row) => row.qualifies).length;
  const celebrationQueue = recentCollections
    .filter((row) => row.qualifies)
    .sort((a, b) => a.id - b.id);
  const celebrationCandidate = celebrationQueue[0] ?? null;
  const periodMetrics = (periodMetricRows[0] as PeriodMetricsRow | undefined) ?? {
    monthly_points: 0,
    monthly_amount_collected: 0,
    monthly_collections: 0,
    daily_points: 0,
    daily_amount_collected: 0,
    daily_collections: 0
  };
  const leaderboard = (leaderboardRows as LeaderboardRow[]).map((row, index) => ({
    rank: index + 1,
    agentName: resolveAgentName({
      rosterName: row.roster_name,
      emailId: row.email_id,
      sheetName: row.sheet_name
    }),
    empId: row.emp_id,
    emailId: row.email_id,
    photoUrl: null,
    totalPoints: row.total_points ?? 0,
    collectionCount: row.collection_count ?? 0
  }));
  const monthlyTopPerformer = (monthlyTopRows as LeaderboardRow[]).map((row, index) => ({
    rank: index + 1,
    agentName: resolveAgentName({
      rosterName: row.roster_name,
      emailId: row.email_id,
      sheetName: row.sheet_name
    }),
    empId: row.emp_id,
    emailId: row.email_id,
    photoUrl: null,
    totalPoints: row.total_points ?? 0,
    collectionCount: row.collection_count ?? 0
  }))[0] ?? null;
  const lenderMonthlyPointsTotal = (lenderPointRows as LenderPointsRow[]).reduce(
    (total, row) => total + Number(row.total_points ?? 0),
    0
  );
  const lenderMonthlyPoints = (lenderPointRows as LenderPointsRow[]).map((row, index) => {
    const totalPoints = Number(row.total_points ?? 0);
    return {
      rank: index + 1,
      lenderId: row.lender_id,
      lenderName: row.lender_name ?? "Unmapped lender",
      totalPoints,
      collectionCount: Number(row.collection_count ?? 0),
      share: lenderMonthlyPointsTotal > 0 ? totalPoints / lenderMonthlyPointsTotal : 0
    };
  });

  await hydrateEmployeePhotos([
    ...recentCollections,
    ...leaderboard,
    ...(monthlyTopPerformer ? [monthlyTopPerformer] : [])
  ]);

  return {
    latestBatchDate,
    latestSeenAt: latestBatchRows[0]?.latest_seen_at ?? null,
    metrics: {
      monthlyPoints: Number(periodMetrics.monthly_points ?? 0),
      monthlyAmountCollected: Number(periodMetrics.monthly_amount_collected ?? 0),
      monthlyCollections: Number(periodMetrics.monthly_collections ?? 0),
      dailyPoints: Number(periodMetrics.daily_points ?? 0),
      dailyAmountCollected: Number(periodMetrics.daily_amount_collected ?? 0),
      dailyCollections: Number(periodMetrics.daily_collections ?? 0),
      totalCollections: Number(latestBatchRows[0]?.total_rows ?? recentCollections.length),
      activeAgents: leaderboardRows.length,
      qualifiedCelebrations
    },
    todayTopPerformer: leaderboard[0] ?? null,
    monthlyTopPerformer,
    lenderMonthlyPoints,
    leaderboard,
    recentCollections,
    celebrationQueue,
    celebrationCandidate
  };
}

type DashboardPayload = Awaited<ReturnType<typeof buildDashboardPayload>>;

function getDashboardVersion(payload: DashboardPayload) {
  return [
    payload.latestSeenAt ?? "none",
    payload.metrics.monthlyPoints,
    payload.metrics.monthlyAmountCollected,
    payload.metrics.monthlyCollections,
    payload.metrics.dailyPoints,
    payload.metrics.dailyAmountCollected,
    payload.metrics.dailyCollections,
    payload.metrics.totalCollections,
    payload.todayTopPerformer?.agentName ?? "none",
    payload.todayTopPerformer?.totalPoints ?? 0,
    payload.todayTopPerformer?.photoUrl ? "today-photo" : "today-no-photo",
    payload.monthlyTopPerformer?.agentName ?? "none",
    payload.monthlyTopPerformer?.totalPoints ?? 0,
    payload.monthlyTopPerformer?.photoUrl ? "month-photo" : "month-no-photo",
    payload.lenderMonthlyPoints.map((row) => `${row.rank}:${row.lenderName}:${row.totalPoints}:${row.collectionCount}`).join(","),
    payload.recentCollections[0]?.id ?? "none",
    payload.recentCollections.map((row) => `${row.id}:${row.messageSentAt ?? "no-message-date"}:${row.amountCollected}:${row.points}:${row.qualifies}:${row.photoUrl ? "photo" : "no-photo"}`).join(","),
    payload.leaderboard.map((entry) => `${entry.rank}:${entry.emailId ?? entry.agentName}:${entry.totalPoints}:${entry.photoUrl ? "photo" : "no-photo"}`).join(",")
  ].join(":");
}

function writeSseEvent(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

type ZohoFlowCollectionInput = Record<string, unknown>;

type ZohoFlowCollectionRow = {
  client_name: string | null;
  bucket: string | null;
  loan_no: string;
  customer_name: string | null;
  amount_collected: number;
  utr_no: string | null;
  transaction_date: string | null;
  agent_name: string;
  collection_mode: string | null;
  waiver: string | null;
  emp_id: string | null;
  tl_name: string | null;
  email_id: string | null;
  sender_name: string | null;
  date_of_message_sent: string;
  message_sent: string | null;
  link_to_message_sent: string | null;
  status: string | null;
  version_status: string | null;
  msg_id: string;
  uid: string;
};

const zohoFlowFieldLimits = {
  client_name: 255,
  bucket: 50,
  loan_no: 50,
  customer_name: 255,
  utr_no: 100,
  agent_name: 255,
  collection_mode: 100,
  waiver: 100,
  emp_id: 50,
  tl_name: 255,
  email_id: 255,
  sender_name: 255,
  status: 50,
  version_status: 50,
  msg_id: 100
} as const;

function webhookIsAuthorized(authorization: string | undefined) {
  if (!zohoFlowWebhookSecret) return false;
  const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(zohoFlowWebhookSecret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function optionalText(value: unknown, field: string, maximumLength: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${field} must be text.`);
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maximumLength) throw new Error(`${field} is too long.`);
  return normalized;
}

function requiredText(value: unknown, field: string, maximumLength: number) {
  const normalized = optionalText(value, field, maximumLength);
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function parseCollectionAmount(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("collection_amt must be a number.");
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("collection_amt must be a non-negative decimal with at most two decimal places.");
  }
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999_999.99) {
    throw new Error("collection_amt must be greater than zero and within the supported range.");
  }
  return amount;
}

function parseDate(value: unknown, field: string) {
  const text = requiredText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${field} must use YYYY-MM-DD.`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${field} is not a valid date.`);
  }
  return text;
}

function formatInBusinessTimeZone(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function parseMessageTimestamp(value: unknown) {
  const text = requiredText(value, "date_of_message_sent", 64);
  // An offset-bearing ISO timestamp is unambiguous. A local MySQL-style value
  // is also accepted and treated as the configured business-local wall clock.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    const [datePart] = text.split(" ");
    parseDate(datePart, "date_of_message_sent");
    return text;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !/(Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new Error("date_of_message_sent must be an ISO-8601 timestamp with a timezone offset.");
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("date_of_message_sent is not a valid timestamp.");
  return formatInBusinessTimeZone(date);
}

async function resolveWebhookAgentEmail(empId: string | null) {
  if (!empId) return null;
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT NULLIF(MAX(TRIM(caller_emailid)), '') AS email_id
     FROM emp_details
     WHERE LOWER(TRIM(caller_empcode)) = LOWER(TRIM(?))`,
    [empId]
  );
  return (rows[0]?.email_id as string | null | undefined) ?? null;
}

async function normalizeZohoFlowCollection(input: ZohoFlowCollectionInput): Promise<ZohoFlowCollectionRow> {
  const msgId = requiredText(input.msg_id, "msg_id", zohoFlowFieldLimits.msg_id);
  const requestedVersionStatus = optionalText(input.version_status, "version_status", zohoFlowFieldLimits.version_status)?.toUpperCase();
  // Match the existing ETL contract: only DELETED changes dashboard visibility;
  // source values such as ACTIVE are informational and remain NULL here.
  const versionStatus = requestedVersionStatus === "DELETED" ? "DELETED" : null;
  if (versionStatus === "DELETED") {
    return {
      msg_id: msgId,
      uid: createHash("sha256").update(msgId).digest("hex"),
      version_status: "DELETED"
    } as ZohoFlowCollectionRow;
  }

  const empId = optionalText(input.emp_id, "emp_id", zohoFlowFieldLimits.emp_id);
  return {
    client_name: optionalText(input.client_name, "client_name", zohoFlowFieldLimits.client_name),
    bucket: optionalText(input.bucket, "bucket", zohoFlowFieldLimits.bucket),
    loan_no: requiredText(input.loan_id, "loan_id", zohoFlowFieldLimits.loan_no),
    customer_name: optionalText(input.customer_name, "customer_name", zohoFlowFieldLimits.customer_name),
    amount_collected: parseCollectionAmount(input.collection_amt),
    utr_no: optionalText(input.utr_number, "utr_number", zohoFlowFieldLimits.utr_no),
    transaction_date: input.date_of_collection == null || input.date_of_collection === "" ? null : parseDate(input.date_of_collection, "date_of_collection"),
    agent_name: requiredText(input.name_of_agent, "name_of_agent", zohoFlowFieldLimits.agent_name),
    collection_mode: optionalText(input.group, "group", zohoFlowFieldLimits.collection_mode),
    waiver: optionalText(input.waiver, "waiver", zohoFlowFieldLimits.waiver),
    emp_id: empId,
    tl_name: optionalText(input.tl_name, "tl_name", zohoFlowFieldLimits.tl_name),
    // The Sheet's email_id is the Cliq bot. Preserve ETL behaviour by deriving
    // the collector email from the roster instead of trusting that value.
    email_id: await resolveWebhookAgentEmail(empId),
    sender_name: optionalText(input.sender_name_ai, "sender_name_ai", zohoFlowFieldLimits.sender_name),
    date_of_message_sent: parseMessageTimestamp(input.date_of_message_sent),
    message_sent: optionalText(input.message_sent, "message_sent", 65_535),
    link_to_message_sent: optionalText(input.link_to_message, "link_to_message", 65_535),
    status: optionalText(input.ai_status, "ai_status", zohoFlowFieldLimits.status),
    version_status: versionStatus,
    msg_id: msgId,
    uid: createHash("sha256").update(msgId).digest("hex")
  };
}

const zohoFlowUpsertSql = `
  INSERT INTO collections_messages (
    client_name, bucket, loan_no, customer_name, amount_collected, utr_no,
    transaction_date, agent_name, collection_mode, waiver, emp_id, tl_name,
    email_id, sender_name, date_of_message_sent, message_sent,
    link_to_message_sent, status, uid, version_status, msg_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    client_name = VALUES(client_name), bucket = VALUES(bucket), loan_no = VALUES(loan_no),
    customer_name = VALUES(customer_name), amount_collected = VALUES(amount_collected),
    utr_no = VALUES(utr_no), transaction_date = VALUES(transaction_date),
    agent_name = VALUES(agent_name), collection_mode = VALUES(collection_mode),
    waiver = VALUES(waiver), emp_id = VALUES(emp_id), tl_name = VALUES(tl_name),
    email_id = VALUES(email_id), sender_name = VALUES(sender_name),
    date_of_message_sent = VALUES(date_of_message_sent), message_sent = VALUES(message_sent),
    link_to_message_sent = VALUES(link_to_message_sent), status = VALUES(status),
    version_status = VALUES(version_status), msg_id = VALUES(msg_id)
`;

app.post("/api/integrations/zoho/collections", async (req, res) => {
  if (!zohoFlowWebhookSecret) {
    console.error("[zoho-flow] ZOHO_FLOW_WEBHOOK_SECRET is not configured");
    res.status(503).json({ error: "Integration is not configured" });
    return;
  }
  if (!webhookIsAuthorized(req.header("authorization"))) {
    console.warn("[zoho-flow] rejected unauthenticated collection request");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!req.body || Array.isArray(req.body) || typeof req.body !== "object") {
    res.status(400).json({ error: "Expected one JSON collection object." });
    return;
  }

  try {
    const row = await normalizeZohoFlowCollection(req.body as ZohoFlowCollectionInput);
    if (row.version_status === "DELETED") {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        "UPDATE collections_messages SET version_status = 'DELETED' WHERE uid = ?",
        [row.uid]
      );
      if (result.affectedRows === 0) {
        res.status(404).json({ error: "No existing collection matches msg_id." });
        return;
      }
      res.json({ status: "deleted", msgId: row.msg_id });
      return;
    }

    const [result] = await pool.execute<mysql.ResultSetHeader>(zohoFlowUpsertSql, [
      row.client_name, row.bucket, row.loan_no, row.customer_name, row.amount_collected,
      row.utr_no, row.transaction_date, row.agent_name, row.collection_mode, row.waiver,
      row.emp_id, row.tl_name, row.email_id, row.sender_name, row.date_of_message_sent,
      row.message_sent, row.link_to_message_sent, row.status, row.uid, row.version_status, row.msg_id
    ]);
    const created = result.affectedRows === 1 && result.insertId > 0;
    res.status(created ? 201 : 200).json({
      status: created ? "created" : "updated",
      msgId: row.msg_id
    });
  } catch (error) {
    if (error instanceof Error && /(?:required|must|too long|not a valid|supported range)/.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("[zoho-flow] collection upsert failed", error instanceof Error ? error.message : "Unknown error");
    res.status(503).json({ error: "Unable to store collection." });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/photo-health", async (_req, res) => {
  const credentialsFilePresent = await fileExists(googlePhotosCredentialsPath);
  const tokenFilePresent = await fileExists(googlePhotosTokenPath);
  const token = tokenFilePresent ? await loadGooglePhotoToken() : null;
  res.json({
    ok: credentialsFilePresent && tokenFilePresent && Boolean(token?.refresh_token),
    credentialsFilePresent,
    tokenFilePresent,
    hasRefreshToken: Boolean(token?.refresh_token),
    cacheEntries: googlePhotoCache.size,
    lastHydration: lastGooglePhotoHydrationStats
  });
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    res.json(await buildDashboardPayload());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to load dashboard data"
    });
  }
});

app.get("/api/dashboard/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  let inFlight = false;
  let lastVersion: string | null = null;

  const sendDashboard = async (force = false) => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const payload = await buildDashboardPayload();
      if (closed) return;
      const version = getDashboardVersion(payload);
      if (force || version !== lastVersion) {
        lastVersion = version;
        writeSseEvent(res, "dashboard", payload);
      }
    } catch (error) {
      if (closed) return;
      writeSseEvent(res, "dashboard-error", {
        error: error instanceof Error ? error.message : "Unable to load dashboard data"
      });
    } finally {
      inFlight = false;
    }
  };

  const dashboardTimer = setInterval(() => {
    void sendDashboard();
  }, dashboardStreamPollMs);
  const heartbeatTimer = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 30_000);

  req.on("close", () => {
    closed = true;
    clearInterval(dashboardTimer);
    clearInterval(heartbeatTimer);
    res.end();
  });

  await sendDashboard(true);
});

app.get("/api/dashboard.js", async (_req, res) => {
  try {
    const payload = await buildDashboardPayload();
    res.type("application/javascript");
    res.send(`window.__DASHBOARD_PAYLOAD__ = ${JSON.stringify(payload)};`);
  } catch (error) {
    res.status(500).type("application/javascript");
    res.send(`window.__DASHBOARD_PAYLOAD__ = { error: ${JSON.stringify(error instanceof Error ? error.message : "Unable to load dashboard data")} };`);
  }
});

if (process.env.NODE_ENV === "production") {
  app.use(employeePhotoPublicPath, express.static(employeePhotoDir));
  app.use(express.static(distDir, { index: false }));
  app.use(async (_req, res) => {
    try {
      const payload = await buildDashboardPayload();
      const template = await readFile(path.join(distDir, "index.html"), "utf8");
      const html = template.replace(
        "</head>",
        `<script>window.__DASHBOARD_PAYLOAD__ = ${JSON.stringify(payload)};</script></head>`
      );
      res.type("html").send(html);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "Unable to render dashboard");
    }
  });
}

const port = Number(process.env.PORT ?? 3001);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = app.listen(port, () => {
    console.log(`API listening on http://127.0.0.1:${port}`);
  });
  server.ref();
  const keepAliveTimer = setInterval(() => {
    // Keep the API process alive under tsx in local desktop runs.
  }, 60_000);

  const shutdown = () => {
    clearInterval(keepAliveTimer);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
