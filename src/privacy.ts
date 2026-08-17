const VISIBLE_LAN_SUFFIX_LENGTH = 4;
const MASKED_LAN_PREFIX = "••••";

export function maskLoanAccountNumber(value: string | null | undefined) {
  if (value == null) return null;

  const loanAccountNumber = String(value).trim();
  if (!loanAccountNumber) return null;
  if (loanAccountNumber.length <= VISIBLE_LAN_SUFFIX_LENGTH) return loanAccountNumber;

  return `${MASKED_LAN_PREFIX} ${loanAccountNumber.slice(-VISIBLE_LAN_SUFFIX_LENGTH)}`;
}
