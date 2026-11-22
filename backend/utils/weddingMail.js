import { sendMail } from "./mailer.js";

/**
 * The wedding RSVP confirmation email.
 *
 * WHY IT LIVES ON THE SERVER
 * --------------------------
 * The subject, the wording and the recipient are built HERE, never sent up by
 * the browser. A guest can therefore influence exactly one thing - the name in
 * the greeting - and even that is HTML-escaped below, so a "name" can never
 * inject markup or a header into the message.
 *
 * The design mirrors the invitation itself: deep burgundy, an antique-gold
 * double frame, champagne accents, an ornamental divider and a serif display
 * face. It is built entirely from tables and inline styles (no <style> block,
 * no webfonts, no images) so Gmail, Outlook and mobile clients all render it.
 *
 * NOTHING FACTUAL IS INVENTED: no date, time, venue, address or schedule
 * appears anywhere in this message, because none of those details exist yet.
 */

/** Server-controlled, so only the couple's own wording can ever be the subject. */
export const WEDDING_CONFIRMATION_SUBJECT =
  "Thank You for Accepting Our Wedding Invitation \u2764\uFE0F";

/** Names this message in the server logs / mock console output. */
export const WEDDING_CONFIRMATION_KIND = "wedding-rsvp-confirmation";

/** The couple, bride first - mirrors Wedding/src/config/wedding.js. */
export const WEDDING_COUPLE_NAMES = "Radha & Rohit";

// The invitation's palette, repeated here because an email cannot read CSS
// variables. These are the only colours this message uses.
const BG = "#16090D";
const CARD = "#250D16";
const GOLD = "#C5A46D";
const CHAMPAGNE = "#E5C992";
const MUTED_GOLD = "#9B7B49";
const IVORY = "#F5EFE5";
const MUTED_IVORY = "#CFC3B5";
const TAUPE = "#9c8b7a";

const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Escapes everything that comes from a guest before it is placed in markup.
 * The greeting name is the only guest-supplied value in the message.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Folds a guest-supplied name into one clean line, or "" when there is none. */
