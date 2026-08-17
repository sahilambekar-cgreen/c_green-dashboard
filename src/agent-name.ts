// Shared agent display-name resolution, used by the API when building dashboard
// payloads. Kept beside privacy.ts so display rules live in one place.
//
// Corporate emails follow `fname.lname@domain`, which makes the local part a
// more reliable name source than collections_messages.agent_name — that column
// is typed by hand into the source sheet and contains misspellings, casing
// drift, and in at least one case two different people's names against a single
// address. The roster (emp_details.caller_name) still wins when it has a row.

const NAME_PART_SEPARATORS = /[._-]+/;

function toTitleCase(part: string) {
  // Drop a trailing disambiguating digit run: "rathod1" → "Rathod".
  const letters = part.replace(/\d+$/, "");
  if (!letters) return "";
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

/**
 * "sneha.rathod1@cgreen.in" → "Sneha Rathod"
 * "altaf@cgreen.in"         → "Altaf"        (no separator, single name)
 * "12345@cgreen.in"         → null           (nothing name-like to recover)
 */
export function deriveAgentNameFromEmail(email: string | null | undefined) {
  if (email == null) return null;

  const localPart = String(email).trim().toLowerCase().split("@")[0] ?? "";
  if (!localPart) return null;

  const parts = localPart.split(NAME_PART_SEPARATORS).map(toTitleCase).filter(Boolean);
  if (!parts.length) return null;

  return parts.join(" ");
}

/**
 * Resolution order: employee roster → email-derived → source sheet → fallback.
 *
 * The email beats the sheet deliberately. For the ~54 agents with no roster row
 * it produces one stable spelling per address instead of whatever variant the
 * sheet happened to carry that day.
 */
export function resolveAgentName({
  rosterName,
  emailId,
  sheetName
}: {
  rosterName?: string | null;
  emailId?: string | null;
  sheetName?: string | null;
}) {
  const roster = rosterName?.trim();
  if (roster) return roster;

  const derived = deriveAgentNameFromEmail(emailId);
  if (derived) return derived;

  const sheet = sheetName?.trim();
  if (sheet) return sheet;

  return "Unassigned";
}
