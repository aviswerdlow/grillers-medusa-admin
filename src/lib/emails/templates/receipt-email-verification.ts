import { renderEmail, renderTextFromLines, STOREFRONT_URL } from "../layout";
import { escapeHtml } from "../components";
export function buildReceiptEmailVerification(code: string) {
  const display = code.match(/.{1,4}/g)?.join("-") || code;
  const bodyHtml = `<p>Enter this code in the receipt email section of your Griller's Pride profile:</p><p style="font-size:22px;letter-spacing:2px;font-family:monospace">${escapeHtml(
    display
  )}</p><p>The code expires in 15 minutes. Verifying changes where future order receipts go. Your sign-in email and existing order receipts stay the same.</p>`;
  return {
    subject: "Confirm your Griller's Pride receipt email",
    html: renderEmail({
      heading: "Confirm your receipt email",
      preheader: "Your one-time receipt email code",
      bodyHtml,
      ctaUrl: `${STOREFRONT_URL}/us/account/profile`,
      ctaLabel: "Open your profile",
      footerNote:
        "If you did not request this, ignore this email. Nothing changes without the code and the requesting account's sign-in.",
    }).html,
    text: renderTextFromLines([
      "Confirm your Griller's Pride receipt email",
      display,
      "Enter this code in your account profile. It expires in 15 minutes.",
      "Your sign-in email and existing order receipts stay the same.",
      "If you did not request this, ignore this email.",
    ]),
  };
}