export function cleanGuestName(name) {
  return String(name ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Dear Ramesh," when the guest gave a name, "Dear Guest," when they did not.
 * The name is folded to a single line and escaped, so it can never break the
 * layout or inject markup.
 */
function greeting(name) {
  const clean = cleanGuestName(name);
  return clean ? `Dear ${escapeHtml(clean)},` : "Dear Guest,";
}

/** The same greeting, for the plain-text alternative. */
function plainGreeting(name) {
  const clean = cleanGuestName(name);
  return clean ? `Dear ${clean},` : "Dear Guest,";
}

/**
 * The one decorative rule used in the message: a gold hairline, a small
 * diamond, and another hairline. Table cells keep it stable in every client.
 */
function ornament() {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                <tr>
                  <td width="45%" style="border-top:1px solid ${MUTED_GOLD};font-size:0;line-height:0;">&nbsp;</td>
                  <td width="10%" align="center" style="padding:0 10px;color:${GOLD};font-family:${SERIF};font-size:14px;line-height:14px;">&#9670;</td>
                  <td width="45%" style="border-top:1px solid ${MUTED_GOLD};font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>`;
}

/** The plain-text alternative, so the message is complete in any client. */
export function buildWeddingConfirmationText({ name } = {}) {
  return [
    "THE WEDDING INVITATION",
    "",
    plainGreeting(name),
    "",
    "Thank you for accepting our wedding invitation.",
    "",
    "We are delighted that you will be joining us to celebrate this special chapter of our lives. Your presence will make our celebration even more memorable, and we look forward to sharing these beautiful moments with you.",
    "",
    "With love and gratitude,",
    WEDDING_COUPLE_NAMES,
    "",
    "You are receiving this email because you accepted our wedding invitation.",
  ].join("\n");
}

/**
 * The royal HTML confirmation.
 *
 * Everything is a `role="presentation"` table with inline styles: no <style>
 * block, no webfont, no image and no external asset. That is what keeps it
 * intact in Gmail, Outlook and mobile clients.
 */
export function buildWeddingConfirmationHtml({ name } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(WEDDING_CONFIRMATION_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BG};font-size:1px;line-height:1px;">
    Thank you for accepting our wedding invitation - we look forward to celebrating with you.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:${BG};">
    <tr>
      <td align="center" style="padding:40px 14px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;background-color:${CARD};border:1px solid ${GOLD};">
          <tr>
            <td style="padding:6px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${MUTED_GOLD};">
                <tr>
                  <td align="center" style="padding:36px 28px 8px;">
                    <p style="margin:0;font-family:${SANS};font-size:11px;letter-spacing:0.34em;text-transform:uppercase;color:${GOLD};">The Wedding Invitation</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:20px 28px 0;">
                    <h1 style="margin:0;font-family:${SERIF};font-size:34px;line-height:1.2;font-weight:400;color:${IVORY};">Thank You</h1>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:22px 28px 4px;">${ornament()}
                  </td>
                </tr>
                <tr>
                  <td align="left" style="padding:22px 28px 0;">
                    <p style="margin:0;font-family:${SERIF};font-size:20px;line-height:1.5;color:${CHAMPAGNE};">${greeting(name)}</p>
                  </td>
                </tr>
                <tr>
                  <td align="left" style="padding:18px 28px 0;">
                    <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.75;color:${IVORY};">Thank you for accepting our wedding invitation.</p>
                  </td>
                </tr>
                <tr>
                  <td align="left" style="padding:14px 28px 0;">
                    <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.8;color:${MUTED_IVORY};">We are delighted that you will be joining us to celebrate this special chapter of our lives. Your presence will make our celebration even more memorable, and we look forward to sharing these beautiful moments with you.</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:30px 28px 0;">${ornament()}
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:26px 28px 0;">
                    <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.6;font-style:italic;color:${MUTED_IVORY};">With love and gratitude,</p>
                    <p style="margin:12px 0 0;font-family:${SERIF};font-size:26px;line-height:1.3;color:${CHAMPAGNE};letter-spacing:0.02em;">${escapeHtml(WEDDING_COUPLE_NAMES)}</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:34px 28px 30px;">
                    <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.7;color:${TAUPE};">You are receiving this email because you accepted our wedding invitation.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Everything one confirmation needs, built once and sent as one message. */
export function buildWeddingConfirmation({ name } = {}) {
  return {
    subject: WEDDING_CONFIRMATION_SUBJECT,
    text: buildWeddingConfirmationText({ name }),
    html: buildWeddingConfirmationHtml({ name }),
  };
}

/**
 * Sends the confirmation to ONE guest.
 *
 * Returns a deliberately narrow result: `delivered` plus a provider label. The
 * provider's own error text is logged by the mailer (redacted) and never
 * returned here, so nothing about the transport, the credentials or the mailbox
 * can reach an API response.
 *
 * @param {{to: string, name?: string}} params `to` must already be validated
 *        and normalised by the caller - this function never sends to an
 *        address that came straight from a request body.
 * @returns {Promise<{delivered: boolean, status: string, provider: string}>}
 */
export async function sendWeddingConfirmation({ to, name }) {
  const { subject, text, html } = buildWeddingConfirmation({ name });

  try {
    const result = await sendMail({
      to,
      subject,
      body: text,
      html,
      kind: WEDDING_CONFIRMATION_KIND,
    });

    return {
      delivered: Boolean(result?.delivered),
      status: String(result?.status || (result?.delivered ? "sent" : "failed")),
      provider: String(result?.provider || "unknown"),
    };
  } catch (error) {
    // sendMail resolves a failure rather than throwing, so this is a last resort
    // that must never take the guest's already-stored reply down with it.
    console.error(`[wedding-mail] unexpected send failure: ${error?.name || "Error"}`);
    return { delivered: false, status: "failed", provider: "unknown" };
  }
}

export default {
  WEDDING_CONFIRMATION_SUBJECT,
  WEDDING_CONFIRMATION_KIND,
  WEDDING_COUPLE_NAMES,
  escapeHtml,
  cleanGuestName,
  buildWeddingConfirmation,
  buildWeddingConfirmationText,
  buildWeddingConfirmationHtml,
  sendWeddingConfirmation,
};