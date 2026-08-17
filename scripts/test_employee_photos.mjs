import { readFile, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const credentialsPath = process.env.GOOGLE_PHOTOS_CREDENTIALS ?? "credentials1.json";
const tokenPath = process.env.GOOGLE_PHOTOS_TOKEN ?? "token1.json";
const limit = Number(process.env.GOOGLE_PHOTOS_TEST_LIMIT ?? 8);

function maskEmail(email) {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

function normalizePhotoBase64(photoData) {
  const standardBase64 = photoData.replace(/-/g, "+").replace(/_/g, "/");
  const padding = standardBase64.length % 4;
  return padding ? standardBase64.padEnd(standardBase64.length + 4 - padding, "=") : standardBase64;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function getAccessToken() {
  const credentialsFile = await readJson(credentialsPath);
  const client = credentialsFile.installed ?? credentialsFile.web;
  if (!client?.client_id || !client.client_secret) {
    throw new Error(`${credentialsPath} does not contain an OAuth client.`);
  }

  const token = await readJson(tokenPath);
  if (!token.refresh_token) {
    throw new Error(`${tokenPath} does not contain a refresh_token. Run npm run google:photos:auth again.`);
  }

  if (token.access_token && token.expiry_date && token.expiry_date > Date.now() + 60_000) {
    return token.access_token;
  }

  const response = await fetch(client.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: HTTP ${response.status} ${await response.text()}`);
  }

  const refreshed = await response.json();
  const updatedToken = {
    ...token,
    ...refreshed,
    refresh_token: token.refresh_token,
    scope: refreshed.scope ?? token.scope ?? SCOPE,
    expiry_date: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : token.expiry_date
  };
  await writeFile(tokenPath, `${JSON.stringify(updatedToken, null, 2)}\n`, "utf8");
  return updatedToken.access_token;
}

async function loadRecentEmails() {
  const pool = mysql.createPool({
    socketPath: process.env.DB_SOCKET_PATH ?? "/private/tmp/mysql.sock",
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "1234",
    database: process.env.DB_NAME ?? "c_green",
    waitForConnections: true,
    connectionLimit: 2
  });

  try {
    const [rows] = await pool.query(
      `
        SELECT LOWER(TRIM(email_id)) AS email
        FROM collections_messages
        WHERE email_id IS NOT NULL AND TRIM(email_id) != ''
        GROUP BY LOWER(TRIM(email_id))
        ORDER BY MAX(created_at) DESC
        LIMIT ?
      `,
      [limit]
    );
    return rows.map((row) => row.email).filter(Boolean);
  } finally {
    await pool.end();
  }
}

async function fetchPhoto(accessToken, email) {
  const response = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}/photos/thumbnail`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404) {
    return { email, status: "missing", httpStatus: 404 };
  }

  if (!response.ok) {
    return { email, status: "error", httpStatus: response.status };
  }

  const photo = await response.json();
  const base64 = photo.photoData ? normalizePhotoBase64(photo.photoData) : "";
  return {
    email,
    status: base64 ? "loaded" : "empty",
    httpStatus: response.status,
    mimeType: photo.mimeType ?? "unknown",
    byteEstimate: Math.floor((base64.length * 3) / 4)
  };
}

const accessToken = await getAccessToken();
const emails = await loadRecentEmails();

if (emails.length === 0) {
  console.log("No recent employee emails found in collections_messages.");
  process.exit(0);
}

const results = await Promise.all(emails.map((email) => fetchPhoto(accessToken, email)));
const loaded = results.filter((result) => result.status === "loaded");
const missing = results.filter((result) => result.status === "missing");
const errors = results.filter((result) => result.status === "error" || result.status === "empty");

console.log(`Checked ${results.length} employee email(s).`);
console.log(`Loaded photos: ${loaded.length}`);
console.log(`Missing photos: ${missing.length}`);
console.log(`Errors/empty responses: ${errors.length}`);
console.log(
  results
    .map((result) => {
      const detail = result.status === "loaded" ? `${result.mimeType}, ~${result.byteEstimate} bytes` : `HTTP ${result.httpStatus}`;
      return `- ${maskEmail(result.email)}: ${result.status} (${detail})`;
    })
    .join("\n")
);
