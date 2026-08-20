import express from "express";
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
  monthly_collections: number | null;
  daily_points: number | null;
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
const CELEBRATION_MIN_POINTS = 500;
const bucketWeightSql = `
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
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
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
        COUNT(pr.id) AS monthly_collections,
        COALESCE(SUM(
          CASE
            WHEN pr.date_of_message_sent >= b.today_start
             AND pr.date_of_message_sent < b.tomorrow_start
            THEN COALESCE(pr.points, 0)
            ELSE 0
          END
        ), 0) AS daily_points,
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
    const target = CELEBRATION_MIN_POINTS;
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
    monthly_collections: 0,
    daily_points: 0,
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
      monthlyCollections: Number(periodMetrics.monthly_collections ?? 0),
      dailyPoints: Number(periodMetrics.daily_points ?? 0),
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
    payload.metrics.monthlyCollections,
    payload.metrics.dailyPoints,
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
    payload.recentCollections.map((row) => `${row.id}:${row.messageSentAt ?? "no-message-date"}:${row.points}:${row.qualifies}:${row.photoUrl ? "photo" : "no-photo"}`).join(","),
    payload.leaderboard.map((entry) => `${entry.rank}:${entry.emailId ?? entry.agentName}:${entry.totalPoints}:${entry.photoUrl ? "photo" : "no-photo"}`).join(",")
  ].join(":");
}

function writeSseEvent(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

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
