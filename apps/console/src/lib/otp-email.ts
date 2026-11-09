export type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

export interface OtpEmail {
  subject: string;
  text: string;
  html: string;
}

const HEADINGS: Record<OtpType, string> = {
  "sign-in": "Your sign-in code",
  "email-verification": "Confirm your email",
  "forget-password": "Reset your access",
  "change-email": "Confirm your new email",
};

/**
 * Transactional OTP mail. Kept to inline styles + a table layout so it renders
 * in Gmail/Outlook/Apple Mail; no CSS variables, no external assets (images
 * are blocked by default in most clients).
 */
export function otpEmail(otp: string, type: OtpType, expiresMinutes = 10): OtpEmail {
  const heading = HEADINGS[type] ?? "Your code";
  const subject = `${otp} is your ResolveZero code`;

  const text = [
    "ResolveZero",
    "",
    heading,
    "",
    `Code: ${otp}`,
    "",
    `It expires in ${expiresMinutes} minutes and can be used once.`,
    "Never share this code — ResolveZero will never ask you for it.",
    "If you did not request this, you can ignore this email.",
    "",
    "ResolveZero — your DNS, your rules.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b0b0a">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #e5e5e5;border-radius:10px">
            <tr>
              <td style="padding:28px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
                  <tr>
                    <td width="36" height="36" align="center" valign="middle" style="width:36px;height:36px;background:#0b0b0a;border-radius:10px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.02em;text-align:center;line-height:36px;mso-line-height-rule:exactly">R&Oslash;</td>
                    <td style="padding-left:10px;vertical-align:middle;font-size:13px;font-weight:600;letter-spacing:-0.01em;color:#0b0b0a">ResolveZero</td>
                  </tr>
                </table>
                <p style="margin:0 0 6px;font-size:11px;line-height:1.5;color:#6f6a62">${heading}</p>
                <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:34px;font-weight:600;letter-spacing:0.12em;line-height:1.15;color:#0b0b0a">${otp}</p>
                <p style="margin:20px 0 0;font-size:12px;line-height:1.7;color:#6f6a62">
                  It expires in ${expiresMinutes} minutes and can be used once.<br />
                  Never share this code — ResolveZero will never ask you for it.<br />
                  If you did not request this, you can ignore this email.
                </p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0;font-size:10px;line-height:1.6;color:#6f6a62">ResolveZero — your DNS, your rules.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
