import mysql from "mysql2/promise";

const limit = Number(process.env.EMPLOYEE_PHOTO_NAME_LIMIT ?? 40);

function photoSlug(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function maskEmail(email) {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  return `${name.slice(0, 2)}${"*".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

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
      SELECT
        LOWER(TRIM(email_id)) AS email,
        COALESCE(NULLIF(MAX(agent_name), ''), MAX(LOWER(TRIM(email_id)))) AS name,
        MAX(created_at) AS latest_seen_at
      FROM collections_messages
      WHERE email_id IS NOT NULL AND TRIM(email_id) != ''
      GROUP BY LOWER(TRIM(email_id))
      ORDER BY latest_seen_at DESC
      LIMIT ?
    `,
    [limit]
  );

  console.log("Save high-resolution employee photos in public/employee-photos/ using one of these filenames:");
  rows.forEach((row) => {
    const slug = photoSlug(row.email);
    console.log(`- ${row.name} (${maskEmail(row.email)}): ${slug}.jpg`);
  });
} finally {
  await pool.end();
}
