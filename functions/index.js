/**
 * Cloud Functions for OneVictoria Resident Hub
 *
 * Implements server-side email verification delivery via Mailjet Send API v3.1.
 * Generates official Firebase Auth email verification links using the Firebase Admin SDK,
 * protecting API keys with Firebase Secret Manager (MAILJET_API_KEY & MAILJET_SECRET_KEY).
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

// Server-side secret definitions (managed via Firebase Secret Manager)
const mailjetApiKey = defineSecret("MAILJET_API_KEY");
const mailjetSecretKey = defineSecret("MAILJET_SECRET_KEY");

// Rate limit configuration
const COOLDOWN_SECONDS = 60; // Minimum 60 seconds between requests
const MAX_REQUESTS_PER_HOUR = 5; // Max 5 verification emails per hour per user

/**
 * Escapes HTML characters to prevent XSS in email templates.
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Builds high-deliverability HTML and Plain Text email payloads.
 */
function buildVerificationEmailContent({ recipientName, verificationLink, supportEmail }) {
  const safeName = escapeHtml(recipientName || "Resident");
  const safeLink = escapeHtml(verificationLink);
  const safeSupport = escapeHtml(supportEmail);

  const textContent = [
    `Hello ${recipientName || "Resident"},`,
    "",
    "Thank you for registering with the OneVictoria Resident Hub.",
    "",
    "Please verify your email address by opening the following link in your browser:",
    verificationLink,
    "",
    "This link will expire in 3 days. If you did not create an account on OneVictoria, you can safely ignore this email.",
    "",
    "Best regards,",
    "The OneVictoria Team",
    `Contact: ${supportEmail}`,
  ].join("\n");

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your email address - OneVictoria</title>
  <style>
    body { margin:0; padding:0; background-color:#f4f6f9; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1e293b; }
    .wrapper { width:100%; table-layout:fixed; background-color:#f4f6f9; padding:40px 0; }
    .card { max-width:560px; margin:0 auto; background:#ffffff; border-radius:8px; border:1px solid #e2e8f0; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background:linear-gradient(135deg, #001f3f 0%, #003b71 100%); padding:28px 32px; text-align:center; color:#ffffff; }
    .brand { font-size:20px; font-weight:800; letter-spacing:0.04em; color:#ffffff; margin:0; text-transform:uppercase; }
    .subbrand { font-size:12px; color:#F2A900; font-weight:600; margin-top:4px; text-transform:uppercase; letter-spacing:0.08em; }
    .content { padding:36px 32px; }
    .title { font-size:18px; font-weight:700; color:#0f172a; margin-top:0; margin-bottom:16px; }
    .lead { font-size:14px; line-height:1.6; color:#334155; margin-bottom:24px; }
    .button-container { text-align:center; margin:32px 0; }
    .verify-btn { display:inline-block; background-color:#F2A900; color:#001f3f !important; text-decoration:none !important; font-weight:700; font-size:14px; padding:14px 28px; border-radius:6px; text-transform:uppercase; letter-spacing:0.04em; }
    .fallback-box { background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:12px 14px; margin-top:24px; }
    .fallback-label { font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px; }
    .fallback-link { font-size:12px; color:#005B9F; word-break:break-all; line-height:1.4; }
    .footer { padding:20px 32px; background-color:#f8fafc; border-top:1px solid #e2e8f0; font-size:11px; color:#64748b; line-height:1.5; text-align:center; }
  </style>
</head>
<body>
  <table class="wrapper" role="presentation">
    <tr>
      <td align="center">
        <table class="card" role="presentation">
          <tr>
            <td class="header">
              <h1 class="brand">OneVictoria</h1>
              <div class="subbrand">Resident Hub &amp; Community Services</div>
            </td>
          </tr>
          <tr>
            <td class="content">
              <h2 class="title">Verify your email address</h2>
              <p class="lead">Hello <strong>${safeName}</strong>,</p>
              <p class="lead">
                Thank you for creating an account with OneVictoria. To complete your registration and activate community features, please confirm your email address.
              </p>
              <div class="button-container">
                <a href="${safeLink}" target="_blank" rel="noopener noreferrer" class="verify-btn">Verify Email Address</a>
              </div>
              <p class="lead" style="font-size:12px; color:#64748b; margin-top:20px;">
                This verification link is valid for 3 days and can only be used once.
              </p>
              <div class="fallback-box">
                <div class="fallback-label">Having trouble with the button? Copy and paste this link:</div>
                <div class="fallback-link">${safeLink}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td class="footer">
              <p style="margin:0 0 6px 0;">If you did not create an account on OneVictoria, you can safely ignore this email.</p>
              <p style="margin:0;">&copy; OneVictoria Community. Need help? Contact <a href="mailto:${safeSupport}" style="color:#005B9F;">${safeSupport}</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return { textContent, htmlContent };
}

/**
 * Callable Function: sendVerificationEmail
 *
 * Requirements enforced:
 * 1. Caller must be authenticated with Firebase Auth (request.auth).
 * 2. Caller can only request verification for their own authenticated account.
 * 3. Enforces server-side rate limits (cooldown + max requests per hour) stored in Firestore.
 * 4. Generates an official Firebase Auth action link via admin.auth().generateEmailVerificationLink.
 * 5. Delivers the message via Mailjet API v3.1 using Secret Manager credentials.
 */
exports.sendVerificationEmail = onCall(
  {
    secrets: [mailjetApiKey, mailjetSecretKey],
    cors: true,
  },
  async (request) => {
    // 1. Authentication check: Caller must be signed in to request verification
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError(
        "unauthenticated",
        "Authentication required. You must be signed in to request a verification email."
      );
    }

    const uid = request.auth.uid;

    // 2. Fetch the caller's Firebase Auth record
    let userRecord;
    try {
      userRecord = await admin.auth().getUser(uid);
    } catch (authErr) {
      console.error("[sendVerificationEmail] Failed to fetch user record for uid:", uid);
      throw new HttpsError("not-found", "User account not found.");
    }

    if (!userRecord || !userRecord.email) {
      throw new HttpsError("failed-precondition", "User account has no associated email address.");
    }

    // If the user's email is already verified, do not send another verification email
    if (userRecord.emailVerified) {
      return {
        success: true,
        alreadyVerified: true,
        message: "Your email is already verified. You may proceed to log in.",
      };
    }

    const userEmail = userRecord.email;
    const userName = (request.data && request.data.name) || userRecord.displayName || "Resident";

    // 3. Enforce Rate Limiting using Firestore (_rate_limits collection)
    const now = Date.now();
    const rateLimitRef = admin.firestore().collection("_rate_limits").doc(`verification_${uid}`);
    let rateLimitDoc;
    try {
      rateLimitDoc = await rateLimitRef.get();
    } catch (dbErr) {
      console.warn("[sendVerificationEmail] Warning: could not read rate limit doc:", dbErr.message);
    }

    if (rateLimitDoc && rateLimitDoc.exists) {
      const data = rateLimitDoc.data() || {};
      const lastSent = data.lastSent || 0;
      const hourWindowStart = data.hourWindowStart || 0;
      const countThisHour = data.countThisHour || 0;

      // Cooldown check (60 seconds)
      const elapsedMs = now - lastSent;
      if (elapsedMs < COOLDOWN_SECONDS * 1000) {
        const remainingSeconds = Math.ceil((COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000);
        throw new HttpsError(
          "resource-exhausted",
          `Please wait ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"} before requesting another verification email.`
        );
      }

      // Max requests per hour check
      if (now - hourWindowStart < 3600 * 1000 && countThisHour >= MAX_REQUESTS_PER_HOUR) {
        throw new HttpsError(
          "resource-exhausted",
          "Too many verification requests. Please wait a few minutes before trying again."
        );
      }
    }

    // 4. Generate the official Firebase Auth email verification link
    let verificationLink;
    try {
      const actionCodeSettings = {
        url:
          process.env.CONTINUE_URL ||
          `https://${process.env.GCLOUD_PROJECT || "onevictoria-23409"}.firebaseapp.com`,
        handleCodeInApp: false,
      };
      verificationLink = await admin.auth().generateEmailVerificationLink(userEmail, actionCodeSettings);
    } catch (linkErr) {
      console.error("[sendVerificationEmail] Link generation failed for uid:", uid, linkErr.message);
      throw new HttpsError("internal", "Could not generate verification link. Please try again.");
    }

    // 5. Retrieve Mailjet credentials securely from Secret Manager
    const apiKey =
      (mailjetApiKey && typeof mailjetApiKey.value === "function" ? mailjetApiKey.value() : null) ||
      process.env.MAILJET_API_KEY;
    const secretKey =
      (mailjetSecretKey && typeof mailjetSecretKey.value === "function" ? mailjetSecretKey.value() : null) ||
      process.env.MAILJET_SECRET_KEY;

    if (
      !apiKey ||
      !secretKey ||
      apiKey.includes("YOUR_ROTATED") ||
      secretKey.includes("YOUR_ROTATED")
    ) {
      console.error(
        "[sendVerificationEmail] Missing or unconfigured Mailjet secrets. For local emulator testing, set them in functions/.secret.local."
      );
      throw new HttpsError(
        "failed-precondition",
        "Mail delivery service is not configured. Please ensure MAILJET_API_KEY and MAILJET_SECRET_KEY are set in functions/.secret.local."
      );
    }

    const senderEmail = process.env.MAILJET_SENDER_EMAIL || "mprvtccntlocked@gmail.com";
    const senderName = process.env.MAILJET_SENDER_NAME || "OneVictoria";
    const supportEmail = process.env.MAILJET_SUPPORT_EMAIL || "support@onevictoria.org";

    const { textContent, htmlContent } = buildVerificationEmailContent({
      recipientName: userName,
      verificationLink,
      supportEmail,
    });

    // 6. Deliver verification email via Mailjet Send API v3.1
    const mailjetPayload = {
      Messages: [
        {
          From: {
            Email: senderEmail,
            Name: senderName,
          },
          To: [
            {
              Email: userEmail,
              Name: userName,
            },
          ],
          Subject: "Verify your email address - OneVictoria",
          TextPart: textContent,
          HTMLPart: htmlContent,
          CustomID: `Verification_${uid}`,
          Headers: {
            "X-Mailjet-TrackClick": "0", // Disable click tracking to preserve Firebase Auth URL integrity
          },
        },
      ],
    };

    const basicAuth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");

    try {
      console.log(`[sendVerificationEmail] Sending verification email via Mailjet for user: ${uid}`);
      const mailjetResponse = await fetch("https://api.mailjet.com/v3.1/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        body: JSON.stringify(mailjetPayload),
      });

      if (!mailjetResponse.ok) {
        const errorText = await mailjetResponse.text();
        console.error("[sendVerificationEmail] Mailjet API responded with error status:", mailjetResponse.status);
        throw new Error(`Mailjet API error HTTP ${mailjetResponse.status}`);
      }

      const responseData = await mailjetResponse.json();
      const firstMessage = responseData?.Messages?.[0];

      if (firstMessage?.Status !== "success") {
        const errorDetail = firstMessage?.Errors?.[0]?.ErrorMessage || "Unknown Mailjet error";
        console.error("[sendVerificationEmail] Mailjet message delivery status not success:", errorDetail);
        throw new Error(`Mailjet delivery failed: ${errorDetail}`);
      }

      console.log(`[sendVerificationEmail] Verification email successfully delivered via Mailjet for user: ${uid}`);
    } catch (sendErr) {
      console.error("[sendVerificationEmail] Mailjet transport failure:", sendErr.message);
      throw new HttpsError("internal", "Failed to deliver verification email. Please try again.");
    }

    // 7. Update rate limit record in Firestore upon successful dispatch
    try {
      const existingData = (rateLimitDoc && rateLimitDoc.exists ? rateLimitDoc.data() : null) || {};
      const hourWindowStart =
        existingData.hourWindowStart && now - existingData.hourWindowStart < 3600 * 1000
          ? existingData.hourWindowStart
          : now;
      const countThisHour =
        existingData.hourWindowStart && now - existingData.hourWindowStart < 3600 * 1000
          ? (existingData.countThisHour || 0) + 1
          : 1;

      await rateLimitRef.set(
        {
          lastSent: now,
          hourWindowStart,
          countThisHour,
          userEmail,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (rateSaveErr) {
      console.warn("[sendVerificationEmail] Warning: could not update rate limit record:", rateSaveErr.message);
    }

    return {
      success: true,
      message: "Verification email has been sent successfully via Mailjet.",
    };
  }
);
