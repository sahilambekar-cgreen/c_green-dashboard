import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const credentialsPath = process.env.GOOGLE_PHOTOS_CREDENTIALS ?? "credentials1.json";
const tokenPath = process.env.GOOGLE_PHOTOS_TOKEN ?? "token1.json";

function getOAuthClient(credentialsFile) {
  const client = credentialsFile.installed ?? credentialsFile.web;
  if (!client?.client_id || !client.client_secret) {
    throw new Error(`${credentialsPath} does not contain an OAuth client.`);
  }
  return client;
}

function getRedirectUri(client) {
  return process.env.GOOGLE_PHOTOS_REDIRECT_URI ?? client.redirect_uris?.[0] ?? "http://localhost";
}

function extractCode(inputText) {
  const trimmed = inputText.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    return url.searchParams.get("code") ?? "";
  } catch {
    return trimmed;
  }
}

let credentialsFile;
try {
  credentialsFile = JSON.parse(await readFile(credentialsPath, "utf8"));
} catch {
  console.error(`\nMissing ${credentialsPath}. Add your Google OAuth credentials file first, then run this command again.\n`);
  process.exitCode = 1;
  process.exit();
}

const client = getOAuthClient(credentialsFile);
const redirectUri = getRedirectUri(client);

const authUrl = new URL(client.auth_uri ?? "https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", client.client_id);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\nOpen this URL with your Google Workspace admin account:\n");
console.log(authUrl.toString());
console.log("\nAfter approving, paste the full callback URL or just the code below.");

const rl = readline.createInterface({ input, output });
const code = extractCode(await rl.question("Google auth code: "));
rl.close();

if (!code) {
  throw new Error("No authorization code provided.");
}

const tokenResponse = await fetch(client.token_uri ?? "https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded"
  },
  body: new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  })
});

if (!tokenResponse.ok) {
  const body = await tokenResponse.text();
  throw new Error(`Token exchange failed: HTTP ${tokenResponse.status} ${body}`);
}

const token = await tokenResponse.json();
const tokenWithExpiry = {
  ...token,
  scope: token.scope ?? SCOPE,
  expiry_date: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined
};

await writeFile(tokenPath, `${JSON.stringify(tokenWithExpiry, null, 2)}\n`, "utf8");
console.log(`\nSaved Google photo token to ${tokenPath}.`);
