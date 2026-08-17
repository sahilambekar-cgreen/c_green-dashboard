import { buildDashboardPayload } from "../server.ts";

function maskEmail(email) {
  if (!email) return "no-email";
  const [name, domain] = email.split("@");
  if (!domain) return email;
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

function collectPhotoRows(payload) {
  const rows = [
    ...payload.recentCollections.map((row) => ({ source: "recent", ...row })),
    ...payload.leaderboard.map((row) => ({ source: "leaderboard", ...row })),
    ...(payload.monthlyTopPerformer ? [{ source: "monthlyTop", ...payload.monthlyTopPerformer }] : [])
  ];

  const byEmail = new Map();
  rows.forEach((row) => {
    const key = row.emailId ?? `${row.source}:${row.agentName}`;
    const existing = byEmail.get(key);
    byEmail.set(key, {
      emailId: row.emailId,
      agentName: row.agentName,
      sources: existing ? [...existing.sources, row.source] : [row.source],
      hasPhoto: Boolean(existing?.hasPhoto || row.photoUrl)
    });
  });

  return Array.from(byEmail.values());
}

const payload = await buildDashboardPayload();
const rows = collectPhotoRows(payload);
const withPhotos = rows.filter((row) => row.hasPhoto);
const withoutPhotos = rows.filter((row) => !row.hasPhoto);

console.log(`Dashboard payload employees checked: ${rows.length}`);
console.log(`Employees with photoUrl: ${withPhotos.length}`);
console.log(`Employees without photoUrl: ${withoutPhotos.length}`);
console.log(
  rows
    .slice(0, 12)
    .map((row) => {
      const status = row.hasPhoto ? "photoUrl present" : "fallback initial";
      return `- ${maskEmail(row.emailId)} (${row.sources.join(", ")}): ${status}`;
    })
    .join("\n")
);
process.exit(0);
