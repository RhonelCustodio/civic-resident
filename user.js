import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { firebaseConfig } from "./firebase-config/firebase-config.js";
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  doc,
  updateDoc,
  getDocs,
  getDoc,
  getDocFromServer,
  where,
  limit,
  serverTimestamp,
  deleteDoc,
  setDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updatePassword,
  sendPasswordResetEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let app, db, auth;
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
} catch (initErr) {
  // Boot-loader safety: if Firebase cannot initialize (bad or missing
  // firebase-config.js), release the loading overlay instead of trapping
  // the visitor behind it, then surface the error for debugging.
  console.error(
    "Firebase initialization failed — check firebase-config/firebase-config.js",
    initErr,
  );
  const releaseOverlay = () =>
    document
      .getElementById("page-loading-overlay")
      ?.classList.remove("active");
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", releaseOverlay);
  } else {
    releaseOverlay();
  }
  throw initErr;
}

// ===== STANDARDIZED STATUS CONSTANTS =====
const STATUS = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  REGISTERED: "Registered",
  CANCELLED: "Cancelled",
};

/**
 * REJECTION BUG FIX: status values written by the admin panel do not always
 * match the exact capitalization/wording the user side compares against
 * (e.g. "rejected", "REJECTED", "Declined" vs "Rejected"). Every history
 * badge used strict equality, so a rejected record silently fell through to
 * the "Pending" badge. All rendering now funnels through this normalizer.
 */
function normalizeStatus(rawValue) {
  const s = String(rawValue ?? "")
    .trim()
    .toLowerCase();
  if (
    [
      "approved",
      "approve",
      "confirmed",
      "confirm",
      "completed",
      "complete",
      "verified",
      "success",
      "successful",
      "accepted",
      "accept",
    ].includes(s)
  )
    return STATUS.APPROVED;
  if (
    [
      "rejected",
      "reject",
      "declined",
      "decline",
      "denied",
      "deny",
      "failed",
      "invalid",
      "cancelled",
      "canceled",
    ].includes(s)
  )
    return STATUS.REJECTED;
  return STATUS.PENDING;
}

/** Resolve the effective status of a record (admin panels sometimes update
 *  paymentStatus instead of status — honor whichever indicates a decision). */
function effectiveStatus(data) {
  const primary = normalizeStatus(data?.status);
  if (primary !== STATUS.PENDING) return primary;
  if (data?.paymentStatus !== undefined && data?.paymentStatus !== null) {
    const secondary = normalizeStatus(data.paymentStatus);
    if (secondary !== STATUS.PENDING) return secondary;
  }
  return STATUS.PENDING;
}

/**
 * SLOW INTERNET BUFFER: wraps a Firestore read with retry + exponential
 * backoff so a single dropped packet on a slow connection no longer aborts
 * session restore (which previously force-logged the user out on refresh).
 */
async function withRetryBuffer(taskFn, options = {}) {
  const { retries = 3, baseDelay = 1200, label = "firestore" } = options;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await taskFn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = baseDelay * Math.pow(1.6, attempt);
        console.warn(
          `[retry-buffer] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(wait)}ms…`,
          err?.code || err?.message || err,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// ===== BOOT LOADER (slow-internet aware) =====
// The #page-loading-overlay covers the boot sequence. Keep its progress bar,
// but remove any legacy spinner circle so the startup loader is not duplicated.
let bootLoaderSlowTimer = null,
  bootLoaderFailsafeTimer = null,
  bootLoaderDone = false;

function showBootLoader() {
  const overlay = document.getElementById("page-loading-overlay");
  if (!overlay || bootLoaderDone) return;
  overlay.querySelector(".loading-spinner")?.remove();
  overlay.classList.add("active");
  const msg = overlay.querySelector("p");
  // After 8s on a slow connection, swap in a reassuring message.
  bootLoaderSlowTimer = setTimeout(() => {
    const sub = overlay.querySelectorAll("p")[1];
    if (sub)
      sub.innerHTML =
        '<i class="fa-solid fa-wifi mr-1"></i>Slow connection detected — still retrieving your data, please wait…';
  }, 8000);
  // Failsafe: never trap the user behind the overlay for more than 25s.
  bootLoaderFailsafeTimer = setTimeout(() => hideBootLoader(), 25000);
}

function hideBootLoader() {
  bootLoaderDone = true;
  if (bootLoaderSlowTimer) clearTimeout(bootLoaderSlowTimer);
  if (bootLoaderFailsafeTimer) clearTimeout(bootLoaderFailsafeTimer);
  document.getElementById("page-loading-overlay")?.classList.remove("active");
}

// ===== DONATION ITEM CATEGORIES =====
const DONATION_ITEM_CATEGORIES = [
  "Food & Groceries",
  "Clothing",
  "Medical Supplies",
  "School Supplies",
  "Hygiene Kits",
  "Construction Materials",
  "Electronics",
  "Others",
];

/** Compact "category + qty" line used in donation history tables. */
function formatItemDonationDetails(data) {
  const category = String(data.itemCategory || "").trim();
  const qty = Number(data.itemQuantity || 0);
  const unit = String(data.itemUnit || "").trim();
  const parts = [];
  if (category) parts.push(category);
  if (Number.isFinite(qty) && qty > 0)
    parts.push(`Qty: ${qty}${unit ? " " + unit : ""}`);
  return parts.join(" • ");
}

// ===== PAYMENT CONFIGURATION =====
const PAYMENT_CONFIG = {
  gcash: {
    number: "09916744853",
    name: "Municipality of Victoria",
  },
  paymaya: {
    number: "",
    name: "",
  },
  bankTransfer: {
    bankName: "GCash",
    accountNumber: "1234-5678-9011-1213",
    accountName: "Municipality of Victoria",
  },
  cashPayment: {
    officeAddress: "Municipal Hall, Victoria, Tarlac",
    officeHours: "8:00 AM - 5:00 PM, Monday to Friday",
  },
};

const QR_CONFIG = {
  gcashQrImage: "./src/assets/gcash-qr.jpg",
  paymayaQrImage: "./src/assets/maya-qr.jpg",
  banktransferQrImage: "./src/assets/gcash-qr.jpg",
};

// ===== GLOBAL STATE =====
let loggedInUser = null,
  alertTimeout = null,
  pendingConfirmCallback = null,
  isSaving = false;
let registeredEventIds = new Set(),
  completedEventIds = new Set();
let eventsUnsubscribe = null,
  participantsUnsubscribe = null,
  notificationsUnsubscribe = null,
  donationsUnsubscribe = null,
  volunteersUnsubscribe = null,
  hoursUnsubscribe = null;
let selectedPaymentMethod = null,
  currentDonationData = null,
  isTabSwitching = false;
let selectedProfilePicFile = undefined,
  selectedSkillVerificationFile = null;
let notificationCount = 0,
  allNotifications = [],
  showingAllNotifications = false;
let mobileShowingAllNotifications = false;
let activeNotificationId = null;
const pendingDeleteIds = new Set();
let accountStatusUnsubscribe = null;
let forcedLogoutInProgress = false;
let sessionCheckInterval = null,
  currentSessionToken = null;
let announcementsById = new Map();
let announcementFilterState = { priority: "All", query: "" };

// Dashboard overview state (kept in sync by the existing real-time listeners)
let dashboardServiceHours = 0,
  dashboardVolunteerApplications = 0,
  dashboardClockTimer = null,
  dashboardAgendaRequest = 0,
  eventExpiryTimer = null;

// ===== FORGOT PASSWORD FUNCTION =====
/**
 * Handle Forgot Password request using Firebase
 * Sends a password reset email to the user's email address
 */
window.handleForgotPassword = function () {
  // Check if modal already exists, remove it if so
  const existingModal = document.getElementById("forgot-password-modal");
  if (existingModal) {
    existingModal.remove();
  }

  // Create modal overlay
  const overlay = document.createElement("div");
  overlay.id = "forgot-password-modal";
  overlay.className =
    "fixed inset-0 bg-[#070818]/80 backdrop-blur-lg z-[9999] flex items-center justify-center p-4";

  // Create modal content
  const modal = document.createElement("div");
  modal.className =
    "glass rounded-lg max-w-md w-full p-8 border border-white/10 modal-enter relative";
  modal.onclick = function (e) {
    e.stopPropagation();
  };

  // Build modal HTML
  modal.innerHTML = `
    <button type="button" onclick="closeForgotPasswordModal()" 
            class="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors">
      <i class="fa-solid fa-xmark text-xl"></i>
    </button>
    
    <div class="text-center mb-6">
      <div class="w-14 h-14 bg-tsu-blue rounded-full flex items-center justify-center mx-auto mb-3 shadow-md">
        <i class="fa-solid fa-key text-tsu-gold text-xl"></i>
      </div>
      <h2 class="text-2xl font-extrabold text-tsu-gold tracking-tight">Reset Password</h2>
      <p class="text-sm text-gray-500 mt-1">Enter your email address to receive a password reset link</p>
    </div>
    
    <form id="forgot-password-form" class="space-y-4" novalidate>
      <div>
        <label class="block text-xs font-semibold text-[#C5CBE3] mb-1.5">Email Address</label>
        <div class="relative">
          <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
            <i class="fa-solid fa-envelope text-xs"></i>
          </span>
          <input type="email" id="forgot-email" required 
                 class="w-full pl-9 pr-3 py-2.5 rounded-sm border border-white/10 bg-white/5 text-white placeholder-gray-400 focus:border-tsu-gold focus:ring-2 focus:ring-tsu-gold/20 text-sm transition-all"
                 placeholder="example@gmail.com" 
                 autocomplete="email" />
        </div>
        <!-- Error message container inside the modal -->
        <div id="forgot-password-error" class="hidden mt-2 text-xs font-medium text-red-600 flex items-start space-x-2">
          <i class="fa-solid fa-circle-exclamation mt-0.5 text-[10px]"></i>
          <span id="forgot-password-error-text">Error message</span>
        </div>
        <p class="text-[10px] text-gray-400 mt-1">We'll send a reset link to this email</p>
      </div>
      
      <button type="submit" 
              class="w-full bg-tsu-blue hover:bg-tsu-blueDark text-white font-bold py-2.5 rounded-sm text-sm uppercase tracking-wider shadow-lg transition-all flex items-center justify-center space-x-2">
        <i class="fa-solid fa-paper-plane text-xs"></i>
        <span>Send Reset Link</span>
      </button>
    </form>
    
    <div class="text-center mt-4 pt-3 border-t border-gray-100">
      <p class="text-xs text-gray-400">Remember your password? 
        <button type="button" onclick="closeForgotPasswordModal()" 
                class="text-tsu-gold font-normal hover:underline">
          Back to Sign In
        </button>
      </p>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  // The reset form validates itself (red border + message inside the modal).
  disableNativeFormValidation();

  // Prevent body scroll
  document.body.style.overflow = "hidden";

  // Handle form submission
  const form = document.getElementById("forgot-password-form");
  if (form) {
    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      const email = document.getElementById("forgot-email")?.value.trim() || "";
      const emailInput = document.getElementById("forgot-email");
      const errorContainer = document.getElementById("forgot-password-error");
      const errorText = document.getElementById("forgot-password-error-text");

      // Reset any previous error styling
      if (emailInput) {
        emailInput.classList.remove(
          "border-red-500",
          "bg-red-50",
          "ring-red-500",
        );
        emailInput.classList.add("border-gray-200");
      }
      if (errorContainer) {
        errorContainer.classList.add("hidden");
        errorContainer.classList.remove("flex");
      }

      // Validate email
      if (!email) {
        // Highlight only the border red - no focus
        if (emailInput) {
          emailInput.classList.remove("border-gray-200");
          emailInput.classList.add("border-red-500");
          // Keep the red border until user focuses on the input
        }
        // Show error inside modal only
        if (errorContainer && errorText) {
          errorText.textContent = "Please enter your email address.";
          errorContainer.classList.remove("hidden");
          errorContainer.classList.add("flex");
        }
        return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        // Highlight only the border red - no focus
        if (emailInput) {
          emailInput.classList.remove("border-gray-200");
          emailInput.classList.add("border-red-500");
          // Keep the red border until user focuses on the input
        }
        // Show error inside modal only
        if (errorContainer && errorText) {
          errorText.textContent = "Please enter a valid email address.";
          errorContainer.classList.remove("hidden");
          errorContainer.classList.add("flex");
        }
        return;
      }

      // Show loading state on button
      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i><span>Sending...</span>';

      try {
        // Check if the user exists first
        let userExists = false;
        try {
          // Try to get user by email
          const userQuery = query(
            collection(db, "residents"),
            where("email", "==", email),
            limit(1),
          );
          const querySnapshot = await getDocs(userQuery);
          userExists = !querySnapshot.empty;
        } catch (checkError) {
          console.warn("Error checking user existence:", checkError);
        }

        // If user doesn't exist, throw an error immediately
        if (!userExists) {
          throw { code: "auth/user-not-found" };
        }

        // Send password reset email via Firebase
        await sendPasswordResetEmail(auth, email);

        // Show success message using toast
        window.showAlert(
          "Reset Link Sent!",
          `A password reset link has been sent to ${email}. Please check your inbox and spam folder.`,
          "success",
        );

        // Close modal after success
        setTimeout(() => {
          closeForgotPasswordModal();
        }, 1500);

        console.log(`✅ Password reset email sent to: ${email}`);
      } catch (error) {
        // Highlight only the border red - no focus, no text selection
        if (emailInput) {
          emailInput.classList.remove("border-gray-200");
          emailInput.classList.add("border-red-500");
          // DO NOT focus, DO NOT select text
        }

        // Handle specific Firebase errors
        let errorMessage = "Failed to send reset link. Please try again.";

        switch (error.code) {
          case "auth/user-not-found":
            // User doesn't exist - show clear error message
            errorMessage =
              "No account exists with this email address. Please check your email or create a new account.";
            break;

          case "auth/invalid-email":
            errorMessage = "Please enter a valid email address.";
            break;

          case "auth/too-many-requests":
            errorMessage =
              "Too many requests. Please wait a few minutes and try again.";
            break;

          case "auth/network-request-failed":
            errorMessage =
              "Network error. Please check your internet connection.";
            break;

          default:
            errorMessage = `Failed to send reset link: ${error.message}`;
        }

        // Show error inside modal only - NO toast message
        if (errorContainer && errorText) {
          errorText.textContent = errorMessage;
          errorContainer.classList.remove("hidden");
          errorContainer.classList.add("flex");
        }

        console.error("Password reset error:", error);
      } finally {
        // Reset button state
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
      }
    });

    // Add focus event to remove red border when user focuses on the input
    const emailInput = document.getElementById("forgot-email");
    const errorContainer = document.getElementById("forgot-password-error");
    if (emailInput) {
      // Remove red border and error message when user focuses on the input
      emailInput.addEventListener("focus", function () {
        this.classList.remove("border-red-500");
        this.classList.add("border-gray-200");
        // Hide error message when user focuses on input
        if (errorContainer) {
          errorContainer.classList.add("hidden");
          errorContainer.classList.remove("flex");
        }
      });

      // Also remove red border when user starts typing (backup)
      emailInput.addEventListener("input", function () {
        this.classList.remove("border-red-500");
        this.classList.add("border-gray-200");
        // Hide error message when user starts typing
        if (errorContainer) {
          errorContainer.classList.add("hidden");
          errorContainer.classList.remove("flex");
        }
      });
    }
  }
};

/**
 * Close the forgot password modal
 */
window.closeForgotPasswordModal = function () {
  const modal = document.getElementById("forgot-password-modal");
  if (modal) {
    modal.remove();
    document.body.style.overflow = "";
  }
};

// ===== RESEND VERIFICATION EMAIL (MAILJET) =====
/**
 * Opens a secure modal allowing residents to resend their verification email via Mailjet.
 * Authenticates with credentials so verification can only be requested for the user's own account.
 */
window.handleResendVerification = function (prefilledEmail = "") {
  const existingModal = document.getElementById("resend-verification-modal");
  if (existingModal) existingModal.remove();

  const defaultEmail =
    prefilledEmail ||
    document.getElementById("login-email")?.value.trim() ||
    "";

  const overlay = document.createElement("div");
  overlay.id = "resend-verification-modal";
  overlay.className =
    "fixed inset-0 bg-[#070818]/80 backdrop-blur-lg z-[9999] flex items-center justify-center p-4";

  const modal = document.createElement("div");
  modal.className =
    "glass rounded-lg max-w-md w-full p-8 border border-white/10 modal-enter relative";
  modal.onclick = function (e) {
    e.stopPropagation();
  };

  const safeDefaultEmail = defaultEmail
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  modal.innerHTML = `
    <button type="button" onclick="closeResendVerificationModal()" 
            class="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors">
      <i class="fa-solid fa-xmark text-xl"></i>
    </button>
    
    <div class="text-center mb-6">
      <div class="w-14 h-14 bg-tsu-blue rounded-full flex items-center justify-center mx-auto mb-3 shadow-md">
        <i class="fa-solid fa-envelope-circle-check text-tsu-gold text-xl"></i>
      </div>
      <h2 class="text-2xl font-extrabold text-tsu-gold tracking-tight">Resend Verification</h2>
      <p class="text-sm text-gray-400 mt-1">Confirm your account credentials to send a fresh verification email via Mailjet.</p>
    </div>
    
    <form id="resend-verification-form" class="space-y-4" novalidate>
      <div>
        <label class="block text-xs font-semibold text-[#C5CBE3] mb-1.5">Email Address</label>
        <div class="relative">
          <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
            <i class="fa-solid fa-envelope text-xs"></i>
          </span>
          <input type="email" id="resend-email" required value="${safeDefaultEmail}"
                 class="w-full pl-9 pr-3 py-2.5 rounded-sm border border-white/10 bg-white/5 text-white placeholder-gray-400 focus:border-tsu-gold focus:ring-2 focus:ring-tsu-gold/20 text-sm transition-all"
                 placeholder="example@gmail.com" 
                 autocomplete="email" />
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-[#C5CBE3] mb-1.5">Account Password</label>
        <div class="relative">
          <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
            <i class="fa-solid fa-lock text-xs"></i>
          </span>
          <input type="password" id="resend-password" required 
                 class="w-full pl-9 pr-3 py-2.5 rounded-sm border border-white/10 bg-white/5 text-white placeholder-gray-400 focus:border-tsu-gold focus:ring-2 focus:ring-tsu-gold/20 text-sm transition-all"
                 placeholder="Enter your account password" 
                 autocomplete="current-password" />
        </div>
        <p class="text-[10px] text-gray-400 mt-1">Credentials verify you are requesting an email for your own account.</p>
      </div>

      <div id="resend-verification-error" class="hidden text-xs font-medium text-red-500 flex items-start space-x-2">
        <i class="fa-solid fa-circle-exclamation mt-0.5 text-[10px]"></i>
        <span id="resend-verification-error-text"></span>
      </div>
      
      <button type="submit" id="resend-verification-submit"
              class="w-full bg-tsu-blue hover:bg-tsu-blueDark text-white font-bold py-2.5 rounded-sm text-sm uppercase tracking-wider shadow-lg transition-all flex items-center justify-center space-x-2">
        <i class="fa-solid fa-paper-plane text-xs"></i>
        <span>Send Verification Email</span>
      </button>
    </form>
    
    <div class="text-center mt-4 pt-3 border-t border-white/10">
      <p class="text-xs text-gray-400">
        <button type="button" onclick="closeResendVerificationModal()" 
                class="text-tsu-gold font-normal hover:underline">
          Back to Sign In
        </button>
      </p>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const form = document.getElementById("resend-verification-form");
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const email = document.getElementById("resend-email")?.value.trim().toLowerCase() || "";
    const password = document.getElementById("resend-password")?.value || "";
    const errBox = document.getElementById("resend-verification-error");
    const errText = document.getElementById("resend-verification-error-text");
    const submitBtn = document.getElementById("resend-verification-submit");

    const showError = (msg) => {
      if (errBox && errText) {
        errText.textContent = msg;
        errBox.classList.remove("hidden");
        errBox.classList.add("flex");
      }
    };

    if (!email || !password) {
      showError("Please enter your email and password.");
      return;
    }

    if (errBox) {
      errBox.classList.add("hidden");
      errBox.classList.remove("flex");
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i><span>Sending via Mailjet...</span>';
    }

    try {
      // 1. Authenticate to establish identity and token
      const uc = await signInWithEmailAndPassword(auth, email, password);
      await uc.user.reload();

      // 2. Check if already verified
      if (uc.user.emailVerified) {
        await signOut(auth);
        closeResendVerificationModal();
        window.showAlert(
          "Already Verified",
          "Your email address is already verified. You can log in directly.",
          "success"
        );
        return;
      }

      // 3. Dispatch fresh verification email (relayed through Mailjet SMTP)
      await sendEmailVerification(uc.user);

      // 4. Safely sign out the unverified account
      await signOut(auth);

      closeResendVerificationModal();
      window.showAlert(
        "Verification Sent!",
        `A new verification link has been delivered to ${email} via Mailjet. Please check your inbox and spam folder.`,
        "success"
      );
    } catch (err) {
      console.error("Resend verification failed:", err);
      try { await signOut(auth); } catch (_) {}

      let displayMsg = err.message || "Failed to resend verification email.";
      if (
        err.code === "auth/invalid-credential" ||
        err.code === "auth/wrong-password" ||
        err.code === "auth/user-not-found"
      ) {
        displayMsg = "Invalid email or password. Please check your credentials.";
      } else if (
        err.code === "auth/too-many-requests" ||
        err.code === "resource-exhausted" ||
        err.message?.includes("wait")
      ) {
        displayMsg = "Please wait a moment before requesting another verification email.";
      }

      showError(displayMsg);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i><span>Send Verification Email</span>';
      }
    }
  });
};

window.closeResendVerificationModal = function () {
  const modal = document.getElementById("resend-verification-modal");
  if (modal) {
    modal.remove();
    document.body.style.overflow = "";
  }
};

// ===== PASSWORD SYNC ON LOGIN =====
/**
 * Sync the password with Firestore after login
 * This ensures the password in Firestore matches the one in Firebase Auth
 */
// ===== DISABLED ACCOUNT HELPERS =====
// An admin can disable a resident from the admin terminal. That sets
// isDisabled/accountStatus on the resident document.
function isAccountDisabled(data) {
  return (
    data?.isDisabled === true ||
    data?.accountStatus === "Disabled" ||
    // Soft-deleted (archived) accounts are locked out too. The admin can
    // restore them from the Deleted filter in the admin terminal.
    data?.isDeleted === true ||
    data?.accountStatus === "Deleted"
  );
}

// Deleted accounts get a recovery message instead of a ban message.
function accountLockMessage(data) {
  if (data?.isDeleted === true || data?.accountStatus === "Deleted") {
    return "This account has been deleted. If you would like it recovered, please contact the Victoria municipal office and request account recovery.";
  }
  const reason = data?.disabledReason || "Violation of portal rules";
  return `Your account has been disabled by the municipal administrator. Reason: ${reason}. Please visit the Victoria municipal office if you believe this is a mistake.`;
}

// Immediately tear down the session of a resident who was just disabled.
async function forceLogoutDisabled(reasonOrData) {
  // The watcher, the heartbeat and the auth listener can all fire at once.
  // Only the first one should tear the session down and show the alert.
  if (forcedLogoutInProgress) return;
  forcedLogoutInProgress = true;
  try {
    stopSessionHeartbeat();
    if (accountStatusUnsubscribe) {
      accountStatusUnsubscribe();
      accountStatusUnsubscribe = null;
    }
    if (participantsUnsubscribe) participantsUnsubscribe();
    if (notificationsUnsubscribe) notificationsUnsubscribe();
    if (donationsUnsubscribe) donationsUnsubscribe();
    if (volunteersUnsubscribe) volunteersUnsubscribe();
    if (hoursUnsubscribe) hoursUnsubscribe();

    await signOut(auth);
    clearUserSession();
    loggedInUser = null;
    currentSessionToken = null;

    window.closeAuthPanels?.();
    document.getElementById("auth-screen")?.classList.remove("hidden");
    document.getElementById("dashboard")?.classList.add("hidden");
    hideNotificationBell();
    renderPublicEvents();
    hideLoading();

    // Accepts either the resident data object or a plain reason string.
    const data =
      typeof reasonOrData === "object" && reasonOrData !== null
        ? reasonOrData
        : { disabledReason: reasonOrData };
    const deleted = data.isDeleted === true || data.accountStatus === "Deleted";

    window.showAlert(
      deleted ? "Account Deleted" : "Account Disabled",
      `${accountLockMessage(data)} You have been signed out.`,
      "error",
    );
  } catch (e) {
    console.error("Force logout failed:", e);
  } finally {
    // Let the auth screen settle before allowing another forced logout.
    setTimeout(() => {
      forcedLogoutInProgress = false;
    }, 3000);
  }
}

// Live watcher: signs the resident out the instant an admin disables them,
// even if their tab is already open.
function watchAccountStatus(uid) {
  if (!uid) return;
  if (accountStatusUnsubscribe) accountStatusUnsubscribe();
  accountStatusUnsubscribe = onSnapshot(
    doc(db, "residents", uid),
    { includeMetadataChanges: false },
    (snap) => {
      // The very first callback can be served from the local cache, which may
      // still hold the pre-deletion copy. Ignore cached frames so we only act
      // on what the server actually says.
      if (snap.metadata.fromCache) return;

      // Document gone entirely = the admin used Permanently Delete. The old
      // code returned here, which is why a hard-deleted resident stayed
      // logged in. Treat a missing profile as an immediate sign-out.
      if (!snap.exists()) {
        forceLogoutDisabled({ accountStatus: "Deleted", isDeleted: true });
        return;
      }

      const data = snap.data();
      if (isAccountDisabled(data)) {
        forceLogoutDisabled(data);
        return;
      }

      // Keep dashboard readiness tied to the latest resident document rather
      // than a stale percentage calculated only at login.
      if (loggedInUser?.id === uid) {
        const readinessFields = [
          "name",
          "email",
          "phone",
          "age",
          "gender",
          "address",
          "addressVerified",
          "addressLat",
          "addressLng",
          "profilePic",
        ];
        const profileChanged = readinessFields.some(
          (field) => String(loggedInUser[field] ?? "") !== String(data[field] ?? ""),
        );
        if (profileChanged) {
          readinessFields.forEach((field) => {
            loggedInUser[field] = data[field];
          });
          saveUserSession(loggedInUser);
          refreshDashboardOverview(false);
        }
      }
    },
    (err) => {
      // A permission-denied here means the rules cut us off, which in this
      // app only happens once the account is no longer in good standing.
      console.error("Account status watcher error:", err);
      if (err?.code === "permission-denied") {
        forceLogoutDisabled({ accountStatus: "Deleted", isDeleted: true });
      }
    },
  );
}

// syncPasswordOnLogin removed: passwords must never be written to Firestore
// or localStorage. Firebase Authentication is the only password store.

// ===== MOBILE SIDE MENU =====
function openMobileMenu() {
  const menu = document.getElementById("mobile-side-menu");
  const overlay = document.getElementById("mobile-overlay-menu");
  if (menu) {
    menu.classList.add("open");
    document.body.classList.add("menu-open");
  }
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.classList.add("show");
  }
}
function closeMobileMenu() {
  const menu = document.getElementById("mobile-side-menu");
  const overlay = document.getElementById("mobile-overlay-menu");
  if (menu) {
    menu.classList.remove("open");
    document.body.classList.remove("menu-open");
  }
  if (overlay) {
    overlay.classList.remove("show");
    setTimeout(() => overlay.classList.add("hidden"), 300);
  }
}
window.openMobileMenu = openMobileMenu;
window.closeMobileMenu = closeMobileMenu;

// ===== HEADER DROPDOWN MANAGEMENT =====
function closeAllHeaderDropdowns() {
  document
    .querySelectorAll(".header-dropdown")
    .forEach((d) => d.classList.remove("show"));
}

// ===== DATE UTILITIES =====
function escapeAnnouncementHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSafeAnnouncementImageUrl(value) {
  const imageUrl = String(value || "").trim();
  if (!imageUrl) return "";

  // Organizer uploads may be original or high-quality optimized image data URLs.
  if (/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(imageUrl)) {
    return imageUrl;
  }

  try {
    const parsed = new URL(imageUrl, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

function formatShortDate(ts) {
  if (!ts) return "N/A";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function formatRelativeTime(ts) {
  if (!ts) return "";
  const now = new Date(),
    date = ts.toDate ? ts.toDate() : new Date(ts);
  const diffMs = now - date,
    diffSec = Math.floor(diffMs / 1000),
    diffMin = Math.floor(diffSec / 60),
    diffHr = Math.floor(diffMin / 60),
    diffDays = Math.floor(diffHr / 24),
    diffWeeks = Math.floor(diffDays / 7),
    diffMonths = Math.floor(diffDays / 30),
    diffYears = Math.floor(diffDays / 365);
  if (diffSec < 60) return "Just now";
  if (diffMin < 60)
    return `${diffMin} ${diffMin === 1 ? "minute" : "minutes"} ago`;
  if (diffHr < 24) return `${diffHr} ${diffHr === 1 ? "hour" : "hours"} ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffWeeks < 5)
    return `${diffWeeks} ${diffWeeks === 1 ? "week" : "weeks"} ago`;
  if (diffMonths < 12)
    return `${diffMonths} ${diffMonths === 1 ? "month" : "months"} ago`;
  if (diffYears === 1) return "1 year ago";
  return `${diffYears} years ago`;
}
function formatFullDateTime(ts) {
  if (!ts) return "";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return (
    date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }) +
    " at " +
    date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  );
}
function formatTimeDisplay(timeValue) {
  if (!timeValue) return "";
  if (typeof timeValue === "string" && timeValue.includes(":")) {
    const [hours, minutes] = timeValue.split(":");
    const h = parseInt(hours),
      ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${minutes} ${ampm}`;
  }
  return timeValue;
}

// ===== EVENT DATE & TIME STATUS =====
// The event's date + scheduled time is treated as its due point. As soon as
// that minute is reached in Philippine time, its action changes to "Ended".
function getPhilippineDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function getPhilippineTimeMinutes(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  const parts = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((item) => item.type === "hour")?.value || 0);
  const minute = Number(
    parts.find((item) => item.type === "minute")?.value || 0,
  );
  return hour * 60 + minute;
}

function getEventDateKey(dateValue) {
  if (!dateValue) return "";
  if (typeof dateValue?.toDate === "function")
    return getPhilippineDateKey(dateValue.toDate());
  if (typeof dateValue === "object" && dateValue.seconds)
    return getPhilippineDateKey(new Date(dateValue.seconds * 1000));

  const raw = String(dateValue).trim();
  if (!raw || raw.toLowerCase() === "tba") return "";

  // Preserve date-only values exactly; parsing them as UTC could shift dates.
  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : getPhilippineDateKey(parsed);
}

function parseEventTimeMinutes(timeValue) {
  if (timeValue === undefined || timeValue === null || timeValue === "")
    return null;
  const raw = String(timeValue).trim().toUpperCase();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3] || "";
  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

function getEventDateStatus(dateValue, timeValue) {
  const eventKey = getEventDateKey(dateValue);
  if (!eventKey)
    return { key: "tba", label: "Date TBA", ended: false, today: false };

  const now = new Date();
  const todayKey = getPhilippineDateKey(now);
  if (eventKey < todayKey)
    return { key: "ended", label: "Ended", ended: true, today: false };
  if (eventKey > todayKey)
    return { key: "upcoming", label: "Upcoming", ended: false, today: false };

  const dueMinutes = parseEventTimeMinutes(timeValue);
  if (dueMinutes !== null && getPhilippineTimeMinutes(now) >= dueMinutes)
    return { key: "ended", label: "Ended", ended: true, today: true };

  return { key: "today", label: "Today", ended: false, today: true };
}

function getEventDueTimestamp(dateValue, timeValue) {
  const dateKey = getEventDateKey(dateValue);
  if (!dateKey) return null;
  const dueMinutes = parseEventTimeMinutes(timeValue);
  if (dueMinutes === null) {
    // Events without a time remain active for their full scheduled date.
    return new Date(`${dateKey}T23:59:59.999+08:00`).getTime() + 1;
  }
  const hour = String(Math.floor(dueMinutes / 60)).padStart(2, "0");
  const minute = String(dueMinutes % 60).padStart(2, "0");
  return new Date(`${dateKey}T${hour}:${minute}:00+08:00`).getTime();
}

function getEventCreatedTimestamp(event) {
  if (!event) return 0;
  const raw = event.createdAt;
  if (raw) {
    if (typeof raw.toMillis === "function") {
      const ms = raw.toMillis();
      if (Number.isFinite(ms)) return ms;
    }
    if (typeof raw.toDate === "function") {
      const ms = raw.toDate().getTime();
      if (Number.isFinite(ms)) return ms;
    }
    if (typeof raw.seconds === "number") {
      const ms = raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
      if (Number.isFinite(ms)) return ms;
    }
    if (raw instanceof Date) {
      const ms = raw.getTime();
      if (Number.isFinite(ms)) return ms;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  // Safe fallback: scheduled event date / due timestamp
  const due = getEventDueTimestamp(event.date, event.time);
  if (Number.isFinite(due)) return due;

  if (event.date) {
    const parsedDate = Date.parse(event.date);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }

  return 0;
}

function sortEvents(events) {
  const list = [];
  if (Array.isArray(events)) {
    for (let i = 0; i < events.length; i++) list.push(events[i]);
  } else if (events && typeof events.forEach === "function") {
    events.forEach((d) => {
      const data = typeof d.data === "function" ? d.data() : d;
      list.push({ id: d.id, ...data });
    });
  } else {
    return [];
  }

  const activeEvents = [];
  const endedEvents = [];

  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    const isEnded = !!getEventDateStatus(ev.date, ev.time).ended;
    if (isEnded) {
      endedEvents.push(ev);
    } else {
      activeEvents.push(ev);
    }
  }

  const compareByCreatedDesc = (a, b) => {
    const ta = getEventCreatedTimestamp(a);
    const tb = getEventCreatedTimestamp(b);
    if (tb !== ta) return tb - ta;
    return String(b.id || "").localeCompare(String(a.id || ""));
  };

  activeEvents.sort(compareByCreatedDesc);
  endedEvents.sort(compareByCreatedDesc);

  return activeEvents.concat(endedEvents);
}

function scheduleNextEventStatusRefresh(snapshot) {
  if (eventExpiryTimer) {
    clearTimeout(eventExpiryTimer);
    eventExpiryTimer = null;
  }
  if (!snapshot) return;

  const now = Date.now();
  const dueTimes = [];
  snapshot.forEach((eventDoc) => {
    const eventData = eventDoc.data ? eventDoc.data() : eventDoc;
    const due = getEventDueTimestamp(eventData.date, eventData.time);
    if (Number.isFinite(due) && due > now) dueTimes.push(due);
  });
  if (!dueTimes.length) return;

  const nextDue = Math.min(...dueTimes);
  // Wake daily for far-future events, or just after the exact due minute.
  const delay = Math.max(200, Math.min(nextDue - now + 200, 24 * 60 * 60 * 1000));
  eventExpiryTimer = setTimeout(() => {
    renderEvents();
    renderPublicEvents();
    renderMyEvents();
    renderDashboardAgenda();
  }, delay);
}

function eventDateBadgeHtml(dateValue, timeValue) {
  const status = getEventDateStatus(dateValue, timeValue);
  if (status.ended)
    return '<span class="inline-flex items-center gap-1 rounded-full bg-gray-900/90 text-white border border-white/20 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider shadow-md"><i class="fa-solid fa-flag-checkered"></i>Ended</span>';
  if (status.today)
    return '<span class="inline-flex items-center gap-1 rounded-full bg-tsu-gold text-tsu-dark border border-white/20 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider shadow-md"><i class="fa-solid fa-circle-dot"></i>Today</span>';
  return "";
}

function eventEndedButtonHtml() {
  return '<span class="inline-flex items-center gap-2 text-xs font-bold text-gray-500 bg-gray-100 px-3 py-2 rounded-sm border border-gray-200 w-full justify-center pointer-events-none"><i class="fa-solid fa-flag-checkered"></i><span>Event Ended</span></span>';
}

// ===== QR CODE DISPLAY (NO GENERATION API) =====
// Each payment method renders its own uploaded image (QR_CONFIG.*QrImage).
// The qrserver.com API and the EMVCo/QRPh payload builders are gone.

/**
 * Display the payment QR for a method. GCash, PayMaya and bank transfer each
 * show a SEPARATE QR file configured in QR_CONFIG (gcashQrImage,
 * paymayaQrImage, banktransferQrImage). No fixed amount is
 * embedded — the payer types the amount in their app. If a method's path is
 * set to "", its QR card is hidden and only the details/instructions render.
 */
function displayQRCode(method) {
  const ph = document.getElementById("qr-code-placeholder");
  if (!ph) return;

  let label = "";
  let number = "";
  let name = "";
  let instructions = "";

  if (method === "gcash") {
    // Shows the uploaded GCash "My QR" image (QR_CONFIG.gcashQrImage)
    label = "Scan with GCash App";
    number = PAYMENT_CONFIG.gcash.number;
    name = PAYMENT_CONFIG.gcash.name;
    instructions = `
      <div class="text-xs text-gray-600 mt-4 p-4 bg-gradient-to-br from-blue-50 to-blue-100/50 rounded-md border border-blue-200">
        <div class="flex items-start space-x-2 mb-3">
          <div class="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center shrink-0 mt-0.5">
            <i class="fa-solid fa-mobile-screen text-white text-[10px]"></i>
          </div>
          <p class="font-bold text-blue-800 text-sm">How to Pay via GCash</p>
        </div>
        <ol class="space-y-2 text-[11px]">
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">1.</span>
            <span>Open your <span class="font-bold">GCash app</span> on your phone</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">2.</span>
            <span>Tap <span class="font-bold">"Scan QR"</span> to scan the code</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">3.</span>
            <span><span class="font-bold">Enter the amount</span> you wish to donate</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">4.</span>
            <span>Review and <span class="font-bold">confirm payment</span></span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">5.</span>
            <span><span class="font-bold">Save screenshot</span> of confirmation</span>
          </li>
        </ol>
        
        <div class="mt-3 p-3 bg-white rounded-md border border-blue-200">
          <p class="text-[10px] text-gray-500 mb-1 text-center">Or manually send to:</p>
          <div class="flex flex-col items-center space-y-2">
            <div class="flex items-center justify-center space-x-2">
              <i class="fa-solid fa-mobile-screen text-blue-600"></i>
              <span class="font-bold text-gray-800 font-mono text-sm">${number}</span>
            </div>
            <button onclick="window.copyToClipboard('${number}')" 
                    class="text-xs text-blue-600 hover:text-blue-800 px-4 py-1.5 rounded-sm border border-blue-200 hover:bg-blue-50 transition-all">
              <i class="fa-solid fa-copy mr-1"></i>Copy Number
            </button>
          </div>
          <p class="text-[10px] text-gray-500 mt-1 text-center">${name}</p>
        </div>
      </div>
    `;
  } else if (method === "paymaya") {
    // Maya/PayMaya gets its OWN QR image (QR_CONFIG.paymayaQrImage) — e.g. a
    // screenshot of the Maya "Pay to QR" / My Maya QR, not the GCash one.
    label = "Scan with Maya App";
    number = PAYMENT_CONFIG.paymaya.number;
    name = PAYMENT_CONFIG.paymaya.name;
    instructions = `
      <div class="text-xs text-gray-600 mt-4 p-4 bg-gradient-to-br from-purple-50 to-purple-100/50 rounded-md border border-purple-200">
        <div class="flex items-start space-x-2 mb-3">
          <div class="w-6 h-6 bg-purple-500 rounded-full flex items-center justify-center shrink-0 mt-0.5">
            <i class="fa-solid fa-mobile-screen text-white text-[10px]"></i>
          </div>
          <p class="font-bold text-purple-800 text-sm">How to Pay via Maya</p>
        </div>
        <ol class="space-y-2 text-[11px]">
          <li class="flex items-start space-x-2">
            <span class="font-bold text-purple-600">1.</span>
            <span>Open your <span class="font-bold">Maya (formerly PayMaya) app</span></span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-purple-600">2.</span>
            <span>Tap <span class="font-bold">"Pay for QR" / "Scan"</span> in the Maya app</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-purple-600">3.</span>
            <span>Scan the <span class="font-bold">Maya QR</span> shown above</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-purple-600">4.</span>
            <span>Enter the amount and <span class="font-bold">confirm payment</span></span>
          </li>
        </ol>
        ${number
        ? `<div class="mt-3 p-3 bg-white rounded-md border border-purple-200">
          <p class="text-[10px] text-gray-500 mb-1 text-center">Or manually send to:</p>
          <div class="flex flex-col items-center space-y-2">
            <div class="flex items-center justify-center space-x-2">
              <i class="fa-solid fa-mobile-screen text-purple-600"></i>
              <span class="font-bold text-gray-800 font-mono text-sm">${number}</span>
            </div>
            <button onclick="window.copyToClipboard('${number}')" 
                    class="text-xs text-purple-600 hover:text-purple-800 px-4 py-1.5 rounded-sm border border-purple-200 hover:bg-purple-50 transition-all">
              <i class="fa-solid fa-copy mr-1"></i>Copy Number
            </button>
          </div>
          ${name ? `<p class="text-[10px] text-gray-500 mt-1 text-center">${name}</p>` : ""}
        </div>`
        : ""
      }
      </div>
    `;
  } else if (method === "bank_transfer") {
    label = "Scan with your Bank App (or use the details below)";
    instructions = `
      <div class="text-xs text-gray-600 mt-4 p-4 bg-gradient-to-br from-green-50 to-green-100/50 rounded-md border border-green-200">
        <div class="flex items-start space-x-2 mb-3">
          <div class="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center shrink-0 mt-0.5">
            <i class="fa-solid fa-building-columns text-white text-[10px]"></i>
          </div>
          <p class="font-bold text-green-800 text-sm">Bank Transfer Details</p>
        </div>
        <div class="space-y-3">
          <div class="bg-white rounded-md p-3 border border-green-200">
            <ol class="space-y-2 text-[11px]">
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">1. Bank</span>
            <span class="font-bold text-gray-800">${PAYMENT_CONFIG.bankTransfer.bankName}</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">2. Account</span>
            <span class="font-bold text-gray-800 font-mono">${PAYMENT_CONFIG.bankTransfer.accountNumber}</span>
          </li>
          <li class="flex items-start space-x-2">
            <span class="font-bold text-blue-600">3. Name</span>
            <span class="font-bold text-gray-800">${PAYMENT_CONFIG.bankTransfer.accountName}</span>
          </li>
        </ol>
            <button onclick="window.copyToClipboard('${PAYMENT_CONFIG.bankTransfer.accountNumber}')" 
                    class="mt-2 text-xs text-green-600 hover:text-green-800 px-3 py-1.5 rounded-sm border border-green-200 hover:bg-green-50 transition-all w-full">
              <i class="fa-solid fa-copy mr-1"></i>Copy Account Number
            </button>
          </div>
          <p class="text-[10px] text-amber-700 flex items-start space-x-1">
            <i class="fa-solid fa-triangle-exclamation mt-0.5"></i>
            <span>Please include your <span class="font-bold">full name</span> in the transfer reference</span>
          </p>
          <p class="text-[10px] text-green-700 flex items-start space-x-1">
            <i class="fa-solid fa-qrcode mt-0.5"></i>
            <span><span class="font-bold">Preferred:</span> scan the bank's QRPh image above with your mobile banking app to pay without typing the account number.</span>
          </p>
        </div>
      </div>
    `;
  }

  // Per-method QR image — each method has its own file in QR_CONFIG.
  const qrUrl =
    {
      gcash: QR_CONFIG.gcashQrImage,
      paymaya: QR_CONFIG.paymayaQrImage,
      bank_transfer: QR_CONFIG.banktransferQrImage,
    }[method] || "";
  const hasQr = qrUrl !== "";

  const qrCardHtml = hasQr
    ? `
      <!-- QR Code Card -->
      <div class="bg-white p-6 rounded-md shadow-lg border-2 border-gray-100">
        <!-- Scan Me Badge -->
        <div class="flex justify-center mb-4">
          <div class="bg-tsu-blue text-white px-4 py-1.5 rounded-full text-xs font-bold inline-flex items-center space-x-2">
            <i class="fa-solid fa-qrcode"></i>
            <span>SCAN TO PAY</span>
          </div>
        </div>

        <!-- QR Image -->
        <div class="relative flex justify-center">
          <div class="relative inline-block">
            <img src="${qrUrl}" 
                 alt="${label} QR Code" 
                 class="h-64 w-auto max-w-full mx-auto relative z-10 rounded-md"
                 onload="this.style.display='block';"
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">

            <!-- Error State -->
            <div class="qr-error hidden w-56 h-56 mx-auto flex-col items-center justify-center bg-red-50 rounded-md border-2 border-red-200 px-3 text-center">
              <i class="fa-solid fa-triangle-exclamation text-3xl text-red-400 mb-2"></i>
              <p class="text-sm text-red-600 font-medium">Failed to load QR</p>
              <p class="text-[10px] text-red-500 mt-1">Expected file: <span class="font-mono">${qrUrl}</span></p>
              <button onclick="window.displayQRCode('${method}')" 
                      class="text-xs text-red-600 hover:text-red-800 underline mt-1">
                Try Again
              </button>
            </div>
          </div>
        </div>

        <!-- Instruction text -->
        <p class="text-center text-xs text-gray-500 mt-4">
          ${label} • <span class="text-gray-400">Amount: <span class="font-bold text-[#C5CBE3]">You will input</span></span>
        </p>

        <!-- Action Buttons -->
        <div class="flex gap-2 mt-4">
          <button onclick="window.downloadQRCode('${qrUrl}', '${method}')" 
                  class="flex-1 text-xs text-tsu-blue hover:text-white hover:bg-tsu-blue px-3 py-2 rounded-sm border border-tsu-blue transition-all">
            <i class="fa-solid fa-download mr-1"></i>Download
          </button>
          <button onclick="window.shareQRCode('${qrUrl}', '${number}', '${label}')" 
                  class="flex-1 text-xs text-gray-600 hover:text-white hover:bg-gray-600 px-3 py-2 rounded-sm border border-gray-300 transition-all">
            <i class="fa-solid fa-share-nodes mr-1"></i>Share
          </button>
        </div>
      </div>

      <!-- Important Note -->
      <div class="mt-3 p-3 bg-amber-50 rounded-md border border-amber-200 text-center">
        <p class="text-[11px] text-amber-800">
          <i class="fa-solid fa-lightbulb mr-1"></i>
          <span class="font-bold">Reminder:</span> After scanning, enter your donation amount in the app
        </p>
      </div>`
    : "";

  ph.innerHTML = `
    <div class="qr-container">
      ${qrCardHtml}
      ${instructions}
    </div>
  `;
}

// Expose for the inline "Try Again" button inside the QR error state
// (inline onclick handlers cannot see module-scoped functions otherwise).
window.displayQRCode = displayQRCode;

// ===== Copy to Clipboard =====
window.copyToClipboard = function (text) {
  // Prevent default behavior
  if (window.event) {
    window.event.preventDefault();
    window.event.stopPropagation();
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        window.showAlert("Copied!", "Number copied to clipboard", "success");
      })
      .catch(() => {
        fallbackCopyToClipboard(text);
      });
  } else {
    fallbackCopyToClipboard(text);
  }

  // Return false to prevent form submission or page reload
  return false;
};

function fallbackCopyToClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-999999px";
  textArea.style.top = "-999999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy");
    window.showAlert("Copied!", "Number copied to clipboard", "success");
  } catch (err) {
    window.showAlert(
      "Error",
      "Failed to copy. Please manually type the number.",
      "error",
    );
  }
  document.body.removeChild(textArea);
}

// Add this to prevent all copy buttons from causing page reload
document.addEventListener("DOMContentLoaded", function () {
  // Use event delegation to handle all copy button clicks
  document.addEventListener("click", function (e) {
    const copyButton = e.target.closest('[onclick*="copyToClipboard"]');
    if (copyButton) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
});

// ===== Download QR Code =====
window.downloadQRCode = function (qrUrl, method) {
  if (!qrUrl) {
    const qrImg = document.querySelector("#qr-code-placeholder img");
    if (!qrImg || !qrImg.src) {
      window.showAlert("Error", "No QR code to download", "error");
      return;
    }
    qrUrl = qrImg.src;
  }

  // Each uploaded QR is a local file — save it directly, no API fetch.
  const ext = (qrUrl.match(/\.[a-z0-9]+$/i) || [".jpg"])[0];
  const fileBase =
    {
      gcash: "GCash-QR",
      paymaya: "PayMaya-QR",
      bank_transfer: "Bank-Transfer-QR",
    }[method] || "Payment-QR";

  try {
    const link = document.createElement("a");
    link.href = qrUrl;
    link.download = `${fileBase}${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.showAlert("Downloaded!", "QR code saved as image", "success");
  } catch (e) {
    window.open(qrUrl, "_blank");
    window.showAlert("Opened", "Right-click the QR image to save", "success");
  }
};

// ===== Share QR Code =====
window.shareQRCode = function (qrUrl, number, label) {
  const who = label || "GCash";
  const fileName = (qrUrl.split("/").pop() || "payment-qr.png").split("?")[0];

  if (navigator.share) {
    fetch(qrUrl)
      .then((response) => response.blob())
      .then((blob) => {
        const file = new File([blob], fileName, {
          type: blob.type || "image/jpg",
        });
        const shareData = {
          title: "Scan to Donate",
          text: `Scan this ${who} QR code to donate.${number ? ` Or send to: ${number}` : ""}`,
          files: [file],
        };
        return navigator.share(shareData);
      })
      .catch(() => {
        navigator
          .share({
            title: "Donation",
            text: `Send your donation via ${who}${number ? `: ${number}` : ""}`,
          })
          .catch(() => {
            window.showAlert(
              "Share",
              "Right-click QR to save and share manually",
              "info",
            );
          });
      });
  } else {
    // Static QR files — just open for right-click save / share.
    window.open(qrUrl, "_blank");
    window.showAlert(
      "QR Opened",
      "Right-click the image to save or share",
      "info",
    );
  }
};

// ===== MOBILE MENU TOGGLE (backward compatible) =====
window.toggleMobileMenu = function () {
  const mobileMenu = document.getElementById("mobile-side-menu");
  if (mobileMenu) {
    mobileMenu.classList.contains("open")
      ? closeMobileMenu()
      : openMobileMenu();
    return;
  }
  const sidebar = document.getElementById("sidebar"),
    overlay = document.getElementById("mobile-overlay"),
    body = document.body;
  if (!sidebar) return;
  const isOpen = sidebar.classList.contains("translate-x-0");
  if (isOpen) {
    sidebar.classList.remove("translate-x-0");
    sidebar.classList.add("-translate-x-full");
    if (overlay) overlay.classList.add("hidden");
    body.style.overflow = "";
  } else {
    sidebar.classList.remove("-translate-x-full");
    sidebar.classList.add("translate-x-0");
    if (overlay) overlay.classList.remove("hidden");
    body.style.overflow = "hidden";
  }
};

// ===== NOTIFICATION DETAIL OVERLAY =====
window.openNotificationDetail = function (notifId, type, title, message, time) {
  const overlay = document.getElementById("notification-detail-modal");
  if (!overlay) return;
  document.getElementById("notif-detail-title").textContent =
    title || "Notification";
  document.getElementById("notif-detail-time").innerHTML =
    `<i class="fa-solid fa-clock text-[10px] mr-1"></i>${time || "Just now"}`;
  document.getElementById("notif-detail-message").textContent = message || "";
  const iconContainer = document.getElementById("notif-detail-icon");
  const iconInner = document.getElementById("notif-detail-icon-inner");

  let bgClass = "bg-blue-50 text-blue-600 border border-blue-100/80",
    iconClass = "fa-bell";

  switch (type) {
    case "volunteer_approved":
      bgClass = "bg-emerald-50 text-emerald-600 border border-emerald-100/80";
      iconClass = "fa-circle-check";
      break;
    case "volunteer_rejected":
      bgClass = "bg-red-50 text-red-600 border border-red-100/80";
      iconClass = "fa-circle-xmark";
      break;
    case "donation_confirmed":
      bgClass = "bg-emerald-50 text-emerald-600 border border-emerald-100/80";
      iconClass = "fa-circle-check";
      break;
    case "donation_rejected":
      bgClass = "bg-red-50 text-red-600 border border-red-100/80";
      iconClass = "fa-circle-xmark";
      break;
    case "hours_credited":
      bgClass = "bg-purple-50 text-purple-600 border border-purple-100/80";
      iconClass = "fa-clock";
      break;
    case "contact_status_update":
      bgClass = "bg-indigo-50 text-indigo-600 border border-indigo-100/80";
      iconClass = "fa-envelope-circle-check";
      break;
    case "feedback_status":
      bgClass = "bg-indigo-50 text-indigo-600 border border-indigo-100/80";
      iconClass = "fa-envelope-circle-check";
      break;
  }

  if (iconContainer) {
    iconContainer.className = `w-11 h-11 rounded-xl flex items-center justify-center shadow-sm shrink-0 mt-0.5 ${bgClass}`;
  }
  if (iconInner) {
    iconInner.className = `fa-solid ${iconClass} text-base`;
  }

  // Track the currently-open notification for the delete button
  activeNotificationId = notifId || null;
  const actionsDiv = document.getElementById("notif-detail-actions");
  if (actionsDiv) {
    actionsDiv.innerHTML = `<button type="button" onclick="window.deleteNotification('${notifId}')" class="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 hover:text-red-700 border border-red-200 transition-colors shadow-sm"><i class="fa-solid fa-trash-can text-xs"></i><span>Delete Notification</span></button>`;
  }
  overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
};
window.closeNotificationDetail = function () {
  const modal = document.getElementById("notification-detail-modal");
  if (modal) {
    modal.classList.add("hidden");
    document.body.style.overflow = "";
  }
  activeNotificationId = null;
};

// ===== DELETE SINGLE NOTIFICATION =====
window.deleteNotification = function (notifId) {
  if (!loggedInUser?.id) {
    window.showAlert("Error", "Please login first.", "error");
    return;
  }
  if (!notifId) return;
  if (pendingDeleteIds.has(notifId)) return;
  window.showConfirmPopup("Delete Notification?", "This notification will be permanently removed.", async () => {
    if (pendingDeleteIds.has(notifId)) return;
    pendingDeleteIds.add(notifId);
    try {
      await deleteDoc(doc(db, "notifications", notifId));
      if (activeNotificationId === notifId) window.closeNotificationDetail();
      window.showAlert("Deleted", "Notification removed.", "success");
    } catch (err) {
      console.error("deleteNotification failed:", err);
      window.showAlert("Error", "Could not delete this notification. Please try again.", "error");
    } finally {
      pendingDeleteIds.delete(notifId);
    }
  });
};

// ===== CLEAR ALL NOTIFICATIONS =====
window.clearAllNotifications = async function () {
  if (!loggedInUser?.id) {
    window.showAlert("Error", "Please login first.", "error");
    return;
  }

  showLoading("Clearing notifications...");
  try {
    const snap = await getDocs(
      query(
        collection(db, "notifications"),
        where("residentId", "==", loggedInUser.id),
      ),
    );

    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.forEach((d) => {
        batch.delete(d.ref);
      });
      await batch.commit();
      console.log("✅ All notifications deleted from Firebase");
    }

    allNotifications = [];
    notificationCount = 0;
    updateNotificationBadge();
    renderNotificationDropdown();
    renderMobileNotificationDropdown();

    hideLoading();
    window.showAlert(
      "Notifications Cleared",
      "All notifications have been permanently removed.",
      "success",
    );
  } catch (e) {
    hideLoading();
    console.error("Error clearing notifications:", e);
    window.showAlert("Error", "Failed to clear notifications.", "error");
  }
};

// ===== PAYMENT PROCESSING =====
// QR and proof upload live in their own popup. The payment data and submission
// functions remain unchanged; this only separates the QR step from method selection.
window.closePaymentQrPopup = function () {
  const popup = document.getElementById("payment-qr-popup");
  if (popup) popup.classList.add("hidden");
};

window.backToPaymentMethods = function () {
  const popup = document.getElementById("payment-qr-popup");
  if (popup) popup.classList.add("hidden");
  const modal = document.getElementById("payment-modal");
  if (modal) modal.classList.remove("hidden");
};

function openPaymentQrPopup() {
  const popup = document.getElementById("payment-qr-popup");
  if (popup) popup.classList.remove("hidden");
}
window.selectPaymentMethod = function (method) {
  selectedPaymentMethod = method;
  const inp = document.getElementById("selected-payment-method");
  if (inp) inp.value = method;

  document
    .querySelectorAll(".payment-method-btn")
    .forEach((b) => b.classList.remove("selected"));
  const btn = document.querySelector(`[data-method="${method}"]`);
  if (btn) btn.classList.add("selected");

  const qr = document.getElementById("qr-code-container");
  const amountSection = document.getElementById("payment-amount-section");
  const screenshotSection = document.getElementById(
    "payment-screenshot-section",
  );

  // Always hide QR code when selecting payment method
  if (qr) {
    qr.classList.add("hidden");
    const placeholder = document.getElementById("qr-code-placeholder");
    if (placeholder) placeholder.innerHTML = "";
  }

  // Hide screenshot section
  if (screenshotSection) screenshotSection.classList.add("hidden");

  // Hide cash password verification section
  const pwdSection = document.getElementById("payment-password-section");
  if (pwdSection) pwdSection.classList.add("hidden");

  // Show the Pay Now button again when user changes payment method
  const payButton = document.getElementById("payment-submit-btn");
  if (payButton) payButton.classList.remove("hidden");
  // Hide the "Confirm Payment" (screenshot) button while choosing a method
  const screenshotBtn = document.getElementById(
    "payment-submit-screenshot-btn",
  );
  if (screenshotBtn) screenshotBtn.classList.add("hidden");
  // Hide the cash "Confirm Cash Payment" button while choosing a method
  const cashBtn = document.getElementById("payment-cash-confirm-btn");
  if (cashBtn) cashBtn.classList.add("hidden");

  // Always hide amount section since amount is already set in donation interface
  if (amountSection) amountSection.classList.add("hidden");

  if (
    method === "gcash" ||
    method === "paymaya" ||
    method === "bank_transfer"
  ) {
    window._isQRPaymentMethod = true;
  } else if (method === "cash") {
    window._isQRPaymentMethod = false;
  }
};

window.setAmount = function (amount) {
  const inp = document.getElementById("donation-amount");
  if (inp) inp.value = amount;
};

window.openPaymentModal = function (
  item,
  purpose,
  donationType = "money",
  amount = 0,
) {
  if (!loggedInUser) {
    window.showAlert("Error", "Please login first.", "error");
    return;
  }
  currentDonationData = {
    item: item || "Donation",
    purpose: purpose || "General",
    donorName: loggedInUser.name || "Anonymous",
    donorId: loggedInUser.id || "",
    donationType: donationType,
    amount: amount,
  };
  const pi = document.getElementById("payment-item");
  if (pi) pi.textContent = currentDonationData.item;
  const pp = document.getElementById("payment-purpose");
  if (pp) pp.textContent = currentDonationData.purpose;

  // Display the amount in the payment summary
  const pa = document.getElementById("payment-amount");
  if (pa) {
    if (amount > 0) {
      pa.textContent = `₱${amount.toLocaleString()}`;
    } else {
      pa.textContent = "Amount not specified";
    }
  }

  const pdn = document.getElementById("payment-donor-name");
  if (pdn) pdn.value = currentDonationData.donorName;

  selectedPaymentMethod = null;
  const spm = document.getElementById("selected-payment-method");
  if (spm) spm.value = "";

  document
    .querySelectorAll(".payment-method-btn")
    .forEach((b) => b.classList.remove("selected"));

  const qr = document.getElementById("qr-code-container");
  if (qr) {
    qr.classList.add("hidden");
    const placeholder = document.getElementById("qr-code-placeholder");
    if (placeholder) placeholder.innerHTML = "";
  }

  // Hide screenshot section
  const screenshotSection = document.getElementById(
    "payment-screenshot-section",
  );
  if (screenshotSection) {
    screenshotSection.classList.add("hidden");
    const fileInput = document.getElementById("payment-screenshot-input");
    if (fileInput) fileInput.value = "";
    const preview = document.getElementById("payment-screenshot-preview");
    if (preview) preview.src = "";
    const container = document.getElementById(
      "payment-screenshot-preview-container",
    );
    if (container) container.classList.add("hidden");
  }
  window._paymentScreenshotFile = null;
  window.closePaymentQrPopup?.();

  // Show the Pay Now button
  const payButton = document.getElementById("payment-submit-btn");
  if (payButton) payButton.classList.remove("hidden");
  // Hide the "Confirm Payment" button while the modal opens
  const screenshotBtn = document.getElementById(
    "payment-submit-screenshot-btn",
  );
  if (screenshotBtn) screenshotBtn.classList.add("hidden");

  // Hide the cash password verification section and its confirm button
  const pwdSection = document.getElementById("payment-password-section");
  if (pwdSection) pwdSection.classList.add("hidden");
  const cashBtn = document.getElementById("payment-cash-confirm-btn");
  if (cashBtn) cashBtn.classList.add("hidden");
  const pwdInput = document.getElementById("payment-password");
  if (pwdInput) pwdInput.value = "";

  // Always hide the amount input section since amount is already set in donation interface
  const amountSection = document.getElementById("payment-amount-section");
  if (amountSection) amountSection.classList.add("hidden");

  // Reset QR payment flag
  window._isQRPaymentMethod = false;

  window.toggleModal("payment-modal");
};

/**
 * Handle payment screenshot upload
 */
window.handlePaymentScreenshotUpload = function (event) {
  const file = event.target.files[0];
  if (!file) return;

  if (
    !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)
  ) {
    window.showAlert(
      "Error",
      "Please upload an image file (JPG, PNG, GIF, WEBP).",
      "error",
    );
    event.target.value = "";
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    window.showAlert("Error", "File size must be less than 5MB.", "error");
    event.target.value = "";
    return;
  }

  window._paymentScreenshotFile = file;

  const reader = new FileReader();
  reader.onload = function (e) {
    const preview = document.getElementById("payment-screenshot-preview");
    const container = document.getElementById(
      "payment-screenshot-preview-container",
    );
    if (preview) preview.src = e.target.result;
    if (container) container.classList.remove("hidden");

    // Show the "Confirm Payment" button only after a screenshot is uploaded
    const screenshotBtn = document.getElementById(
      "payment-submit-screenshot-btn",
    );
    if (screenshotBtn) screenshotBtn.classList.remove("hidden");
  };
  reader.readAsDataURL(file);

  window.showAlert(
    "Screenshot Uploaded!",
    "Your payment screenshot has been uploaded successfully. Click Confirm Payment to submit.",
    "success",
  );
};

/**
 * Remove payment screenshot
 */
window.removePaymentScreenshot = function () {
  window._paymentScreenshotFile = null;
  const fileInput = document.getElementById("payment-screenshot-input");
  if (fileInput) fileInput.value = "";
  const preview = document.getElementById("payment-screenshot-preview");
  if (preview) preview.src = "";
  const container = document.getElementById(
    "payment-screenshot-preview-container",
  );
  if (container) container.classList.add("hidden");

  // Hide the "Confirm Payment" button again since the screenshot was removed
  const screenshotBtn = document.getElementById(
    "payment-submit-screenshot-btn",
  );
  if (screenshotBtn) screenshotBtn.classList.add("hidden");
};

async function saveDonation(pr) {
  try {
    if (!pr || !pr.transactionId) throw new Error("Invalid payment result");
    if (!currentDonationData || !currentDonationData.donorId)
      throw new Error("Donation data missing");
    const dd = {
      donorName: currentDonationData.donorName || "Anonymous",
      donorId: currentDonationData.donorId || "",
      donationType: currentDonationData.donationType || "money",
      item: currentDonationData.item || "Donation",
      purpose: currentDonationData.purpose || "General",
      amount: pr.amount || 0,
      paymentMethod: pr.method || "unknown",
      transactionId: pr.transactionId,
      paymentStatus: pr.status || STATUS.PENDING,
      paymentTimestamp: pr.timestamp || new Date().toISOString(),
      status: pr.status || STATUS.PENDING,
      createdAt: serverTimestamp(),
    };
    if (pr.bankDetails)
      dd.bankDetails = {
        bankName: pr.bankDetails.bankName || "",
        accountNumber: pr.bankDetails.accountNumber || "",
        accountName: pr.bankDetails.accountName || "",
      };
    if (pr.cashDetails)
      dd.cashDetails = {
        officeAddress: pr.cashDetails.officeAddress || "",
        officeHours: pr.cashDetails.officeHours || "",
      };
    if (pr.receiverNumber) dd.receiverNumber = pr.receiverNumber;
    if (pr.receiverName) dd.receiverName = pr.receiverName;
    if (pr.screenshot) dd.paymentScreenshot = pr.screenshot;
    await addDoc(collection(db, "donations"), dd);
  } catch (e) {
    console.error("Save donation error:", e);
    throw new Error("Failed to save donation: " + e.message);
  }
}

/**
 * Process payment (first step: show QR + screenshot section for e-wallet / bank)
 */
window.processPayment = async function () {
  const pm =
    selectedPaymentMethod ||
    document.getElementById("selected-payment-method")?.value;
  const donorName =
    document.getElementById("payment-donor-name")?.value?.trim() || "";

  if (!pm) {
    window.showAlert("Error", "Select a payment method.", "error");
    return;
  }

  const isQRPayment =
    pm === "gcash" || pm === "paymaya" || pm === "bank_transfer";

  if (!donorName) {
    window.showAlert("Error", "Please enter your name.", "error");
    return;
  }

  if (!currentDonationData) {
    window.showAlert("Error", "Donation data missing.", "error");
    return;
  }

  currentDonationData.donorName = donorName;

  if (isQRPayment) {
    // QR payments proceed in a dedicated popup. It contains both the QR code
    // and the proof-of-payment upload, while the selected method/data remain intact.
    const qr = document.getElementById("qr-code-container");
    if (qr) {
      qr.classList.remove("hidden");
      displayQRCode(pm);
    }
    const screenshotSection = document.getElementById("payment-screenshot-section");
    if (screenshotSection) screenshotSection.classList.remove("hidden");
    const screenshotBtn = document.getElementById("payment-submit-screenshot-btn");
    if (screenshotBtn) screenshotBtn.classList.add("hidden");
    openPaymentQrPopup();

    // Update the amount display - use the amount from donation data
    const pa = document.getElementById("payment-amount");
    if (pa) {
      if (currentDonationData.amount > 0) {
        pa.textContent = `₱${currentDonationData.amount.toLocaleString()}`;
      } else {
        pa.textContent = "Amount not specified";
      }
    }
  } else {
    // For cash payment: require account password confirmation before submitting
    const payButton = document.getElementById("payment-submit-btn");
    if (payButton) payButton.classList.add("hidden");

    // Hide the screenshot confirm button (not used for cash)
    const screenshotBtn = document.getElementById(
      "payment-submit-screenshot-btn",
    );
    if (screenshotBtn) screenshotBtn.classList.add("hidden");

    // Show the password verification section
    const pwdSection = document.getElementById("payment-password-section");
    if (pwdSection) {
      pwdSection.classList.remove("hidden");
      pwdSection.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    // Show the "Confirm Cash Payment" button
    const cashBtn = document.getElementById("payment-cash-confirm-btn");
    if (cashBtn) cashBtn.classList.remove("hidden");

    // Update the amount display
    const pa = document.getElementById("payment-amount");
    if (pa) {
      if (currentDonationData.amount > 0) {
        pa.textContent = `₱${currentDonationData.amount.toLocaleString()}`;
      } else {
        pa.textContent = "Amount not specified";
      }
    }

    // Focus the password field
    const pwdInput = document.getElementById("payment-password");
    if (pwdInput) pwdInput.focus();
  }
};

/**
 * Confirm a cash payment after verifying the account password
 */
window.confirmCashPayment = async function () {
  const pm =
    selectedPaymentMethod ||
    document.getElementById("selected-payment-method")?.value;
  const donorName =
    document.getElementById("payment-donor-name")?.value?.trim() || "";
  const passwordInput = document.getElementById("payment-password");
  const password = passwordInput?.value || "";

  if (pm !== "cash") {
    window.showAlert("Error", "Cash payment not selected.", "error");
    return;
  }
  if (!donorName) {
    window.showAlert("Error", "Please enter your name.", "error");
    return;
  }
  if (!password) {
    window.showAlert("Error", "Please enter your account password.", "error");
    return;
  }
  if (!currentDonationData) {
    window.showAlert("Error", "Donation data missing.", "error");
    return;
  }
  if (!auth.currentUser) {
    window.showAlert("Error", "You must be logged in.", "error");
    return;
  }

  showLoading("Verifying password...");
  try {
    // Re-authenticate the user to verify the password
    const credential = EmailAuthProvider.credential(
      auth.currentUser.email,
      password,
    );
    await reauthenticateWithCredential(auth.currentUser, credential);
  } catch (err) {
    hideLoading();
    window.showAlert(
      "Incorrect Password",
      "The password you entered is incorrect. Please try again.",
      "error",
    );
    if (passwordInput) {
      passwordInput.value = "";
      passwordInput.focus();
    }
    return;
  }

  showLoading("Processing payment...");
  try {
    const paymentAmount = currentDonationData.amount || 0;
    const pr = await processCashPayment(paymentAmount);
    await saveDonation(pr);

    window.closePaymentQrPopup();
    window.toggleModal("payment-modal");
    document.getElementById("donation-money-form")?.reset();
    document.getElementById("payment-form")?.reset();
    currentDonationData = null;
    selectedPaymentMethod = null;
    hideLoading();

    let successMsg = `Amount: ₱${paymentAmount.toLocaleString()}\n`;
    successMsg += `Method: ${pm.replace("_", " ").toUpperCase()}\n`;
    successMsg += `Reference: ${pr.transactionId}\n\n`;
    successMsg += "Please complete your payment at the municipal hall.";

    window.showAlert("Donation Initiated!", successMsg, "success");
  } catch (e) {
    hideLoading();
    window.showAlert(
      "Payment Failed",
      e.message || "An error occurred.",
      "error",
    );
  }
};

/**
 * Submit payment with screenshot (final step for e-wallet / bank)
 */
window.submitPaymentWithScreenshot = async function () {
  const pm =
    selectedPaymentMethod ||
    document.getElementById("selected-payment-method")?.value;
  const donorName =
    document.getElementById("payment-donor-name")?.value?.trim() || "";
  const screenshotFile = window._paymentScreenshotFile;

  if (!pm) {
    window.showAlert(
      "Error",
      "Please select a payment method first. It is required.",
      "error",
    );
    return;
  }
  if (!donorName) {
    window.showAlert(
      "Error",
      "Donor name is required. Please enter your name.",
      "error",
    );
    return;
  }
  if (!screenshotFile) {
    window.showAlert(
      "Screenshot Required",
      "Please upload a screenshot of your successful payment. It is required for verification.",
      "error",
    );
    return;
  }
  if (!currentDonationData) {
    window.showAlert("Error", "Donation data missing.", "error");
    return;
  }

  currentDonationData.donorName = donorName;

  showLoading("Submitting payment...");

  try {
    const screenshotBase64 = await convertFileToBase64(screenshotFile);

    const transactionId = `${pm.toUpperCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const paymentAmount = currentDonationData.amount || 0;

    let pr;
    switch (pm) {
      case "gcash":
        pr = await processGCashPayment(paymentAmount);
        break;
      case "paymaya":
        pr = await processPayMayaPayment(paymentAmount);
        break;
      case "bank_transfer":
        pr = await processBankTransfer(paymentAmount);
        break;
      default:
        throw new Error("Invalid payment method");
    }

    pr.transactionId = transactionId;
    pr.status = STATUS.PENDING;
    pr.screenshot = screenshotBase64;

    await saveDonation(pr);

    window.closePaymentQrPopup();
    window.toggleModal("payment-modal");
    document.getElementById("donation-money-form")?.reset();
    document.getElementById("payment-form")?.reset();
    currentDonationData = null;
    selectedPaymentMethod = null;
    window._paymentScreenshotFile = null;

    hideLoading();

    let successMsg = `Method: ${pm.replace("_", " ").toUpperCase()}\n`;
    successMsg += `Reference: ${transactionId}\n\n`;
    if (paymentAmount > 0) {
      successMsg = `Amount: ₱${paymentAmount.toLocaleString()}\n` + successMsg;
    } else {
      successMsg = "Amount: User will input in app\n" + successMsg;
    }
    successMsg +=
      "Your payment has been submitted for verification. Please wait for admin confirmation.";

    window.showAlert("Payment Submitted!", successMsg, "success");
  } catch (e) {
    hideLoading();
    window.showAlert(
      "Payment Failed",
      e.message || "An error occurred.",
      "error",
    );
  }
};

async function processGCashPayment(amount) {
  return {
    transactionId: `GCASH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    method: "gcash",
    amount: amount || 0,
    status: STATUS.PENDING,
    timestamp: new Date().toISOString(),
    receiverNumber: PAYMENT_CONFIG.gcash.number,
    receiverName: PAYMENT_CONFIG.gcash.name,
  };
}

async function processPayMayaPayment(amount) {
  return {
    transactionId: `MAYA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    method: "paymaya",
    amount: amount || 0,
    status: STATUS.PENDING,
    timestamp: new Date().toISOString(),
  };
}

async function processBankTransfer(amount) {
  return {
    transactionId: `BANK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    method: "bank_transfer",
    amount: amount || 0,
    status: STATUS.PENDING,
    bankDetails: PAYMENT_CONFIG.bankTransfer,
    timestamp: new Date().toISOString(),
  };
}

async function processCashPayment(amount) {
  return {
    transactionId: `CASH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    method: "cash",
    amount: amount,
    status: STATUS.PENDING,
    cashDetails: PAYMENT_CONFIG.cashPayment,
    timestamp: new Date().toISOString(),
  };
}

// ===== SESSION MANAGEMENT =====
function generateSessionToken() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
}

async function enforceSingleSession(uid) {
  if (!uid) return true;
  try {
    const userDoc = await getDoc(doc(db, "residents", uid));
    if (!userDoc.exists()) return true;
    const userData = userDoc.data(),
      storedToken = userData.sessionToken;
    if (storedToken && storedToken !== currentSessionToken) {
      const lastActive = userData.lastActive?.toDate
        ? userData.lastActive.toDate()
        : new Date(0);
      if (lastActive > new Date(Date.now() - 5 * 60 * 1000)) {
        window.showAlert(
          "Session Terminated",
          "This account is already logged in on another device.",
          "error",
        );
        await signOut(auth);
        clearUserSession();
        loggedInUser = null;
        window.closeAuthPanels?.();
        document.getElementById("auth-screen")?.classList.remove("hidden");
        document.getElementById("dashboard")?.classList.add("hidden");
        hideNotificationBell();
        try {
          await updateDoc(doc(db, "residents", uid), {
            sessionToken: null,
            isOnline: false,
          });
        } catch (e) { }
        return false;
      }
    }
    currentSessionToken = generateSessionToken();
    await updateDoc(doc(db, "residents", uid), {
      sessionToken: currentSessionToken,
      lastActive: serverTimestamp(),
      isOnline: true,
      lastDeviceCheck: serverTimestamp(),
    });
    return true;
  } catch (error) {
    console.error("Session enforcement error:", error);
    return true;
  }
}

function startSessionHeartbeat(uid) {
  if (sessionCheckInterval) clearInterval(sessionCheckInterval);
  sessionCheckInterval = setInterval(async () => {
    if (!loggedInUser?.id) {
      clearInterval(sessionCheckInterval);
      return;
    }
    try {
      const userDoc = await getDoc(doc(db, "residents", uid));
      // Safety net in case the live watcher was never started or was dropped.
      // A missing document means the admin permanently deleted the account.
      if (!userDoc.exists()) {
        clearInterval(sessionCheckInterval);
        await forceLogoutDisabled({
          accountStatus: "Deleted",
          isDeleted: true,
        });
        return;
      }
      if (isAccountDisabled(userDoc.data())) {
        clearInterval(sessionCheckInterval);
        await forceLogoutDisabled(userDoc.data());
        return;
      }
      if (
        userDoc.data().sessionToken &&
        userDoc.data().sessionToken !== currentSessionToken
      ) {
        clearInterval(sessionCheckInterval);
        window.showAlert(
          "Session Expired",
          "Logged in from another device.",
          "error",
        );
        await signOut(auth);
        clearUserSession();
        loggedInUser = null;
        window.closeAuthPanels?.();
        document.getElementById("auth-screen")?.classList.remove("hidden");
        document.getElementById("dashboard")?.classList.add("hidden");
        hideNotificationBell();
        if (participantsUnsubscribe) participantsUnsubscribe();
        if (notificationsUnsubscribe) notificationsUnsubscribe();
        if (donationsUnsubscribe) donationsUnsubscribe();
        if (volunteersUnsubscribe) volunteersUnsubscribe();
        if (hoursUnsubscribe) hoursUnsubscribe();
        return;
      }
      await updateDoc(doc(db, "residents", uid), {
        lastActive: serverTimestamp(),
      });
    } catch (error) {
      console.error("Heartbeat error:", error);
    }
  }, 30000);
}

function stopSessionHeartbeat() {
  if (sessionCheckInterval) {
    clearInterval(sessionCheckInterval);
    sessionCheckInterval = null;
  }
}

function saveUserSession(ud) {
  try {
    const sd = {
      ...ud,
      createdAt: ud.createdAt?.toDate
        ? ud.createdAt.toDate().toISOString()
        : ud.createdAt,
      lastActive: ud.lastActive?.toDate
        ? ud.lastActive.toDate().toISOString()
        : ud.lastActive,
    };
    // SECURITY: never persist credentials in localStorage
    delete sd.password;
    localStorage.setItem("barangayUser", JSON.stringify(sd));
  } catch (e) { }
}

function clearUserSession() {
  try {
    localStorage.removeItem("barangayUser");
    sessionStorage.removeItem("userActiveTab");
    sessionStorage.removeItem("registeredEvents");
    sessionStorage.removeItem("completedEvents");
    sessionStorage.removeItem("breadcrumbTrail");
    breadcrumbTrail = [];
  } catch (e) { }
}

function saveActiveTab(t) {
  try {
    sessionStorage.setItem("userActiveTab", t);
  } catch (e) { }
}

function getSavedActiveTab() {
  try {
    return sessionStorage.getItem("userActiveTab") || "home";
  } catch (e) {
    return "home";
  }
}

// ===== LOADING MANAGEMENT =====
function showLoading(msg = "Loading...") {
  const l = document.getElementById("global-loading"),
    t = document.getElementById("loading-text");
  if (l) {
    l.classList.remove("hidden");
    l.style.display = "flex";
  }
  if (t) t.textContent = msg;
}

function hideLoading() {
  const l = document.getElementById("global-loading");
  if (l) {
    l.classList.add("hidden");
    l.style.display = "none";
  }
}

// ===== PROFILE PICTURE HANDLING =====
window.triggerProfilePicUpload = function () {
  const fi = document.getElementById("profile-pic-input");
  if (fi) fi.click();
};

window.handleProfilePicChange = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  if (
    !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)
  ) {
    window.showAlert("Error", "Invalid image type.", "error");
    event.target.value = "";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    window.showAlert("Error", "Image must be < 5MB.", "error");
    event.target.value = "";
    return;
  }
  selectedProfilePicFile = file;
  const reader = new FileReader();
  reader.onload = function (e) {
    const ip = document.getElementById("profile-img-preview"),
      ic = document.getElementById("profile-icon-fallback");
    if (ip) {
      ip.src = e.target.result;
      ip.classList.remove("hidden");
      ip.style.opacity = "0.6";
      ip.style.border = "2px solid #F2A900";
    }
    if (ic) ic.classList.add("hidden");
    const pi = document.getElementById("profile-pic-pending");
    if (pi) pi.classList.remove("hidden");
    const ab = document.getElementById("profile-action-btn");
    if (ab && ab.getAttribute("data-mode") === "save") {
      const rb = document.getElementById("remove-profile-pic-btn");
      if (rb) rb.classList.remove("hidden");
    }
  };
  reader.readAsDataURL(file);
  window.showAlert(
    "Picture Selected",
    "Click 'Save Changes' to apply.",
    "success",
  );
};

window.removeProfilePic = function () {
  const ab = document.getElementById("profile-action-btn");
  if (!ab || ab.getAttribute("data-mode") !== "save") return;
  if (
    !(loggedInUser?.profilePic && loggedInUser.profilePic !== "") &&
    !(selectedProfilePicFile instanceof File)
  ) {
    window.showAlert("No Picture", "Nothing to remove.", "error");
    return;
  }
  window.showConfirmPopup("Remove Picture?", "Are you sure?", () => {
    showLoading("Removing...");
    setTimeout(() => {
      selectedProfilePicFile = null;
      const ip = document.getElementById("profile-img-preview"),
        ic = document.getElementById("profile-icon-fallback");
      if (ip) {
        ip.src = "";
        ip.classList.add("hidden");
        ip.style.opacity = "1";
        ip.style.border = "3px solid rgba(10,41,71,0.15)";
      }
      if (ic) ic.classList.remove("hidden");
      const rb = document.getElementById("remove-profile-pic-btn");
      if (rb) rb.classList.add("hidden");
      const pi = document.getElementById("profile-pic-pending");
      if (pi) pi.classList.remove("hidden");
      const fi = document.getElementById("profile-pic-input");
      if (fi) fi.value = "";
      hideLoading();
      window.showAlert(
        "Marked for Removal",
        "Click 'Save Changes' to apply.",
        "success",
      );
    }, 600);
  });
};

async function uploadProfilePicture(uid, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const b64 = e.target.result;
        await updateDoc(doc(db, "residents", uid), { profilePic: b64 });
        resolve(b64);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===== UI UTILITIES =====
function updateUIWithUserData(user) {
  if (!user) return;
  const ssv = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };
  const sst = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || "";
  };
  const ip = document.getElementById("profile-img-preview"),
    ic = document.getElementById("profile-icon-fallback");
  const sp = document.getElementById("sidebar-profile-pic"),
    si = document.getElementById("sidebar-icon-fallback");
  const msp = document.getElementById("mobile-sidebar-profile-pic"),
    msi = document.getElementById("mobile-sidebar-icon-fallback");
  const rb = document.getElementById("remove-profile-pic-btn"),
    pi = document.getElementById("profile-pic-pending");
  if (user.profilePic && user.profilePic !== "") {
    if (ip) {
      ip.src = user.profilePic;
      ip.classList.remove("hidden");
      ip.style.opacity = "1";
      ip.style.border = "3px solid rgba(10,41,71,0.15)";
    }
    if (ic) ic.classList.add("hidden");
    if (sp) {
      sp.src = user.profilePic;
      sp.classList.remove("hidden");
      sp.style.opacity = "1";
    }
    if (si) si.classList.add("hidden");
    if (msp) {
      msp.src = user.profilePic;
      msp.classList.remove("hidden");
      msp.style.opacity = "1";
    }
    if (msi) msi.classList.add("hidden");
  } else {
    if (ip) {
      ip.src = "";
      ip.classList.add("hidden");
      ip.style.opacity = "1";
    }
    if (ic) ic.classList.remove("hidden");
    if (sp) {
      sp.src = "";
      sp.classList.add("hidden");
    }
    if (si) si.classList.remove("hidden");
    if (msp) {
      msp.src = "";
      msp.classList.add("hidden");
    }
    if (msi) msi.classList.remove("hidden");
  }
  if (rb) rb.classList.add("hidden");
  if (pi) pi.classList.add("hidden");
  sst("sidebar-username", user.name || "Resident");
  sst("sidebar-email", user.email || "");
  sst("profile-display-name", user.name || "Resident");
  sst("profile-display-email", user.email || "");
  sst("mobile-username", user.name || "Resident");
  ssv("prof-name", user.name);
  ssv("prof-email", user.email);
  ssv("prof-phone", user.phone);
  ssv("prof-age", user.age);
  ssv("prof-gender", user.gender || "Male");
  ssv("prof-address", user.address);
  ssv("vol-name", user.name);
  ["prof-email", "prof-gender", "prof-name", "prof-age"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = true;
      el.classList.add("bg-gray-100", "cursor-not-allowed");
    }
  });
  const pf = document.getElementById("prof-password");
  if (pf) pf.value = ""; // never prefill the password field
  const fi = document.getElementById("profile-pic-input");
  if (fi) fi.value = "";
  refreshDashboardOverview(false);
}

// ===== DASHBOARD OVERVIEW =====
function setDashboardText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateDashboardClock() {
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeFormatter = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const hour = Number(
    new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );

  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  setDashboardText("dashboard-greeting", greeting);
  setDashboardText("dashboard-current-date", dateFormatter.format(now));
  setDashboardText("dashboard-current-time", `${timeFormatter.format(now)} PHT`);
}

function startDashboardClock() {
  updateDashboardClock();
  if (dashboardClockTimer) clearInterval(dashboardClockTimer);
  dashboardClockTimer = setInterval(updateDashboardClock, 30 * 1000);
}

function parseDashboardEventDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (typeof value === "object" && value.seconds)
    return new Date(value.seconds * 1000);
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === "tba") return null;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDashboardEventDate(value) {
  const parsed = parseDashboardEventDate(value);
  if (!parsed) return value || "Date to be announced";
  return parsed.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renderDashboardAnnouncements() {
  const container = document.getElementById("dashboard-latest-announcements");
  if (!container) return;
  const announcements = sortAnnouncementsByPosted(
    Array.from(announcementsById.values()),
  ).slice(0, 3);

  if (!announcements.length) {
    container.innerHTML = `<div class="p-8 text-center"><div class="w-12 h-12 rounded-md bg-gray-100 text-gray-300 flex items-center justify-center mx-auto"><i class="fa-solid fa-bullhorn"></i></div><p class="text-md font-semibold text-gray-500 mt-3">No community updates yet.</p><p class="text-[10px] text-gray-400 mt-1">New municipal notices will appear here.</p></div>`;
    return;
  }

  container.innerHTML = announcements
    .map((announcement, index) => {
      const priority = announcement.priority || "Notice";
      const priorityStyle =
        priority === "Emergency"
          ? "bg-red-50 text-red-700 border-red-100"
          : priority === "Important"
            ? "bg-amber-50 text-amber-700 border-amber-100"
            : "bg-blue-50 text-tsu-blue border-blue-100";
      const icon =
        priority === "Emergency"
          ? "fa-triangle-exclamation"
          : priority === "Important"
            ? "fa-circle-exclamation"
            : "fa-circle-info";
      const title = escapeAnnouncementHtml(
        announcement.title || "Community announcement",
      );
      const description = escapeAnnouncementHtml(
        announcement.desc || announcement.description || "Open this update to read more.",
      );
      const relativeTime = announcement.createdAt
        ? formatRelativeTime(announcement.createdAt)
        : "Recently";

      return `<button type="button" data-announcement-id="${escapeAnnouncementHtml(announcement.id)}" class="ov-dashboard-item w-full text-justify p-4 sm:px-6 sm:py-5 hover:bg-gray-50/80 transition-colors group" style="animation-delay:${index * 55}ms"><div class="flex items-start gap-3.5"><span class="w-10 h-10 shrink-0 rounded-md border ${priorityStyle} flex items-center justify-center"><i class="fa-solid ${icon}"></i></span><span class="flex-1 min-w-0"><span class="flex items-center justify-between gap-3"><span class="text-sm font-extrabold text-gray-900 truncate group-hover:text-tsu-blue transition-colors">${title}</span><span class="text-[11.5px] font-bold uppercase tracking-wider ${priorityStyle} border rounded-full px-2 py-0.5 shrink-0">${escapeAnnouncementHtml(priority)}</span></span><span class="block text-[13.5px] text-gray-500 mt-1.5 line-clamp-2 leading-relaxed">${description}</span><span class="block text-[10.5px] text-gray-400 mt-2"><i class="fa-regular fa-clock mr-1"></i>${escapeAnnouncementHtml(relativeTime)}</span></span><i class="fa-solid fa-chevron-right text-[10px] text-gray-300 mt-3 group-hover:text-tsu-gold transition-colors"></i></div></button>`;
    })
    .join("");
}

async function renderDashboardAgenda() {
  const container = document.getElementById("dashboard-upcoming-events");
  if (!container || !loggedInUser) return;
  const requestId = ++dashboardAgendaRequest;

  try {
    const snap = await getDocs(collection(db, "events"));
    if (requestId !== dashboardAgendaRequest) return;

    const sortedEvents = sortEvents(snap);
    const allUpcoming = sortedEvents.filter(
      (data) => !getEventDateStatus(data.date, data.time).ended,
    );

    const registered = allUpcoming.filter((eventItem) =>
      registeredEventIds.has(eventItem.id),
    );
    const eventItems = (registered.length
      ? registered
      : allUpcoming.filter((eventItem) => !completedEventIds.has(eventItem.id))
    ).slice(0, 3);
    const isSuggestion = registered.length === 0;

    if (!eventItems.length) {
      container.innerHTML = `<div class="py-7 text-center"><div class="w-12 h-12 rounded-md bg-blue-50 text-tsu-blue/40 flex items-center justify-center mx-auto"><i class="fa-regular fa-calendar"></i></div><p class="text-xs font-semibold text-gray-600 mt-3">Your agenda is clear</p><p class="text-[10px] text-gray-400 mt-1">Browse events and join an activity.</p></div>`;
      return;
    }

    container.innerHTML = eventItems
      .map((eventItem, index) => {
        const date = formatDashboardEventDate(eventItem.date);
        const time = eventItem.time ? formatTimeDisplay(eventItem.time) : "Time TBA";
        const status = isSuggestion ? "Suggested" : "Registered";
        const statusClass = isSuggestion
          ? "bg-amber-50 text-amber-700"
          : "bg-emerald-50 text-emerald-700";
        return `<button type="button" data-dashboard-agenda-index="${index}" class="ov-dashboard-item w-full text-left rounded-md border border-gray-100 bg-gray-50/70 hover:bg-white hover:border-tsu-blue/20 hover:shadow-sm p-3.5 transition-all group" style="animation-delay:${index * 60}ms"><span class="flex items-start gap-3"><span class="w-10 h-10 shrink-0 rounded-md bg-white border border-gray-100 text-tsu-blue flex flex-col items-center justify-center shadow-sm"><i class="fa-solid fa-calendar-day text-xs"></i></span><span class="min-w-0 flex-1"><span class="block text-xs font-extrabold text-gray-900 truncate group-hover:text-tsu-blue">${escapeAnnouncementHtml(eventItem.title || "Community event")}</span><span class="block text-[10px] text-gray-500 mt-1"><i class="fa-regular fa-clock mr-1 text-tsu-gold"></i>${escapeAnnouncementHtml(date)} · ${escapeAnnouncementHtml(time)}</span><span class="inline-flex mt-2 rounded-full px-2 py-0.5 text-[9px] font-bold ${statusClass}">${status}</span></span><i class="fa-solid fa-chevron-right text-[9px] text-gray-300 mt-3"></i></span></button>`;
      })
      .join("");

    container
      .querySelectorAll("[data-dashboard-agenda-index]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const eventItem = eventItems[Number(button.dataset.dashboardAgendaIndex)];
          if (!eventItem) return;
          window.openEventDetails(
            eventItem.title || "Community event",
            eventItem.date || "TBA",
            eventItem.time ? formatTimeDisplay(eventItem.time) : "",
            eventItem.location || "TBA",
            eventItem.desc || eventItem.description || "",
          );
        });
      });
  } catch (error) {
    if (requestId !== dashboardAgendaRequest) return;
    container.innerHTML = `<div class="py-6 text-center text-gray-400"><i class="fa-solid fa-calendar-xmark"></i><p class="text-xs mt-2">Could not load your agenda.</p><button type="button" onclick="refreshDashboardOverview(true)" class="text-[10px] font-bold text-tsu-blue mt-2 hover:underline">Try again</button></div>`;
  }
}

function calculateResidentProfileReadiness(user = {}) {
  const text = (value) => String(value ?? "").trim();
  const phone = text(user.phone).replace(/[\s-]/g, "");
  const age = Number(user.age);
  const hasVerifiedCoordinates =
    user.addressLat !== undefined &&
    user.addressLat !== null &&
    text(user.addressLat) !== "" &&
    user.addressLng !== undefined &&
    user.addressLng !== null &&
    text(user.addressLng) !== "" &&
    Number.isFinite(Number(user.addressLat)) &&
    Number.isFinite(Number(user.addressLng));

  // Every point comes directly from the resident document in Firestore.
  // Weights prioritize the information needed to contact and serve residents.
  const checks = [
    { label: "full name", weight: 15, complete: text(user.name).length >= 2 },
    {
      label: "valid email",
      weight: 15,
      complete: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(user.email)),
    },
    {
      label: "mobile number",
      weight: 15,
      complete: /^(?:09\d{9}|\+?639\d{9})$/.test(phone),
    },
    {
      label: "age",
      weight: 10,
      complete: Number.isFinite(age) && age >= 15 && age <= 120,
    },
    { label: "gender", weight: 10, complete: text(user.gender).length > 0 },
    {
      label: "complete address",
      weight: 20,
      complete: text(user.address).length >= 4,
    },
    {
      label: "verified address",
      weight: 10,
      complete: user.addressVerified === true || hasVerifiedCoordinates,
    },
    {
      label: "profile photo",
      weight: 5,
      complete: text(user.profilePic).length > 0,
    },
  ];

  const percentage = checks.reduce(
    (total, check) => total + (check.complete ? check.weight : 0),
    0,
  );
  return {
    percentage,
    missing: checks.filter((check) => !check.complete).map((check) => check.label),
  };
}

function refreshDashboardOverview(loadAgenda = false) {
  const user = loggedInUser || {};
  const firstName = String(user.name || "Resident").trim().split(/\s+/)[0];
  setDashboardText("dashboard-first-name", firstName || "Resident");
  setDashboardText("dashboard-event-count", registeredEventIds.size);
  setDashboardText(
    "dashboard-hours-count",
    Number.isInteger(dashboardServiceHours)
      ? dashboardServiceHours
      : dashboardServiceHours.toFixed(1),
  );
  setDashboardText("dashboard-unread-count", notificationCount);
  setDashboardText("announcement-unread-count", notificationCount);
  setDashboardText(
    "dashboard-application-count",
    dashboardVolunteerApplications,
  );

  const engagementScore = Math.min(
    100,
    registeredEventIds.size * 12 +
    completedEventIds.size * 20 +
    Math.min(dashboardServiceHours * 2, 40) +
    Math.min(dashboardVolunteerApplications * 8, 16),
  );
  const roundedScore = Math.round(engagementScore);
  setDashboardText("dashboard-engagement-score", `${roundedScore}%`);
  setDashboardText(
    "dashboard-engagement-label",
    roundedScore >= 75
      ? "Community champion"
      : roundedScore >= 40
        ? "Active resident"
        : roundedScore > 0
          ? "Building momentum"
          : "Getting started",
  );
  const ring = document.getElementById("dashboard-progress-ring");
  if (ring) ring.style.setProperty("--progress", `${roundedScore}%`);

  const readiness = calculateResidentProfileReadiness(user);
  const profilePercent = readiness.percentage;
  setDashboardText("dashboard-profile-completion", `${profilePercent}%`);

  let readinessMessage =
    "Your saved resident record is complete and ready for services.";
  if (readiness.missing.length) {
    const visibleMissing = readiness.missing.slice(0, 2).join(" and ");
    const remaining = readiness.missing.length - 2;
    readinessMessage = `Based on your resident record — add ${visibleMissing}${remaining > 0 ? ` and ${remaining} more` : ""}.`;
  }
  setDashboardText("dashboard-profile-message", readinessMessage);

  const profileBar = document.getElementById("dashboard-profile-bar");
  if (profileBar) {
    profileBar.style.width = `${profilePercent}%`;
    profileBar.setAttribute("aria-valuenow", String(profilePercent));
    profileBar.setAttribute("aria-valuetext", `${profilePercent}% profile readiness`);
    profileBar.title = readiness.missing.length
      ? `Missing from resident record: ${readiness.missing.join(", ")}`
      : "Resident record complete";
  }

  updateDashboardClock();
  renderDashboardAnnouncements();
  if (loadAgenda) renderDashboardAgenda();
}

window.refreshDashboardOverview = refreshDashboardOverview;

// ===== MOBILE INPUT RESTRICTIONS =====
function setupPhoneRestrictions() {
  ["reg-phone", "prof-phone"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute("maxlength", "11");
      el.addEventListener("input", (e) => {
        e.target.value = e.target.value.replace(/\D/g, "");
        if (e.target.value.length > 11)
          e.target.value = e.target.value.slice(0, 11);
      });
    }
  });
}

// ===== ALERT SYSTEM =====
window.showAlert = function (title, message, type = "success") {
  const ae = document.getElementById("custom-alert");
  if (!ae) {
    alert(`${title}\n${message}`);
    return;
  }
  clearTimeout(alertTimeout);
  const ib = document.getElementById("alert-icon-box"),
    ic = document.getElementById("alert-icon");
  const titleEl = document.getElementById("alert-title"),
    msgEl = document.getElementById("alert-message");
  if (type === "success") {
    if (ib) ib.className = "p-1.5 rounded-md text-white bg-emerald-500";
    if (ic) ic.className = "fa-solid fa-circle-check text-sm";
  } else if (type === "warning") {
    if (ib) ib.className = "p-1.5 rounded-md text-white bg-amber-500";
    if (ic) ic.className = "fa-solid fa-triangle-exclamation text-sm";
  } else {
    // Every error toast is RED: red icon, red title, red message and a red
    // outline around the toast so a mistake is impossible to miss.
    if (ib) ib.className = "p-1.5 rounded-md text-white bg-red-500";
    if (ic) ic.className = "fa-solid fa-circle-exclamation text-sm";
  }
  if (titleEl) titleEl.style.color = type === "error" ? "#ef4444" : "";
  if (msgEl) msgEl.style.color = type === "error" ? "#ef4444" : "";
  ae.style.outline = type === "error" ? "2px solid rgba(239, 68, 68, 0.65)" : "";
  ae.style.outlineOffset = type === "error" ? "0px" : "";
  document.getElementById("alert-title").innerText = title;
  document.getElementById("alert-message").innerText = message;
  ae.classList.remove("translate-x-96", "opacity-0", "pointer-events-none");
  ae.classList.add("translate-x-0", "opacity-100");
  alertTimeout = setTimeout(() => window.closeCustomAlert(), 4000);
};

window.closeCustomAlert = function () {
  const el = document.getElementById("custom-alert");
  if (el) {
    el.classList.remove("translate-x-0", "opacity-100");
    el.classList.add("translate-x-96", "opacity-0", "pointer-events-none");
  }
};

// ===== RED ERROR HIGHLIGHTING =====
/**
 * ONE place that decides how an invalid field looks. Every validation path in
 * this file (create account, login, profile, password rules, address) funnels
 * through these helpers, so a mistake is ALWAYS shown the same way: a red
 * border + red ring on the textbox and a short red message right under it.
 *
 *   window.markFieldInvalid("reg-email", "Enter a valid email address")
 *   window.markFieldsInvalid(["login-email", "login-password"], "Required")
 *   window.clearFieldInvalid("reg-email")
 *   window.clearAllFieldErrors()
 */
(function () {
  "use strict";

  const STYLE_ID = "ov-field-error-style";

  /** Injected once. `!important` so it also beats Tailwind focus/hover colors. */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".ov-field-invalid, .ov-field-invalid:focus, .ov-field-invalid:hover {" +
      " border-color: #ef4444 !important;" +
      " box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.25) !important;" +
      " }" +
      ".ov-field-error-message, .ov-field-error-message i {" +
      " color: #ef4444 !important;" +
      " }";
    (document.head || document.documentElement).appendChild(style);
  }

  const messageId = (fieldId) => fieldId + "-field-error";

  /**
   * Where the note belongs: directly under the input's own wrapper.
   *
   * We climb ONE kind of level only - a positioned wrapper (`.relative`) that
   * holds this single field and nothing else. That is the box that also holds
   * the little icons (`<span class="absolute inset-y-0 ...">`).
   *
   * Two things follow from it:
   *   - the note lands immediately under the input, never under a sibling
   *     button such as "Forgot Password?" (which lives in the same field
   *     group but OUTSIDE that wrapper), and
   *   - because the note is a sibling placed AFTER the wrapper, the wrapper
   *     keeps its height, so an absolutely positioned icon stays vertically
   *     centred with the text.
   */
  function fieldAnchor(el) {
    const fieldsIn = (node) =>
      node?.querySelectorAll
        ? node.querySelectorAll("input, select, textarea").length
        : 0;
    let node = el;
    let parent = el.parentElement;
    while (parent && !["FORM", "BODY", "HTML"].includes(parent.tagName)) {
      if (fieldsIn(parent) > 1) break; // wraps other fields too
      if (!parent.classList?.contains("relative")) break; // not a positioned wrapper
      node = parent;
      parent = node.parentElement;
    }
    return node;
  }

  /** Back to normal: drop the red state and its message. */
  function clear(fieldId) {
    const el = document.getElementById(fieldId);
    if (el) {
      el.classList.remove("ov-field-invalid");
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    }
    document.getElementById(messageId(fieldId))?.remove();
  }

  /** Paint a field red, optionally with a red message underneath. */
  function mark(fieldId, message) {
    const el = document.getElementById(fieldId);
    if (!el) return null;
    ensureStyle();
    el.classList.add("ov-field-invalid");
    el.setAttribute("aria-invalid", "true");

    if (message) {
      const id = messageId(fieldId);
      let box = document.getElementById(id);
      if (!box) {
        // Inserted AFTER the field's own block (input + its wrapper), which
        // keeps the wrapper the same height so an absolutely positioned icon
        // stays vertically centred with the text, and keeps the note inside
        // the field's own column instead of escaping across the page.
        box = document.createElement("p");
        box.id = id;
        box.className =
          "ov-field-error-message text-[10px] font-semibold text-red-400 mt-1 flex items-start gap-1.5";
        box.innerHTML = '<i class="fa-solid fa-circle-exclamation mt-0.5"></i>';
        box.appendChild(document.createElement("span"));
        fieldAnchor(el).insertAdjacentElement("afterend", box);
      }
      const span = box.querySelector("span");
      if (span) span.textContent = message;
      el.setAttribute("aria-describedby", id);
    }

    // The red state clears itself the moment the resident edits the field.
    if (el.dataset.ovErrClear !== "1") {
      el.dataset.ovErrClear = "1";
      const clearSelf = () => {
        el.removeEventListener("input", clearSelf);
        el.removeEventListener("change", clearSelf);
        delete el.dataset.ovErrClear;
        clear(fieldId);
      };
      el.addEventListener("input", clearSelf);
      el.addEventListener("change", clearSelf);
    }
    return el;
  }

  /**
   * Paint several fields red.
   * @returns {number} how many fields were actually found and marked, so the
   *   caller can fall back to a toast if the fields are not on the page.
   */
  function markMany(fieldIds, message) {
    return (Array.isArray(fieldIds) ? fieldIds : [fieldIds]).filter((id) =>
      mark(id, message),
    ).length;
  }

  /** Wipe every red state inside a root (defaults to the whole page). */
  function clearAll(root) {
    const scope = root || document;
    scope.querySelectorAll(".ov-field-invalid").forEach((el) => {
      el.classList.remove("ov-field-invalid");
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    });
    scope
      .querySelectorAll(".ov-field-error-message")
      .forEach((el) => el.remove());
  }

  /**
 * Scroll to and focus the first field that is currently red. Called after a
 * failed submit so the resident is taken straight to what needs fixing.
 */
  function focusFirstInvalid() {
    const first = document.querySelector(".ov-field-invalid");
    if (!first) return null;
    try {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      first.scrollIntoView?.();
    }
    try {
      first.focus({ preventScroll: true });
    } catch (e) {
      first.focus?.();
    }
    return first;
  }

  window.markFieldInvalid = mark;
  window.focusFirstInvalidField = focusFirstInvalid;
  window.markFieldsInvalid = markMany;
  window.clearFieldInvalid = clear;
  window.clearAllFieldErrors = clearAll;
  window.OVFieldError = {
    mark,
    markMany,
    clear,
    clearAll,
    ensureStyle,
    focusFirstInvalid,
  };
})();
// ===== END RED ERROR HIGHLIGHTING =====

window.showConfirmPopup = function (title, text, cb) {
  document.getElementById("confirm-title").innerText = title;
  document.getElementById("confirm-msg").innerText = text;
  document.getElementById("confirm-modal").classList.remove("hidden");
  pendingConfirmCallback = cb;
};

// ===== FIREBASE USER OPERATIONS =====
async function setUserStatus(uid, status) {
  if (!uid) return;
  try {
    // Guard: an archived or disabled profile must not be written back to
    // "online", and logging out must not erase the admin's session
    // revocation. Verify against the server before touching the document.
    try {
      const guard = await getDocFromServer(doc(db, "residents", uid));
      if (!guard.exists() || isAccountDisabled(guard.data())) {
        currentSessionToken = null;
        return;
      }
    } catch (guardErr) {
      // Cannot verify - do not write anything.
      currentSessionToken = null;
      return;
    }

    if (status) {
      currentSessionToken = generateSessionToken();
      await updateDoc(doc(db, "residents", uid), {
        isOnline: status,
        lastActive: serverTimestamp(),
        sessionToken: currentSessionToken,
        lastDeviceCheck: serverTimestamp(),
      });
    } else {
      currentSessionToken = null;
      await updateDoc(doc(db, "residents", uid), {
        isOnline: status,
        lastActive: serverTimestamp(),
        sessionToken: null,
        lastDeviceCheck: serverTimestamp(),
      });
    }
  } catch (e) {
    console.error("Status update error:", e);
  }
}

async function loadUserRegisteredEvents() {
  if (!loggedInUser?.id) return;
  try {
    const s1 = await getDocs(
      query(
        collection(db, "participants"),
        where("residentId", "==", loggedInUser.id),
        where("status", "==", STATUS.REGISTERED),
      ),
    );
    registeredEventIds.clear();
    s1.forEach((d) => registeredEventIds.add(d.data().eventId));
    sessionStorage.setItem(
      "registeredEvents",
      JSON.stringify([...registeredEventIds]),
    );
    const s2 = await getDocs(
      query(
        collection(db, "participants"),
        where("residentId", "==", loggedInUser.id),
        where("status", "==", STATUS.COMPLETED),
      ),
    );
    completedEventIds.clear();
    s2.forEach((d) => completedEventIds.add(d.data().eventId));
    sessionStorage.setItem(
      "completedEvents",
      JSON.stringify([...completedEventIds]),
    );
    return registeredEventIds;
  } catch (e) {
    return new Set();
  }
}

function setupParticipantsListener() {
  if (!loggedInUser?.id) return;
  if (participantsUnsubscribe) participantsUnsubscribe();
  participantsUnsubscribe = onSnapshot(
    query(
      collection(db, "participants"),
      where("residentId", "==", loggedInUser.id),
    ),
    (snap) => {
      registeredEventIds.clear();
      completedEventIds.clear();
      snap.forEach((d) => {
        const data = d.data();
        if (data.status === STATUS.REGISTERED)
          registeredEventIds.add(data.eventId);
        else if (data.status === STATUS.COMPLETED)
          completedEventIds.add(data.eventId);
      });
      sessionStorage.setItem(
        "registeredEvents",
        JSON.stringify([...registeredEventIds]),
      );
      sessionStorage.setItem(
        "completedEvents",
        JSON.stringify([...completedEventIds]),
      );
      if (typeof renderEvents === "function") renderEvents();
      if (typeof renderMyEvents === "function") renderMyEvents();
      refreshDashboardOverview(true);
    },
  );
}

// ===== REGISTRATION PRIVACY CONSENT =====
window.updateRegisterConsentState = function () {
  const consent = document.getElementById("reg-privacy-consent");
  const consentBox = document.getElementById("reg-privacy-consent-box");
  const message = document.getElementById("reg-privacy-required-message");
  const submitButton = document.getElementById("register-submit-btn");
  const accepted = consent?.checked === true;

  // The Create Account button needs BOTH the consent checkbox and a password
  // that passes the strength policy (ADD-ON MODULE 3).
  if (submitButton) submitButton.disabled = !accepted;
  window.syncRegisterSubmitState?.();
  if (consentBox) {
    consentBox.classList.toggle("border-tsu-gold/60", accepted);
    consentBox.classList.toggle("bg-tsu-gold/10", accepted);
    consentBox.classList.toggle("border-white/15", !accepted);
    consentBox.classList.toggle("bg-white/5", !accepted);
  }
  if (message) {
    // Red while it is still a requirement, green once accepted.
    message.className = `mt-2 pl-6 text-[9px] ${accepted ? "text-emerald-300" : "text-red-400"
      }`;
    message.innerHTML = accepted
      ? '<i class="fa-solid fa-circle-check mr-1"></i>Privacy Policy accepted'
      : '<i class="fa-solid fa-shield-halved mr-1"></i>Required to create an account';
  }
  // Ticking the box clears the red highlight off the consent card.
  if (accepted) window.clearFieldInvalid?.("reg-privacy-consent-box");
};

// ===== AUTH PANELS =====
window.openAuthPanel = function (panel = "login") {
  window.toggleAuthPanels(panel === "register");
};

window.closeAuthPanels = function () {
  const overlay = document.getElementById("auth-form-overlay");
  const loginPanel = document.getElementById("login-panel");
  const registerPanel = document.getElementById("register-panel");
  overlay?.classList.add("hidden");
  loginPanel?.classList.add("hidden");
  registerPanel?.classList.add("hidden");
  document.body.style.overflow = "";
  document.getElementById("login-form")?.reset();
  document.getElementById("register-form")?.reset();
  window.OVAddress?.reset("reg-address");
  window.resetRegisterPasswordUI?.();
  window.clearAllFieldErrors?.();
  window.updateRegisterConsentState();
};

window.toggleAuthPanels = function (showRegister) {
  const overlay = document.getElementById("auth-form-overlay"),
    lp = document.getElementById("login-panel"),
    rp = document.getElementById("register-panel");
  if (overlay && lp && rp) {
    showLoading(showRegister ? "Opening sign up..." : "Opening login...");
    setTimeout(() => {
      lp.classList.toggle("hidden", showRegister);
      rp.classList.toggle("hidden", !showRegister);
      overlay.classList.remove("hidden");
      document.body.style.overflow = "hidden";
      const form = document.getElementById(
        showRegister ? "register-form" : "login-form",
      );
      if (form) form.reset();
      if (showRegister) window.resetRegisterPasswordUI?.();
      if (showRegister) window.updateRegisterConsentState();
      hideLoading();
      document
        .getElementById(showRegister ? "reg-name" : "login-email")
        ?.focus({ preventScroll: true });
    }, 250);
  }
};

// ===== NATIVE VALIDATION OFF =====
/**
 * The forms below are validated by this file: every rule produces a red field
 * with a short note under it (or a toast for account-level problems).
 *
 * The browser's own constraint validation runs FIRST and, when a field is
 * empty or malformed, it shows its own bubble and CANCELS the submit event -
 * so none of our handlers ever ran and the red inline messages never appeared.
 * Switching it off here makes our validation the single source of truth, and
 * it keeps working even if an older index.html (without `novalidate`) is
 * deployed. The `required` / `minlength` attributes stay in the markup for
 * semantics and accessibility.
 */
function disableNativeFormValidation() {
  ["login-form", "register-form", "forgot-password-form"].forEach((id) => {
    const form = document.getElementById(id);
    if (form) form.noValidate = true;
  });
}
window.disableNativeFormValidation = disableNativeFormValidation;

// ===== REGISTRATION =====
document
  .getElementById("register-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("reg-name")?.value.trim() || "",
      email =
        document.getElementById("reg-email")?.value.trim().toLowerCase() || "";
    const phone = document.getElementById("reg-phone")?.value.trim() || "",
      age = document.getElementById("reg-age")?.value.trim() || "";
    const gender = document.getElementById("reg-gender")?.value || "",
      address = document.getElementById("reg-address")?.value.trim() || "";
    const pass = document.getElementById("reg-password")?.value || "",
      confirmPass =
        document.getElementById("reg-confirm-password")?.value || "";
    const privacyConsent =
      document.getElementById("reg-privacy-consent")?.checked === true;
    if (!name || !email || !phone || !age || !gender || !address || !pass) {
      // Inline only: every empty box turns red with "This field is required"
      // right under it. No toast (the red fields ARE the message).
      const missing = [
        ["reg-name", name],
        ["reg-email", email],
        ["reg-phone", phone],
        ["reg-age", age],
        ["reg-gender", gender],
        ["reg-address", address],
        ["reg-password", pass],
      ]
        .filter(([, value]) => !value)
        .map(([id]) => id);
      if (!window.markFieldsInvalid?.(missing, "This field is required")) {
        window.showAlert("Error", "All fields required.", "error");
      }
      window.focusFirstInvalidField?.();
      return;
    }
    if (!privacyConsent) {
      const marked = window.markFieldInvalid?.(
        "reg-privacy-consent-box",
        "You must accept the Privacy Policy to continue",
      );
      if (!marked) {
        window.showAlert(
          "Privacy Policy Required",
          "You must read and agree to the Privacy Policy before creating an account.",
          "error",
        );
      }
      document.getElementById("reg-privacy-consent")?.focus();
      return;
    }
    if (!/^[a-zA-ZñÑ\s.]+$/.test(name)) {
      if (!window.markFieldInvalid?.("reg-name", "Letters and spaces only")) {
        window.showAlert("Error", "Enter a valid name (letters and spaces only).", "error");
      }
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (!window.markFieldInvalid?.("reg-email", "Enter a valid email address")) {
        window.showAlert("Error", "Enter a valid email address.", "error");
      }
      return;
    }
    if (!/^09\d{9}$/.test(phone)) {
      const message = "Must be 11 digits starting with 09";
      if (!window.markFieldInvalid?.("reg-phone", message)) {
        window.showAlert("Error", message, "error");
      }
      return;
    }
    if (pass !== confirmPass) {
      // Both password boxes go red, each with its own note underneath.
      const marked = window.markFieldsInvalid?.(
        ["reg-password", "reg-confirm-password"],
        "Passwords do not match",
      );
      if (!marked) {
        window.showAlert("Error", "Passwords don't match.", "error");
      }
      return;
    }
    // ===== SPECIAL CHARACTER REQUIREMENT (CREATE ACCOUNT) =====
    // The password must include at least one special character so it can never
    // be letters and numbers only (e.g. Juan1234! , maria#2026 , tsu@2026).
    // Kept as a hard gate in the create-account flow so the rule still holds
    // even if the OVPassword strength module is not available.
    if (!/[^A-Za-z0-9\s]/.test(pass)) {
      const message =
        "Add at least one special character (for example ! @ # $ % & * ?)";
      window.OVPassword?.flagInvalidInput("reg-password");
      if (!window.markFieldInvalid?.("reg-password", message)) {
        window.showAlert("Weak Password", message, "error");
      }
      return;
    }
    // ===== STRONG PASSWORD POLICY =====
    // Length + character variety + not your own details + not a common guess.
    const passwordCheck = window.OVPassword?.evaluate(pass, { name, email, phone });
    if (passwordCheck && !passwordCheck.valid) {
      window.OVPassword?.flagInvalidInput("reg-password");
      if (
        !window.markFieldInvalid?.(
          "reg-password",
          passwordCheck.failures.join(" • "),
        )
      ) {
        window.showAlert(
          "Weak Password",
          window.OVPassword.alertText(passwordCheck),
          "error",
        );
      }
      return;
    }
    // ===== LOCATION-BASED ADDRESS VALIDATION =====
    // The address must resolve to a real place. Fake/typo'd entries are
    // auto-corrected to the closest real match, or rejected outright.
    if (window.OVAddress) {
      showLoading("Verifying address...");
      const addressOk = await window.OVAddress.ensureValid("reg-address");
      hideLoading();
      if (!addressOk) {
        const message =
          "Address not found — pick a suggestion from the list or use 'Use my location'";
        if (!window.markFieldInvalid?.("reg-address", message)) {
          window.showAlert("Check the address", message, "error");
        }
        return;
      }
    }
    const verifiedAddress =
      document.getElementById("reg-address")?.value.trim() || address;
    const addressGeo = window.OVAddress?.getCoords("reg-address") || null;
    showLoading("Creating account...");
    try {
      const uc = await createUserWithEmailAndPassword(auth, email, pass);

      // 1. Deliver official verification email via Firebase Auth (relayed through Mailjet SMTP)
      try {
        await sendEmailVerification(uc.user);
      } catch (mailErr) {
        console.error("Verification email dispatch failed via Mailjet SMTP:", mailErr);
        // Rollback Firebase Auth user so the email is not stuck in an unverified 'already in use' state
        try {
          await uc.user.delete();
        } catch (_) {}
        hideLoading();
        window.showAlert(
          "Verification Email Failed",
          `Could not send verification email: ${mailErr.message || mailErr.code}. Please verify your Firebase Console Custom SMTP settings.`,
          "error"
        );
        return;
      }

      // 2. Only store resident profile in Firestore once verification email has been successfully dispatched
      await setDoc(doc(db, "residents", uc.user.uid), {
        name,
        email,
        phone,
        age: parseInt(age) || 0,
        gender,
        address: verifiedAddress,
        addressVerified: !!addressGeo,
        addressLat: addressGeo ? addressGeo.lat : null,
        addressLng: addressGeo ? addressGeo.lng : null,
        addressPlaceId: addressGeo ? addressGeo.placeId : null,
        privacyPolicyAccepted: true,
        privacyPolicyAcceptedAt: serverTimestamp(),
        privacyPolicyVersion: "2026-08-14",
        // SECURITY: never store passwords in Firestore — Firebase Auth owns them.
        isOnline: false,
        profilePic: "",
        sessionToken: null,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        lastProfileUpdate: null,
        lastAgeUpdate: null,
        role: "resident",
      });

      await signOut(auth);
      hideLoading();
      document.getElementById("register-form")?.reset();
      window.OVAddress?.reset("reg-address");
      window.clearAllFieldErrors?.();
      window.showAlert(
        "Verification Sent!",
        `A verification link has been sent to ${email} via Mailjet. Please check your inbox and spam folder before signing in.`,
        "success",
      );
      window.toggleAuthPanels(false);
    } catch (err) {
      hideLoading();
      // Account-level errors that belong to a specific field are shown inline,
      // right under that field. Everything else stays a toast.
      const message =
        err.code === "auth/email-already-in-use"
          ? "This email is already registered. Sign in instead."
          : err.code === "auth/weak-password"
            ? `Password too weak. Use ${window.OVPassword?.summary || "at least 10 characters with uppercase, lowercase, numbers and symbols"}.`
            : `Failed: ${err.message}`;
      const fieldId =
        err.code === "auth/email-already-in-use"
          ? "reg-email"
          : err.code === "auth/weak-password"
            ? "reg-password"
            : null;
      if (!(fieldId && window.markFieldInvalid?.(fieldId, message))) {
        window.showAlert("Error", message, "error");
      }
    }
  });

// ===== LOGIN =====
document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email =
    document.getElementById("login-email")?.value.trim().toLowerCase() || "",
    pass = document.getElementById("login-password")?.value || "";
  if (!email || !pass) {
    const missing = [];
    if (!email) missing.push("login-email");
    if (!pass) missing.push("login-password");
    if (!window.markFieldsInvalid?.(missing, "This field is required")) {
      window.showAlert("Error", "Enter email and password.", "error");
    }
    window.focusFirstInvalidField?.();
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (!window.markFieldInvalid?.("login-email", "Enter a valid email address")) {
      window.showAlert("Error", "Enter a valid email address.", "error");
    }
    return;
  }
  showLoading("Logging in...");
  try {
    const uc = await signInWithEmailAndPassword(auth, email, pass);
    await uc.user.reload();
    if (!uc.user.emailVerified) {
      await signOut(auth);
      hideLoading();
      // Leave the login panel open so the user can see the error and retry
      // after verifying their email. The auth listener must not close it.
      window.showAlert(
        "Email Not Verified",
        "Your email address is not verified yet. Please check your inbox and spam folder, or click 'Resend Verification' below.",
        "error"
      );
      return;
    }
    // ===== DISABLED ACCOUNT CHECK =====
    // Admin can disable a resident from the admin terminal. Block the login
    // here, before any session is established.
    // Read straight from the SERVER. getDoc() can be answered from the local
    // IndexedDB cache, which may still hold the pre-deletion copy of this
    // document and would let an archived account walk right back in.
    let preCheck;
    try {
      preCheck = await getDocFromServer(doc(db, "residents", uc.user.uid));
    } catch (netErr) {
      // Offline or unreachable: fail CLOSED rather than trusting stale cache.
      hideLoading();
      await signOut(auth);
      clearUserSession();
      loggedInUser = null;
      window.showAlert(
        "Connection Required",
        "We could not verify your account status. Please check your internet connection and try again.",
        "error",
      );
      return;
    }
    if (preCheck.exists() && isAccountDisabled(preCheck.data())) {
      const info = preCheck.data();
      const deleted =
        info.isDeleted === true || info.accountStatus === "Deleted";
      hideLoading();
      await signOut(auth);
      clearUserSession();
      loggedInUser = null;
      window.showAlert(
        deleted ? "Account Deleted" : "Account Disabled",
        accountLockMessage(info),
        "error",
      );
      return;
    }

    if (!(await enforceSingleSession(uc.user.uid))) {
      hideLoading();
      return;
    }
    const snap = await getDoc(doc(db, "residents", uc.user.uid));
    if (snap.exists()) {
      loggedInUser = { id: snap.id, ...snap.data() };
      saveUserSession(loggedInUser);
      saveActiveTab("home");
      await setUserStatus(loggedInUser.id, true);
      await loadUserRegisteredEvents();
      setupParticipantsListener();
      initializeAllUserListeners();
      startSessionHeartbeat(loggedInUser.id);
      watchAccountStatus(loggedInUser.id);
      window.closeAuthPanels();
      document.getElementById("auth-screen")?.classList.add("hidden");
      document.getElementById("dashboard")?.classList.remove("hidden");
      showNotificationBell();
      updateUIWithUserData(loggedInUser);
      initUserHourTracker();
      initNotificationsListener();
      // Re-point the weather card at THIS resident's location.
      window.updateWeatherLocation?.(true);
      window.switchTab("home");
      hideLoading();
      window.showAlert("Welcome!", `Hello ${loggedInUser.name}!`, "success");
    } else {
      hideLoading();
      window.showAlert("Error", "Profile not found.", "error");
      await signOut(auth);
    }
  } catch (err) {
    hideLoading();
    // Inline first: the offending box goes red with the reason under it.
    // A toast is only used for things that are not tied to one field.
    const code = err?.code || "";
    if (code === "auth/user-not-found") {
      if (
        !window.markFieldInvalid?.(
          "login-email",
          "No account found with this email address",
        )
      ) {
        window.showAlert(
          "Error",
          "No account exists with this email address.",
          "error",
        );
      }
    } else if (code === "auth/wrong-password") {
      if (
        !window.markFieldInvalid?.(
          "login-password",
          "Incorrect password. Please check and try again",
        )
      ) {
        window.showAlert("Error", "Incorrect password.", "error");
      }
    } else if (code === "auth/invalid-email") {
      if (!window.markFieldInvalid?.("login-email", "Enter a valid email address")) {
        window.showAlert("Error", "Enter a valid email address.", "error");
      }
    } else if (code === "auth/too-many-requests") {
      window.showAlert(
        "Error",
        "Too many failed attempts. Please wait a few minutes and try again.",
        "error",
      );
    } else if (
      !window.markFieldsInvalid?.(
        ["login-email", "login-password"],
        "Incorrect email or password",
      )
    ) {
      window.showAlert("Error", "Incorrect email or password.", "error");
    }
  }
});

// ===== INITIALIZE ALL REAL-TIME LISTENERS =====
function initializeAllUserListeners() {
  if (!loggedInUser?.id) return;
  dashboardVolunteerApplications = 0;
  if (donationsUnsubscribe) donationsUnsubscribe();
  if (volunteersUnsubscribe) volunteersUnsubscribe();
  donationsUnsubscribe = onSnapshot(
    query(collection(db, "donations"), where("donorId", "==", loggedInUser.id)),
    (snap) => {
      const tbody = document.getElementById("user-donations-tbody");
      if (!tbody) return;
      // ADMIN HISTORY DELETION FIX: the whole table is rebuilt from the live
      // snapshot on every change (adds, edits AND deletes), so records the
      // admin removes disappear here immediately — including the last one.
      if (snap.empty) {
        tbody.innerHTML =
          '<tr><td colspan="4" class="text-center py-4 text-xs text-gray-400">No donations yet.</td></tr>';
        return;
      }
      const donations = [];
      snap.forEach((d) => donations.push({ id: d.id, ...d.data() }));
      donations.sort((a, b) => {
        const ta = a.createdAt?.toDate
          ? a.createdAt.toDate()
          : new Date(a.createdAt || 0);
        const tb = b.createdAt?.toDate
          ? b.createdAt.toDate()
          : new Date(b.createdAt || 0);
        return tb - ta;
      });
      let html = "";
      donations.forEach((data) => {
        // REJECTION BUG FIX: use the normalized status so records the admin
        // rejects (any capitalization / wording) render as Rejected instead
        // of being stuck on "Pending".
        const st = effectiveStatus(data);
        let badge =
          st === STATUS.APPROVED
            ? '<span class="text-[10px] py-0.5 font-bold text-emerald-800">Confirmed</span>'
            : st === STATUS.REJECTED
              ? '<span class="text-[10px] py-0.5 font-bold text-red-800">Rejected</span>'
              : '<span class="text-[10px] py-0.5 font-bold text-amber-800">Pending</span>';
        // Format donation display based on type
        let amountDisplay = "";
        if (data.donationType === "money") {
          amountDisplay = data.amount
            ? `₱${parseFloat(data.amount).toLocaleString()}`
            : data.item || "";
        } else {
          amountDisplay = escapeAnnouncementHtml(
            data.itemDescription || data.item || "",
          );
          // CATEGORIZED ITEMS: show category + quantity in donation history
          const details = formatItemDonationDetails(data);
          if (details) {
            amountDisplay += `<span class="block text-[10px] text-tsu-blue font-semibold mt-0.5"><i class="fa-solid fa-tags mr-1"></i>${escapeAnnouncementHtml(details)}</span>`;
          }
          if (data.itemValue && data.itemValue > 0) {
            amountDisplay += `<span class="block text-[10px] text-gray-400 mt-0.5">₱${parseFloat(data.itemValue).toLocaleString()} est. value</span>`;
          }
        }
        html += `<tr class="border-b"><td class="px-3 py-2 text-xs">${data.donationType === "item" ? "Item " : "Php "}${amountDisplay}</td><td class="px-3 py-2 text-xs">${data.purpose || ""}</td><td class="px-3 py-2">${badge}</td><td class="px-3 py-2 text-xs text-gray-400">${data.createdAt ? formatShortDate(data.createdAt) : "N/A"}</td></tr>`;
      });
      tbody.innerHTML = html;
    },
    (err) => {
      // Listener errors (e.g. permissions changing while the admin cleans up
      // history) previously killed the stream silently; surface a fallback.
      console.error("Donations listener error:", err);
      const tbody = document.getElementById("user-donations-tbody");
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="4" class="text-center py-4 text-xs text-gray-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Could not load donation history. Check your connection and refresh.</td></tr>';
    },
  );
  volunteersUnsubscribe = onSnapshot(
    query(
      collection(db, "volunteers"),
      where("residentId", "==", loggedInUser.id),
    ),
    (snap) => {
      dashboardVolunteerApplications = snap.size;
      refreshDashboardOverview(false);
      const tbody = document.getElementById("user-volunteers-tbody");
      if (!tbody) return;
      if (snap.empty) {
        tbody.innerHTML =
          '<tr><td colspan="5" class="text-center py-8 text-xs text-gray-400"><i class="fa-solid fa-hands-holding text-2xl text-gray-300 block mb-2"></i>No volunteer applications yet. Your submissions will appear here.</td></tr>';
        return;
      }
      const volunteers = [];
      snap.forEach((d) => volunteers.push({ id: d.id, ...d.data() }));
      volunteers.sort((a, b) => {
        const ta = a.createdAt?.toDate
          ? a.createdAt.toDate()
          : new Date(a.createdAt || 0);
        const tb = b.createdAt?.toDate
          ? b.createdAt.toDate()
          : new Date(b.createdAt || 0);
        return tb - ta;
      });
      let html = "";
      volunteers.forEach((data) => {
        // REJECTION BUG FIX: normalized status comparison.
        const st = effectiveStatus(data);
        let badge =
          st === STATUS.APPROVED
            ? '<span class="inline-flex items-center gap-1 text-[10px] rounded-full px-2.5 py-1 font-bold bg-emerald-100 text-emerald-800"><i class="fa-solid fa-circle-check"></i>Approved</span>'
            : st === STATUS.REJECTED
              ? '<span class="inline-flex items-center gap-1 text-[10px] rounded-full px-2.5 py-1 font-bold bg-red-100 text-red-800"><i class="fa-solid fa-circle-xmark"></i>Rejected</span>'
              : '<span class="inline-flex items-center gap-1 text-[10px] rounded-full px-2.5 py-1 font-bold bg-amber-100 text-amber-800"><i class="fa-solid fa-hourglass-half"></i>Pending Review</span>';
        const skillName = escapeAnnouncementHtml(data.skills || "—");
        const experienceText = data.experience
          ? `<span class="block text-[10px] text-gray-400 mt-0.5">${escapeAnnouncementHtml(data.experience)}</span>`
          : "";
        const notesText = data.notes
          ? `<span class="block text-[10px] text-gray-400 mt-0.5 italic" title="${escapeAnnouncementHtml(data.notes)}">"${escapeAnnouncementHtml(data.notes.length > 40 ? data.notes.slice(0, 37) + "..." : data.notes)}"</span>`
          : "";
        const fileName = escapeAnnouncementHtml(
          data.verificationFile?.fileName || "Document",
        );
        const fileCell =
          data.verificationFile && data.verificationFile.data
            ? `<button type="button" onclick="viewMyVolunteerFile('${data.id}')" class="inline-flex items-center gap-1.5 text-xs text-tsu-blue hover:text-tsu-accent font-semibold hover:underline" title="View / download your submitted file"><i class="fa-solid fa-file-shield"></i><span class="truncate max-w-[120px]">${fileName}</span></button>`
            : '<span class="text-xs text-gray-400">No file</span>';
        const dateApplied = data.createdAt
          ? formatShortDate(data.createdAt)
          : "N/A";
        html += `<tr class="border-b hover:bg-gray-50/70 transition-colors"><td class="px-3 py-3 text-xs font-semibold text-gray-800">${skillName}${experienceText}${notesText}</td><td class="px-3 py-3 text-xs text-gray-600">${escapeAnnouncementHtml(data.availability || "—")}</td><td class="px-3 py-3">${fileCell}</td><td class="px-3 py-3 text-xs text-gray-400 whitespace-nowrap">${dateApplied}</td><td class="px-3 py-3">${badge}</td></tr>`;
      });
      tbody.innerHTML = html;
    },
    (err) => {
      console.error("Volunteers listener error:", err);
      const tbody = document.getElementById("user-volunteers-tbody");
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="5" class="text-center py-6 text-xs text-gray-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Could not load volunteer history. Check your connection and refresh.</td></tr>';
    },
  );
}

// ===== RESIDENT: VIEW / DOWNLOAD OWN VOLUNTEER PROOF FILE =====
function downloadStoredBase64File(dataUrl, fileName) {
  try {
    const parts = String(dataUrl).split(",");
    const mime =
      (parts[0].match(/data:(.*?);/) || [])[1] || "application/octet-stream";
    const byteString = atob(parts[1] || "");
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++)
      bytes[i] = byteString.charCodeAt(i);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  } catch (e) {
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

window.viewMyVolunteerFile = async function (id) {
  if (!loggedInUser?.id || !id) return;
  showLoading("Loading file...");
  try {
    const snap = await getDoc(doc(db, "volunteers", id));
    if (
      !snap.exists() ||
      snap.data().residentId !== loggedInUser.id ||
      !snap.data().verificationFile?.data
    ) {
      hideLoading();
      window.showAlert(
        "No File",
        "No proof file is attached to this application.",
        "error",
      );
      return;
    }
    const file = snap.data().verificationFile;
    const dataUrl = file.data;
    const fileName = file.fileName || "verification-file";
    const fileType = file.fileType || "application/octet-stream";
    const ext = fileName.split(".").pop().toLowerCase();
    const isImage =
      fileType.startsWith("image/") ||
      ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext);
    const isPdf = fileType === "application/pdf" || ext === "pdf";

    document.getElementById("my-volunteer-file-modal")?.remove();
    const modal = document.createElement("div");
    modal.id = "my-volunteer-file-modal";
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[180]";
    modal.onclick = function (e) {
      if (e.target === this) this.remove();
    };
    const safeName = escapeAnnouncementHtml(fileName);
    const previewHtml = isImage
      ? `<img src="${dataUrl}" alt="${safeName}" class="max-w-full max-h-[60vh] object-contain rounded-md shadow-md mx-auto">`
      : isPdf
        ? `<embed src="${dataUrl}" type="application/pdf" class="w-full h-[60vh] bg-white rounded-md">`
        : `<div class="text-center py-10 text-gray-500"><i class="fa-solid fa-file-arrow-down text-4xl text-tsu-blue mb-3"></i><p class="text-sm font-semibold">Preview not available for this file type.</p><p class="text-xs text-gray-400 mt-1">Download the file to open it.</p></div>`;
    modal.innerHTML = `<div class="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden shadow-2xl border modal-enter flex flex-col"><div class="p-4 border-b flex items-center justify-between shrink-0"><div class="min-w-0 pr-3"><h3 class="text-sm font-extrabold text-tsu-blue flex items-center gap-2"><i class="fa-solid fa-file-shield"></i>Your Submitted Proof</h3><p class="text-xs text-gray-400 truncate mt-0.5">${safeName}</p></div><button type="button" onclick="document.getElementById('my-volunteer-file-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-md transition-all shrink-0"><i class="fa-solid fa-xmark text-lg"></i></button></div><div class="flex-1 bg-gray-100 p-4 overflow-auto" style="min-height:0">${previewHtml}</div><div class="p-4 border-t bg-white shrink-0 flex items-center justify-center gap-3"><button type="button" id="my-volunteer-file-download" class="flex items-center justify-center gap-2 bg-tsu-blue text-white font-semibold py-2.5 px-6 rounded-md text-sm hover:bg-tsu-accent transition-colors"><i class="fa-solid fa-download"></i> Download File</button><button type="button" onclick="document.getElementById('my-volunteer-file-modal').remove()" class="bg-gray-100 text-gray-700 font-semibold py-2.5 px-6 rounded-md text-sm hover:bg-gray-200 transition-colors">Close</button></div></div>`;
    document.body.appendChild(modal);
    modal
      .querySelector("#my-volunteer-file-download")
      .addEventListener("click", () =>
        downloadStoredBase64File(dataUrl, fileName),
      );
    hideLoading();
  } catch (e) {
    hideLoading();
    window.showAlert("Error", "Failed to load the file.", "error");
  }
};
window.downloadMyVolunteerFile = function (id) {
  window.viewMyVolunteerFile(id);
};

// ===== NOTIFICATION SYSTEM =====
function showNotificationBell() {
  const bell = document.getElementById("notification-bell-container");
  if (bell) bell.style.display = "block";
}

function hideNotificationBell() {
  const bell = document.getElementById("notification-bell-container");
  if (bell) bell.style.display = "none";
}

function initNotificationsListener() {
  if (!loggedInUser?.id) return;
  if (notificationsUnsubscribe) notificationsUnsubscribe();
  notificationsUnsubscribe = onSnapshot(
    query(
      collection(db, "notifications"),
      where("residentId", "==", loggedInUser.id),
    ),
    (snap) => {
      notificationCount = 0;
      allNotifications = [];
      snap.forEach((d) => {
        const notif = { id: d.id, ...d.data() };
        allNotifications.push(notif);
        if (!notif.read) notificationCount++;
      });
      allNotifications.sort((a, b) => {
        const ta = a.createdAt?.toDate
          ? a.createdAt.toDate()
          : new Date(a.createdAt || 0);
        const tb = b.createdAt?.toDate
          ? b.createdAt.toDate()
          : new Date(b.createdAt || 0);
        return tb - ta;
      });
      updateNotificationBadge();
      renderNotificationDropdown();
      renderMobileNotificationDropdown();
      refreshDashboardOverview(false);
    },
    (err) => {
      // Keep the notifications stream from dying silently (e.g. while the
      // admin bulk-deletes history/notification records).
      console.error("Notifications listener error:", err);
    },
  );
}

function updateNotificationBadge() {
  const badge = document.getElementById("notification-count-badge"),
    mBadge = document.getElementById("mobile-notification-count-badge");
  if (badge) {
    if (notificationCount > 0) {
      badge.textContent = notificationCount > 99 ? "99+" : notificationCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
  if (mBadge) {
    if (notificationCount > 0) {
      mBadge.textContent = notificationCount > 99 ? "99+" : notificationCount;
      mBadge.classList.remove("hidden");
    } else {
      mBadge.classList.add("hidden");
    }
  }
}

function renderNotificationDropdown() {
  const container = document.getElementById("notification-dropdown-list"),
    unreadSpan = document.getElementById("dropdown-unread-count");
  const toggleBtn = document.getElementById("notification-toggle-more-btn"),
    dropdown = document.getElementById("notification-dropdown");
  if (!container) return;
  if (unreadSpan) {
    if (notificationCount > 0) {
      unreadSpan.textContent = `${notificationCount} new`;
      unreadSpan.classList.remove("hidden");
    } else {
      unreadSpan.classList.add("hidden");
    }
  }
  if (allNotifications.length === 0) {
    container.innerHTML = `<div class="text-center py-10"><div class="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3"><i class="fa-solid fa-bell-slash text-xl text-gray-300"></i></div><p class="text-sm text-gray-400 font-medium">No notifications yet</p></div>`;
    if (toggleBtn) toggleBtn.classList.add("hidden");
    return;
  }
  if (toggleBtn) toggleBtn.classList.remove("hidden");
  const toShow = showingAllNotifications
    ? allNotifications
    : allNotifications.slice(0, 5);
  const hasMore = allNotifications.length > 5;
  if (toggleBtn) {
    if (showingAllNotifications)
      toggleBtn.innerHTML =
        '<i class="fa-solid fa-chevron-up mr-1"></i> Show Less';
    else if (hasMore)
      toggleBtn.innerHTML = `<i class="fa-solid fa-chevron-down mr-1"></i> See All (${allNotifications.length})`;
    else toggleBtn.classList.add("hidden");
  }
  if (dropdown) {
    dropdown.style.maxHeight = showingAllNotifications ? "85vh" : "60vh";
    container.style.maxHeight = showingAllNotifications ? "75vh" : "50vh";
  }
  let html = "";
  toShow.forEach((notif) => {
    let iconBg = "bg-blue-50 text-blue-600",
      icon = "fa-bell";
    switch (notif.type) {
      case "volunteer_approved":
        iconBg = "bg-emerald-50 text-emerald-600";
        icon = "fa-circle-check";
        break;
      case "volunteer_rejected":
        iconBg = "bg-red-50 text-red-600";
        icon = "fa-circle-xmark";
        break;
      case "donation_confirmed":
        iconBg = "bg-emerald-50 text-emerald-600";
        icon = "fa-circle-check";
        break;
      case "donation_rejected":
        iconBg = "bg-red-50 text-red-600";
        icon = "fa-circle-xmark";
        break;
      case "hours_credited":
        iconBg = "bg-purple-50 text-purple-600";
        icon = "fa-clock";
        break;
      case "contact_status_update":
      case "feedback_status":
        iconBg = "bg-indigo-50 text-indigo-600";
        icon = "fa-envelope-circle-check";
        break;
    }
    const isUnread = !notif.read,
      timeDisplay = notif.createdAt
        ? formatRelativeTime(notif.createdAt)
        : "Just now";
    const safeTitle = escapeAnnouncementHtml(notif.title || "Notification");
    const safeMessage = escapeAnnouncementHtml(notif.message || "");
    html += `<div onclick="window.handleNotificationClick('${notif.id}','${notif.type || "default"}')" class="p-4 hover:bg-gray-100 cursor-pointer transition-all duration-200 ${isUnread ? "bg-blue-50/30 hover:bg-blue-50/50" : "hover:bg-gray-50"} border-b border-gray-100 last:border-b-0 group"><div class="flex items-start space-x-3"><div class="w-10 h-10 ${iconBg} rounded-full flex items-center justify-center shrink-0 shadow-sm group-hover:scale-110 transition-transform"><i class="fa-solid ${icon} text-sm"></i></div><div class="flex-1 min-w-0"><div class="flex items-center justify-between gap-2"><p class="text-sm font-semibold text-gray-800 truncate group-hover:text-tsu-blue transition-colors">${safeTitle}</p>${isUnread ? '<div class="w-2.5 h-2.5 bg-blue-500 rounded-full shrink-0 animate-pulse"></div>' : ""}</div><p class="text-xs text-gray-600 mt-1 line-clamp-2 leading-relaxed">${safeMessage}</p><div class="flex items-center justify-between mt-2"><p class="text-[10px] text-gray-400 flex items-center"><i class="fa-solid fa-clock mr-1"></i>${timeDisplay}</p><span class="text-[10px] text-tsu-blue font-medium opacity-0 group-hover:opacity-100 transition-opacity flex items-center">Tap to view <i class="fa-solid fa-arrow-right ml-0.5 text-[9px]"></i></span></div></div><button type="button" onclick="event.stopPropagation(); event.preventDefault(); window.deleteNotification('${notif.id}')" class="self-center ml-2 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100 shrink-0" aria-label="Delete notification" title="Delete notification"><i class="fa-solid fa-trash-can text-xs"></i></button></div></div>`;
  });
  container.innerHTML = html;
}

window.toggleMoreNotifications = function () {
  showingAllNotifications = !showingAllNotifications;
  renderNotificationDropdown();
};

window.toggleNotificationDropdown = function () {
  const dropdown = document.getElementById("notification-dropdown"),
    bellBtn = document.getElementById("notification-bell-btn");
  if (!dropdown || !bellBtn) return;
  if (dropdown.classList.contains("hidden")) {
    const rect = bellBtn.getBoundingClientRect(),
      dw = 320,
      vw = window.innerWidth;
    let lp = rect.right + 15;
    if (lp + dw > vw) lp = vw - dw - 10;
    dropdown.style.cssText = `position:fixed;top:${rect.bottom + 8}px;left:${lp}px;right:auto;bottom:auto;transform:none;width:${dw}px`;
    showingAllNotifications = false;
    renderNotificationDropdown();
    dropdown.classList.remove("hidden");
    setTimeout(
      () => document.addEventListener("click", closeNotificationOnClickOutside),
      100,
    );
  } else {
    closeNotificationDropdown();
  }
};

function closeNotificationDropdown() {
  const d = document.getElementById("notification-dropdown");
  if (d) {
    d.classList.add("hidden");
    showingAllNotifications = false;
  }
  document.removeEventListener("click", closeNotificationOnClickOutside);
}

function closeNotificationOnClickOutside(e) {
  const d = document.getElementById("notification-dropdown"),
    b = document.getElementById("notification-bell-btn");
  if (
    d &&
    !d.classList.contains("hidden") &&
    !d.contains(e.target) &&
    b &&
    !b.contains(e.target)
  )
    closeNotificationDropdown();
}

window.handleNotificationClick = async function (notifId, type) {
  const notif = allNotifications.find((n) => n.id === notifId);
  if (notif) {
    window.openNotificationDetail(
      notifId,
      type || "default",
      notif.title || "Notification",
      notif.message || "",
      notif.createdAt ? formatRelativeTime(notif.createdAt) : "Just now",
    );
  }
  await window.markNotificationAsRead(notifId);
  closeNotificationDropdown();
  closeMobileNotificationDropdown();
};

window.markNotificationAsRead = async function (notifId) {
  try {
    await updateDoc(doc(db, "notifications", notifId), { read: true });
  } catch (e) { }
};

window.markAllNotificationsAsRead = async function () {
  if (!loggedInUser?.id) return;
  showLoading();
  try {
    const snap = await getDocs(
      query(
        collection(db, "notifications"),
        where("residentId", "==", loggedInUser.id),
        where("read", "==", false),
      ),
    );
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.forEach((d) => batch.update(d.ref, { read: true }));
      await batch.commit();
    }
    hideLoading();
    window.showAlert("Success", "All notifications marked as read.", "success");
  } catch (e) {
    hideLoading();
  }
};

// ===== MOBILE NOTIFICATION FUNCTIONS =====
window.toggleMobileNotificationDropdown = function () {
  const dropdown = document.getElementById("mobile-notification-dropdown"),
    bellBtn = document.getElementById("mobile-notification-bell-btn");
  if (!dropdown || !bellBtn) return;
  const dd = document.getElementById("notification-dropdown");
  if (dd && !dd.classList.contains("hidden")) {
    dd.classList.add("hidden");
    showingAllNotifications = false;
  }
  if (dropdown.classList.contains("hidden")) {
    mobileShowingAllNotifications = false;
    renderMobileNotificationDropdown();
    dropdown.classList.remove("hidden");
    setTimeout(
      () =>
        document.addEventListener(
          "click",
          closeMobileNotificationOnClickOutside,
        ),
      100,
    );
  } else {
    closeMobileNotificationDropdown();
  }
};

function closeMobileNotificationDropdown() {
  const d = document.getElementById("mobile-notification-dropdown");
  if (d) {
    d.classList.add("hidden");
    mobileShowingAllNotifications = false;
  }
  document.removeEventListener("click", closeMobileNotificationOnClickOutside);
}

function closeMobileNotificationOnClickOutside(e) {
  const d = document.getElementById("mobile-notification-dropdown"),
    b = document.getElementById("mobile-notification-bell-btn");
  if (
    d &&
    !d.classList.contains("hidden") &&
    !d.contains(e.target) &&
    b &&
    !b.contains(e.target)
  )
    closeMobileNotificationDropdown();
}

function renderMobileNotificationDropdown() {
  const container = document.getElementById(
    "mobile-notification-dropdown-list",
  ),
    unreadSpan = document.getElementById("mobile-dropdown-unread-count"),
    toggleBtn = document.getElementById("mobile-notification-toggle-more-btn"),
    dropdown = document.getElementById("mobile-notification-dropdown");
  if (!container) return;
  if (unreadSpan) {
    if (notificationCount > 0) {
      unreadSpan.textContent = `${notificationCount} new`;
      unreadSpan.classList.remove("hidden");
    } else {
      unreadSpan.classList.add("hidden");
    }
  }
  if (allNotifications.length === 0) {
    container.innerHTML = `<div class="text-center py-10"><div class="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3"><i class="fa-solid fa-bell-slash text-xl text-gray-300"></i></div><p class="text-sm text-gray-400 font-medium">No notifications yet</p></div>`;
    if (toggleBtn) toggleBtn.classList.add("hidden");
    return;
  }
  if (toggleBtn) toggleBtn.classList.remove("hidden");
  const toShow = mobileShowingAllNotifications
    ? allNotifications
    : allNotifications.slice(0, 5);
  const hasMore = allNotifications.length > 5;
  if (toggleBtn) {
    if (mobileShowingAllNotifications)
      toggleBtn.innerHTML =
        '<i class="fa-solid fa-chevron-up mr-1"></i> Show Less';
    else if (hasMore)
      toggleBtn.innerHTML = `<i class="fa-solid fa-chevron-down mr-1"></i> See All (${allNotifications.length})`;
    else toggleBtn.classList.add("hidden");
  }
  if (dropdown) {
    dropdown.style.maxHeight = mobileShowingAllNotifications ? "85vh" : "60vh";
    container.style.maxHeight = mobileShowingAllNotifications ? "75vh" : "50vh";
  }
  let html = "";
  toShow.forEach((notif) => {
    let iconBg = "bg-blue-50 text-blue-600",
      icon = "fa-bell";
    switch (notif.type) {
      case "volunteer_approved":
        iconBg = "bg-emerald-50 text-emerald-600";
        icon = "fa-circle-check";
        break;
      case "volunteer_rejected":
        iconBg = "bg-red-50 text-red-600";
        icon = "fa-circle-xmark";
        break;
      case "donation_confirmed":
        iconBg = "bg-emerald-50 text-emerald-600";
        icon = "fa-circle-check";
        break;
      case "donation_rejected":
        iconBg = "bg-red-50 text-red-600";
        icon = "fa-circle-xmark";
        break;
      case "hours_credited":
        iconBg = "bg-purple-50 text-purple-600";
        icon = "fa-clock";
        break;
      case "contact_status_update":
      case "feedback_status":
        iconBg = "bg-indigo-50 text-indigo-600";
        icon = "fa-envelope-circle-check";
        break;
    }
    const isUnread = !notif.read,
      timeDisplay = notif.createdAt
        ? formatRelativeTime(notif.createdAt)
        : "Just now";
    const safeTitle = escapeAnnouncementHtml(notif.title || "Notification");
    const safeMessage = escapeAnnouncementHtml(notif.message || "");
    html += `<div onclick="window.handleNotificationClick('${notif.id}','${notif.type || "default"}'); closeMobileNotificationDropdown();" class="p-4 hover:bg-gray-100 cursor-pointer transition-all duration-200 ${isUnread ? "bg-blue-50/30" : "hover:bg-gray-50"} border-b border-gray-100"><div class="flex items-start space-x-3"><div class="w-9 h-9 ${iconBg} rounded-full flex items-center justify-center shrink-0 shadow-sm"><i class="fa-solid ${icon} text-xs"></i></div><div class="flex-1 min-w-0"><div class="flex items-center justify-between gap-2"><p class="text-xs font-semibold text-gray-800 truncate">${safeTitle}</p>${isUnread ? '<div class="w-2 h-2 bg-blue-500 rounded-full shrink-0"></div>' : ""}</div><p class="text-[11px] text-gray-600 mt-0.5 line-clamp-2">${safeMessage}</p><p class="text-[9px] text-gray-400 mt-1.5"><i class="fa-solid fa-clock mr-1"></i>${timeDisplay}</p></div><button type="button" onclick="event.stopPropagation(); event.preventDefault(); window.deleteNotification('${notif.id}')" class="self-center ml-1 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors shrink-0" aria-label="Delete notification" title="Delete notification"><i class="fa-solid fa-trash-can text-xs"></i></button></div></div>`;
  });
  container.innerHTML = html;
}

window.toggleMoreMobileNotifications = function () {
  mobileShowingAllNotifications = !mobileShowingAllNotifications;
  renderMobileNotificationDropdown();
};

// ===== PROFILE FIELDS =====
function disableAllProfileFields() {
  [
    "prof-name",
    "prof-phone",
    "prof-address",
    "prof-password",
    "prof-age",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = true;
      el.classList.add("bg-gray-100", "cursor-not-allowed", "opacity-60");
    }
  });
  ["prof-gender"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = true;
      el.classList.add("bg-gray-100", "cursor-not-allowed");
    }
  });
  const ut = document.getElementById("upload-trigger");
  if (ut) {
    ut.style.pointerEvents = "none";
    ut.style.opacity = "0.6";
    ut.classList.add("cursor-not-allowed");
  }
  const ip = document.getElementById("profile-img-preview");
  if (ip) {
    ip.style.opacity = "1";
    ip.style.border = "3px solid rgba(10,41,71,0.15)";
  }
  document.getElementById("remove-profile-pic-btn")?.classList.add("hidden");
  document.getElementById("profile-pic-pending")?.classList.add("hidden");
  const tb = document.getElementById("toggle-prof-password");
  if (tb) {
    tb.disabled = true;
    tb.classList.add("opacity-60", "cursor-not-allowed");
    tb.setAttribute("aria-pressed", "false");
    tb.setAttribute("aria-label", "Show password");
  }
  const ic = document.getElementById("prof-password-icon");
  if (ic) {
    ic.classList.remove("fa-eye-slash");
    ic.classList.add("fa-eye");
  }
  const fi = document.getElementById("profile-pic-input");
  if (fi) fi.disabled = true;
  updateEditButtonText();
}

function updateEditButtonText() {
  const ab = document.getElementById("profile-action-btn");
  if (!ab || !loggedInUser) return;
  ab.innerHTML =
    '<i class="fa-solid fa-pen-to-square text-[10px] mr-1"></i><span class="text-[10px]">Edit Profile</span>';
  ab.classList.remove("btn-primary", "opacity-60", "cursor-not-allowed");
  ab.classList.add("btn-secondary");
  ab.setAttribute("data-mode", "edit");
  ab.setAttribute("onclick", "toggleEditMode()");
  ab.disabled = false;
}

function enableAllProfileFields() {
  ["prof-phone", "prof-address", "prof-password"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = false;
      el.classList.remove("bg-gray-100", "cursor-not-allowed", "opacity-60");
    }
  });
  const ut = document.getElementById("upload-trigger");
  if (ut) {
    ut.style.pointerEvents = "auto";
    ut.style.opacity = "1";
    ut.classList.remove("cursor-not-allowed");
  }
  const ip = document.getElementById("profile-img-preview");
  if (ip) ip.style.opacity = "1";
  const hasPic = loggedInUser?.profilePic && loggedInUser.profilePic !== "",
    hasPend = selectedProfilePicFile instanceof File;
  const rb = document.getElementById("remove-profile-pic-btn");
  if (rb && (hasPic || hasPend || (ip && !ip.classList.contains("hidden"))))
    rb.classList.remove("hidden");
  const tb = document.getElementById("toggle-prof-password");
  if (tb) {
    tb.disabled = false;
    tb.classList.remove("opacity-60", "cursor-not-allowed");
  }
  const fi = document.getElementById("profile-pic-input");
  if (fi) fi.disabled = false;
}

window.toggleEditMode = function () {
  const ab = document.getElementById("profile-action-btn");
  if (!ab) return;
  if (ab.getAttribute("data-mode") === "edit") {
    showLoading("Preparing edit mode...");
    setTimeout(() => {
      enableAllProfileFields();
      ab.innerHTML =
        '<i class="fa-solid fa-floppy-disk text-[10px] mr-1"></i><span class="text-[10px]">Save Changes</span>';
      ab.classList.remove("btn-secondary", "opacity-60", "cursor-not-allowed");
      ab.classList.add("btn-primary");
      ab.setAttribute("data-mode", "save");
      ab.setAttribute("onclick", "saveProfileChanges()");
      ab.disabled = false;
      document.getElementById("cancel-edit-btn")?.classList.remove("hidden");
      hideLoading();
      window.showAlert(
        "Edit Mode",
        "You can now edit your profile.",
        "success",
      );
    }, 500);
  }
};

window.cancelEdit = function () {
  showLoading("Cancelling...");
  setTimeout(() => {
    selectedProfilePicFile = undefined;
    document.getElementById("profile-pic-pending")?.classList.add("hidden");
    const fi = document.getElementById("profile-pic-input");
    if (fi) fi.value = "";
    if (loggedInUser) updateUIWithUserData(loggedInUser);
    disableAllProfileFields();
    document.getElementById("cancel-edit-btn")?.classList.add("hidden");
    const ab = document.getElementById("profile-action-btn");
    if (ab) {
      ab.innerHTML =
        '<i class="fa-solid fa-pen-to-square text-[10px] mr-1"></i><span class="text-[10px]">Edit Profile</span>';
      ab.classList.remove("btn-primary");
      ab.classList.add("btn-secondary");
      ab.setAttribute("data-mode", "edit");
      ab.setAttribute("onclick", "toggleEditMode()");
    }
    hideLoading();
    window.showAlert("Cancelled", "Changes discarded.", "success");
    const profPw = document.getElementById("prof-password");
    if (profPw) profPw.type = "password";
    const profIcon = document.getElementById("prof-password-icon");
    if (profIcon) {
      profIcon.classList.remove("fa-eye-slash");
      profIcon.classList.add("fa-eye");
    }
    const profBtn = document.getElementById("toggle-prof-password");
    if (profBtn) {
      profBtn.setAttribute("aria-pressed", "false");
      profBtn.setAttribute("aria-label", "Show password");
    }
  }, 400);
};

window.saveProfileChanges = function () {
  showLoading("Saving...");
  setTimeout(() => {
    const pf = document.getElementById("profile-form");
    if (pf) {
      if (typeof pf.requestSubmit === "function") pf.requestSubmit();
      else
        pf.dispatchEvent(
          new Event("submit", { cancelable: true, bubbles: true }),
        );
    }
    hideLoading();
  }, 300);
};

// ===== RE-AUTHENTICATION HELPERS (for password changes) =====
/**
 * Firebase refuses updatePassword() when the login session is too old
 * (auth/requires-recent-login). Prompt for the current password and
 * re-authenticate so the password change can go through.
 */
function promptForReauthPassword(errorMessage = "") {
  return new Promise((resolve) => {
    document.getElementById("reauth-modal")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "reauth-modal";
    overlay.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm z-[9999] flex items-center justify-center p-4";

    const finish = (value) => {
      overlay.remove();
      document.body.style.overflow = "";
      resolve(value);
    };

    overlay.innerHTML = `<div class="bg-white rounded-lg max-w-sm w-full p-7 border border-gray-200 modal-enter relative">
      <button type="button" data-reauth-cancel class="absolute top-4 right-4 text-gray-400 hover:text-gray-600"><i class="fa-solid fa-xmark text-xl"></i></button>
      <div class="w-14 h-14 bg-tsu-light text-tsu-blue rounded-lg flex items-center justify-center mx-auto mb-4 text-xl"><i class="fa-solid fa-shield-halved"></i></div>
      <h3 class="text-lg font-extrabold text-center text-gray-900">Confirm it's you</h3>
      <p class="text-sm text-gray-500 text-center mt-2">For your security, enter your <span class="font-semibold">current password</span> before setting a new one.</p>
      <div class="relative mt-4">
        <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400"><i class="fa-solid fa-lock text-xs"></i></span>
        <input type="password" id="reauth-password" placeholder="Current password"
          class="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-sm text-sm focus:ring-2 focus:ring-tsu-blue/20 focus:border-tsu-blue" />
      </div>
      <p data-reauth-error class="${errorMessage ? "" : "hidden "}mt-2 text-xs font-medium text-red-600 flex items-start space-x-1.5"><i class="fa-solid fa-circle-exclamation mt-0.5 text-[10px]"></i><span>${errorMessage}</span></p>
      <div class="grid grid-cols-2 gap-3 mt-5">
        <button type="button" data-reauth-cancel class="px-4 py-2.5 rounded-md text-sm border text-gray-600 font-semibold">Cancel</button>
        <button type="button" data-reauth-confirm class="px-4 py-2.5 rounded-md text-sm bg-tsu-blue text-tsu-gold font-semibold">Verify</button>
      </div></div>`;

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    const input = overlay.querySelector("#reauth-password");
    const showError = (msg) => {
      const err = overlay.querySelector("[data-reauth-error]");
      if (err) {
        err.querySelector("span").textContent = msg;
        err.classList.remove("hidden");
      }
      input.classList.add("border-red-500");
      input.value = "";
      input.focus();
    };
    input.addEventListener("input", () => {
      input.classList.remove("border-red-500");
      overlay.querySelector("[data-reauth-error]")?.classList.add("hidden");
    });

    overlay
      .querySelectorAll("[data-reauth-cancel]")
      .forEach((b) => b.addEventListener("click", () => finish(null)));
    overlay
      .querySelector("[data-reauth-confirm]")
      .addEventListener("click", () => {
        const v = input.value;
        if (!v) {
          showError("Please enter your current password.");
          return;
        }
        finish(v);
      });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        overlay.querySelector("[data-reauth-confirm]").click();
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    setTimeout(() => input.focus(), 60);
  });
}

/**
 * Re-authenticate the signed-in resident with their current password.
 * Re-prompts with an inline error on a wrong password.
 * Returns true once verified, false if the user cancels.
 */
async function ensureRecentLogin() {
  if (!auth.currentUser) return false;
  let lastError = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const currentPassword = await promptForReauthPassword(lastError);
    if (currentPassword === null) return false; // user cancelled
    showLoading("Verifying password...");
    try {
      const credential = EmailAuthProvider.credential(
        auth.currentUser.email,
        currentPassword,
      );
      await reauthenticateWithCredential(auth.currentUser, credential);
      hideLoading();
      return true;
    } catch (reErr) {
      hideLoading();
      if (
        ["auth/invalid-credential", "auth/wrong-password"].includes(reErr?.code)
      ) {
        lastError = "Incorrect current password. Please try again.";
        continue; // prompt again with the error shown
      }
      throw reErr;
    }
  }
}

// ===== PROFILE FORM =====
const profileForm = document.getElementById("profile-form");
if (profileForm) {
  profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ab = document.getElementById("profile-action-btn");
    if (!ab || ab.getAttribute("data-mode") !== "save") return;
    if (isSaving || !loggedInUser?.id) return;
    const phone = document.getElementById("prof-phone")?.value.trim() || "";
    let address = document.getElementById("prof-address")?.value.trim() || "";
    const pi = document.getElementById("prof-password");
    // Blank password field = keep current password (managed by Firebase Auth only)
    const password = pi && pi.value.trim() !== "" ? pi.value.trim() : "";
    const hasNonPwd =
      phone !== (loggedInUser.phone || "") ||
      address !== (loggedInUser.address || "");
    const hasPwd = password.length > 0,
      hasInfo = hasNonPwd || hasPwd;
    const hasPic = selectedProfilePicFile !== undefined,
      isNewPic = selectedProfilePicFile instanceof File,
      isRemoving = selectedProfilePicFile === null;
    if (!hasInfo && !hasPic) {
      window.showAlert("No Changes", "Nothing to save.", "error");
      return;
    }
    if (hasNonPwd && phone && !/^09\d{9}$/.test(phone)) {
      const message = "Must be 11 digits starting with 09";
      if (!window.markFieldInvalid?.("prof-phone", message)) {
        window.showAlert("Error", "Enter a valid phone number (11 digits starting with 09).", "error");
      }
      return;
    }
    // Same strong policy as account creation (ADD-ON MODULE 3).
    if (hasPwd) {
      const passwordCheck = window.OVPassword?.evaluate(password, {
        name: loggedInUser?.name || "",
        email: loggedInUser?.email || "",
        phone: loggedInUser?.phone || "",
      });
      if (passwordCheck && !passwordCheck.valid) {
        document.getElementById("prof-password")?.focus();
        if (
          !window.markFieldInvalid?.(
            "prof-password",
            passwordCheck.failures.join(" • "),
          )
        ) {
          window.showAlert(
            "Weak Password",
            window.OVPassword.alertText(passwordCheck),
            "error",
          );
        }
        return;
      }
    }
    // ===== LOCATION-BASED ADDRESS VALIDATION (only when it changed) =====
    let profAddressGeo = null;
    if (address !== (loggedInUser.address || "") && window.OVAddress) {
      showLoading("Verifying address...");
      const addressOk = await window.OVAddress.ensureValid("prof-address");
      hideLoading();
      if (!addressOk) {
        const message =
          "Address not found — pick a suggestion from the list or use 'Use my location'";
        if (!window.markFieldInvalid?.("prof-address", message)) {
          window.showAlert("Check the address", message, "error");
        }
        return;
      }
      address = document.getElementById("prof-address")?.value.trim() || address;
      profAddressGeo = window.OVAddress.getCoords("prof-address");
    }
    isSaving = true;
    showLoading("Saving...");
    if (ab) {
      ab.disabled = true;
      ab.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin text-[10px] mr-1"></i><span class="text-[10px]">Saving...</span>';
    }
    try {
      const ud = {},
        su = {},
        now = new Date();
      if (hasPic) {
        if (isNewPic) {
          const pic = await uploadProfilePicture(
            loggedInUser.id,
            selectedProfilePicFile,
          );
          ud.profilePic = pic;
          su.profilePic = pic;
        } else if (isRemoving) {
          ud.profilePic = "";
          su.profilePic = "";
        }
      }
      if (hasInfo) {
        if (hasPwd && auth.currentUser) {
          // ALWAYS verify identity first: clicking Save with a new password
          // pops up the overlay asking for the CURRENT (old) password.
          hideLoading();
          const verifiedUpFront = await ensureRecentLogin();
          if (!verifiedUpFront) {
            throw new Error(
              "Password change cancelled. Identity verification is required to set a new password.",
            );
          }
          showLoading("Saving...");
          try {
            await updatePassword(auth.currentUser, password);
          } catch (pwErr) {
            if (pwErr?.code === "auth/requires-recent-login") {
              // Session went stale between verification and the write:
              // verify the current password again, then retry the update.
              hideLoading();
              const verified = await ensureRecentLogin();
              if (!verified) {
                throw new Error(
                  "Password change cancelled. Identity verification is required to set a new password.",
                );
              }
              showLoading("Saving...");
              await updatePassword(auth.currentUser, password);
            } else if (pwErr?.code === "auth/weak-password") {
              throw new Error(
                `The new password is too weak. Use ${window.OVPassword?.summary || "at least 10 characters with uppercase, lowercase, numbers and symbols"}.`,
              );
            } else {
              throw pwErr;
            }
          }
        }
        if (hasNonPwd) {
          ud.phone = phone;
          ud.address = address;
          ud.lastProfileUpdate = serverTimestamp();
          su.phone = phone;
          su.address = address;
          su.lastProfileUpdate = now.toISOString();
          if (profAddressGeo) {
            ud.addressVerified = true;
            ud.addressLat = profAddressGeo.lat;
            ud.addressLng = profAddressGeo.lng;
            ud.addressPlaceId = profAddressGeo.placeId;
            su.addressVerified = true;
            su.addressLat = profAddressGeo.lat;
            su.addressLng = profAddressGeo.lng;
            su.addressPlaceId = profAddressGeo.placeId;
          }
        }
      }
      if (Object.keys(ud).length > 0)
        await updateDoc(doc(db, "residents", loggedInUser.id), ud);
      if (Object.keys(su).length > 0) {
        Object.assign(loggedInUser, su);
        saveUserSession(loggedInUser);
      }
      selectedProfilePicFile = undefined;
      // Address changed → the forecast should follow the resident.
      if (hasNonPwd) window.updateWeatherLocation?.(true);
      updateUIWithUserData(loggedInUser);
      disableAllProfileFields();
      hideLoading();
      document.getElementById("cancel-edit-btn")?.classList.add("hidden");
      let msg = hasNonPwd ? "Profile updated" : "";
      if (hasPwd) msg += (msg ? " & " : "") + "password changed";
      if (isNewPic) msg += (msg ? " & " : "") + "picture updated";
      if (isRemoving) msg += (msg ? " & " : "") + "picture removed";
      window.showAlert("Success!", msg + "! Fields locked.", "success");
      document.getElementById("prof-password").type = "password";
    } catch (error) {
      hideLoading();
      window.showAlert("Error", `Failed: ${error.message}`, "error");
      if (ab) {
        ab.disabled = false;
        ab.innerHTML =
          '<i class="fa-solid fa-floppy-disk text-[10px] mr-1"></i><span class="text-[10px]">Save Changes</span>';
        ab.classList.add("btn-primary");
      }
    } finally {
      isSaving = false;
    }
  });
}

// ===== PASSWORD TOGGLE & CONFIRM BUTTONS =====
window.toggleProfPassword = function () {
  const pf = document.getElementById("prof-password"),
    ic = document.getElementById("prof-password-icon"),
    btn = document.getElementById("toggle-prof-password");
  if (!pf) return;
  const isPass = pf.type === "password";
  pf.type = isPass ? "text" : "password";
  if (ic) {
    if (isPass) {
      ic.classList.remove("fa-eye");
      ic.classList.add("fa-eye-slash");
    } else {
      ic.classList.remove("fa-eye-slash");
      ic.classList.add("fa-eye");
    }
  }
  if (btn) {
    btn.setAttribute("aria-pressed", isPass ? "true" : "false");
    btn.setAttribute("aria-label", isPass ? "Hide password" : "Show password");
  }
};

document.getElementById("confirm-cancel-btn")?.addEventListener("click", () => {
  document.getElementById("confirm-modal")?.classList.add("hidden");
  pendingConfirmCallback = null;
});

document
  .getElementById("confirm-proceed-btn")
  ?.addEventListener("click", () => {
    document.getElementById("confirm-modal")?.classList.add("hidden");
    if (typeof pendingConfirmCallback === "function") pendingConfirmCallback();
    pendingConfirmCallback = null;
  });

// ===== ANNOUNCEMENTS =====
/* ---------------------------------------------------------------------------
   Announcement ordering — newest post first, exactly as they were posted.

   Flip to false for oldest-first (chronological, like a timeline).
   --------------------------------------------------------------------------- */
const ANNOUNCEMENTS_NEWEST_FIRST = true;

// Resolve a comparable millisecond value from whatever the record carries.
// Handles Firestore Timestamps, {seconds}, Date, ISO strings and epoch numbers,
// so a post never falls out of order just because of how its date was stored.
function getAnnouncementPostedTime(announcement) {
  const raw =
    announcement?.createdAt ??
    announcement?.postedAt ??
    announcement?.datePosted ??
    announcement?.timestamp ??
    null;

  // A serverTimestamp() write is null locally until the server confirms it.
  // Treat it as "right now" so a just-posted notice jumps straight to the top
  // instead of sinking to the bottom for a moment.
  if (raw === null || raw === undefined) return Number.MAX_SAFE_INTEGER;

  if (typeof raw?.toDate === "function") return raw.toDate().getTime();
  if (typeof raw === "object" && typeof raw.seconds === "number")
    return raw.seconds * 1000;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

// Sort a copy so the caller's array/Map order is never mutated.
function sortAnnouncementsByPosted(list) {
  return [...list].sort((a, b) => {
    const diff = getAnnouncementPostedTime(b) - getAnnouncementPostedTime(a);
    // Same timestamp (bulk import, identical second): fall back to id so the
    // order stays stable between renders instead of shuffling.
    if (diff !== 0) return ANNOUNCEMENTS_NEWEST_FIRST ? diff : -diff;
    const tie = String(b.id || "").localeCompare(String(a.id || ""));
    return ANNOUNCEMENTS_NEWEST_FIRST ? tie : -tie;
  });
}

function normalizeAnnouncementPriority(value) {
  const priority = String(value || "").trim().toLowerCase();
  if (priority === "emergency") return "Emergency";
  if (priority === "important") return "Important";
  return "Notice";
}

function getAnnouncementPriorityMeta(priorityValue) {
  const priority = normalizeAnnouncementPriority(priorityValue);
  if (priority === "Emergency")
    return {
      priority,
      badgeClass: "bg-red-100 text-red-700",
      icon: "fa-triangle-exclamation",
    };
  if (priority === "Important")
    return {
      priority,
      badgeClass: "bg-amber-100 text-amber-700",
      icon: "fa-circle-exclamation",
    };
  return {
    priority: "Notice",
    badgeClass: "bg-blue-50 text-tsu-blue",
    icon: "fa-circle-info",
  };
}

function buildAnnouncementCardHtml(announcement, order = 0) {
  const meta = getAnnouncementPriorityMeta(announcement.priority);
  const relativeTime = announcement.createdAt
    ? formatRelativeTime(announcement.createdAt)
    : "Recently";
  const fullDate = announcement.createdAt
    ? formatFullDateTime(announcement.createdAt)
    : "Recently";
  const title = escapeAnnouncementHtml(
    announcement.title || "Untitled announcement",
  );
  const description = escapeAnnouncementHtml(
    announcement.desc || announcement.description || "No description provided.",
  );
  const imageUrl = getSafeAnnouncementImageUrl(
    announcement.imageUrl || announcement.image,
  );
  const imageHtml = imageUrl
    ? `<div class="announcement-card-image h-40 w-full bg-gray-100 border-b border-gray-100 overflow-hidden flex justify-center"><img src="${escapeAnnouncementHtml(imageUrl)}" alt="${title}" loading="lazy" decoding="async"></div>`
    : `<div class="announcement-card-image h-40 w-full bg-gradient-to-br from-tsu-blue to-tsu-dark border-b border-white/10 overflow-hidden flex flex-col items-center justify-center text-center p-4"><i class="fa-solid ${meta.icon} text-tsu-gold text-3xl"></i><span class="mt-2 text-[9px] font-bold uppercase tracking-[.18em] text-blue-100">Community bulletin</span></div>`;

  return `<article data-announcement-id="${escapeAnnouncementHtml(announcement.id)}" role="button" tabindex="0" aria-label="Read announcement: ${title}" class="announcement-card bg-white rounded-md border border-gray-200 shadow-sm hover:shadow-lg transition-all cursor-pointer overflow-hidden group focus:outline-none focus:ring-2 focus:ring-tsu-blue/30">${imageHtml}<div class="announcement-card-body p-5 sm:p-6"><div class="flex items-center justify-between mb-3 gap-2"><div class="flex items-center min-w-0"><div class="min-w-0"><h4 class="font-bold text-sm text-gray-900 truncate">Municipality of Victoria</h4><span class="text-[11px] text-gray-400" title="${escapeAnnouncementHtml(fullDate)}"><i class="fa-solid fa-clock mr-1"></i>${escapeAnnouncementHtml(relativeTime)}</span></div></div><span class="text-[9px] px-2 py-1 rounded-full font-bold shrink-0 ${meta.badgeClass}"><i class="fa-solid ${meta.icon} mr-1"></i>${meta.priority}</span></div><h3 class="text-base sm:text-lg font-extrabold text-gray-900 group-hover:text-tsu-blue transition-colors line-clamp-2 leading-snug mb-2">${title}</h3><p class="text-sm text-gray-500 mt-2 line-clamp-3 leading-relaxed">${description}</p></div><div class="px-5 sm:px-6 py-3 bg-gray-50/80 border-t border-gray-100 flex items-center justify-between"><span class="text-xs text-tsu-blue font-semibold group-hover:underline">Read More <i class="fa-solid fa-arrow-right ml-1.5 text-[11px]"></i></span><span class="text-[9px] text-gray-400">Official notice</span></div></article>`;
}

function updateAnnouncementCenterSummary() {
  const announcements = sortAnnouncementsByPosted(
    Array.from(announcementsById.values()),
  );
  const important = announcements.filter(
    (item) => normalizeAnnouncementPriority(item.priority) === "Important",
  );
  const emergencies = announcements.filter(
    (item) => normalizeAnnouncementPriority(item.priority) === "Emergency",
  );

  setDashboardText("announcement-total-count", announcements.length);
  setDashboardText("announcement-important-count", important.length);
  setDashboardText("announcement-emergency-count", emergencies.length);
  setDashboardText(
    "announcement-last-updated",
    announcements[0]?.createdAt
      ? formatRelativeTime(announcements[0].createdAt)
      : "No updates",
  );

  const priorityNotice = emergencies[0] || important[0] || null;
  const alert = document.getElementById("announcement-priority-alert");
  if (!alert) return;
  if (!priorityNotice) {
    alert.classList.add("hidden");
    alert.removeAttribute("data-announcement-id");
    return;
  }

  const isEmergency =
    normalizeAnnouncementPriority(priorityNotice.priority) === "Emergency";
  alert.className = `w-full mt-5 text-left rounded-lg border p-4 sm:p-5 transition-all hover:shadow-md group ${isEmergency
    ? "bg-rose-50 border-rose-200 text-rose-900"
    : "bg-amber-50 border-amber-200 text-amber-900"
    }`;
  alert.setAttribute("data-announcement-id", priorityNotice.id);
  const icon = document.getElementById("announcement-priority-icon");
  if (icon) {
    icon.className = `w-10 h-10 shrink-0 rounded-md flex items-center justify-center ${isEmergency ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
      }`;
    icon.innerHTML = `<i class="fa-solid ${isEmergency ? "fa-triangle-exclamation" : "fa-circle-exclamation"
      }"></i>`;
  }
  setDashboardText(
    "announcement-priority-label",
    isEmergency ? "Emergency advisory" : "Important notice",
  );
  setDashboardText(
    "announcement-priority-title",
    priorityNotice.title || "Municipal advisory",
  );
}

function renderAnnouncementCenter() {
  const container = document.getElementById("announcements-container");
  const resultLabel = document.getElementById("announcement-results-count");
  if (!container) return;

  const queryText = announcementFilterState.query.toLowerCase();
  const filtered = sortAnnouncementsByPosted(
    Array.from(announcementsById.values()),
  ).filter((item) => {
    const priority = normalizeAnnouncementPriority(item.priority);
    const priorityMatches =
      announcementFilterState.priority === "All" ||
      priority === announcementFilterState.priority;
    const searchable = `${item.title || ""} ${item.desc || item.description || ""} ${priority}`.toLowerCase();
    return priorityMatches && (!queryText || searchable.includes(queryText));
  });

  if (resultLabel) {
    resultLabel.textContent = filtered.length
      ? `Showing ${filtered.length} announcement${filtered.length === 1 ? "" : "s"}`
      : "No announcements match your filters";
  }

  if (!filtered.length) {
    container.innerHTML = `<div class="md:col-span-2 xl:col-span-3 w-full max-w-lg mx-auto text-center py-10 px-5 bg-white rounded-md border border-gray-200 shadow-sm"><div class="w-14 h-14 bg-gray-100 rounded-md flex items-center justify-center mx-auto text-gray-300"><i class="fa-solid fa-magnifying-glass text-xl"></i></div><p class="text-sm font-bold text-gray-700 mt-3">No matching announcements</p><p class="text-xs text-gray-400 mt-1">Try another keyword or clear the priority filter.</p><button type="button" onclick="clearAnnouncementFilters()" class="mt-4 text-xs font-bold text-tsu-blue hover:underline">Show all announcements</button></div>`;
    return;
  }

  container.innerHTML = filtered
    .map((announcement, order) => buildAnnouncementCardHtml(announcement, order))
    .join("");
}

window.setAnnouncementFilter = function (priority) {
  announcementFilterState.priority = [
    "All",
    "Notice",
    "Important",
    "Emergency",
  ].includes(priority)
    ? priority
    : "All";
  document.querySelectorAll("[data-announcement-filter]").forEach((button) => {
    const active = button.dataset.announcementFilter === announcementFilterState.priority;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  renderAnnouncementCenter();
};

window.filterAnnouncements = function (value) {
  announcementFilterState.query = String(value || "").trim();
  renderAnnouncementCenter();
};

// window.clearAnnouncementFilters = function () {
//   announcementFilterState = { priority: "All", query: "" };
//   const search = document.getElementById("announcement-search");
//   if (search) search.value = "";
//   window.setAnnouncementFilter("All");
// };

onSnapshot(
  query(collection(db, "announcements"), orderBy("createdAt", "desc")),
  (snap) => {
    const publicContainer = document.getElementById(
      "public-announcements-container",
    );
    announcementsById.clear();
    snap.forEach((snapshotDoc) => {
      announcementsById.set(snapshotDoc.id, {
        id: snapshotDoc.id,
        ...snapshotDoc.data(),
      });
    });

    updateAnnouncementCenterSummary();
    renderAnnouncementCenter();
    renderDashboardAnnouncements();

    if (publicContainer) {
      const allAnnouncements = sortAnnouncementsByPosted(
        Array.from(announcementsById.values()),
      );
      publicContainer.innerHTML = allAnnouncements.length
        ? allAnnouncements
          .map((announcement, order) =>
            buildAnnouncementCardHtml(announcement, order),
          )
          .join("")
        : '<div class="text-center py-10 bg-white rounded-md border shadow-sm"><div class="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fa-solid fa-bullhorn text-2xl text-gray-300"></i></div><p class="text-base text-gray-400">No announcements yet.</p></div>';
    }
  },
);

document.addEventListener("click", (event) => {
  const card = event.target.closest("[data-announcement-id]");
  if (card) window.openAnnouncementDetails(card.dataset.announcementId);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-announcement-id]");
  if (!card) return;
  event.preventDefault();
  window.openAnnouncementDetails(card.dataset.announcementId);
});

window.openAnnouncementDetails = function (announcementId) {
  const announcement = announcementsById.get(announcementId);
  if (!announcement) return;

  const title = announcement.title || "Untitled announcement";
  const priority = announcement.priority || "Notice";
  const date = announcement.createdAt
    ? formatFullDateTime(announcement.createdAt)
    : "Recently";
  const imageUrl = getSafeAnnouncementImageUrl(
    announcement.imageUrl || announcement.image,
  );
  const modalTitle = document.getElementById("modal-announcement-title"),
    modalDescription = document.getElementById("modal-announcement-desc"),
    modalDate = document.getElementById("modal-announcement-date"),
    modalBadge = document.getElementById("modal-announcement-badge"),
    textPanel = document.getElementById("modal-announcement-text-panel"),
    imageContainer = document.getElementById(
      "modal-announcement-image-container",
    ),
    modalImage = document.getElementById("modal-announcement-image");

  if (modalTitle) modalTitle.textContent = title;
  if (modalDescription) {
    modalDescription.textContent =
      announcement.desc || announcement.description || "No description.";
  }
  if (modalDate) {
    modalDate.innerHTML = `<i class="fa-solid fa-clock mr-1"></i>${escapeAnnouncementHtml(date)}`;
    modalDate.title = date;
  }
  if (modalBadge) {
    modalBadge.textContent = priority;
    modalBadge.className =
      "text-xs font-bold uppercase px-3.5 py-1 rounded-full";
    if (priority === "Important")
      modalBadge.classList.add("bg-amber-100", "text-amber-700");
    else if (priority === "Emergency")
      modalBadge.classList.add("bg-red-100", "text-red-700");
    else modalBadge.classList.add("bg-gray-100", "text-gray-600");
  }

  // Make the whole body (image + text) one scrollable region.
  makeAnnouncementBodyScrollable();

  if (imageContainer && modalImage && imageUrl) {
    modalImage.alt = `${title} announcement image`;
    modalImage.onerror = function () {
      imageContainer.classList.add("hidden");
      this.removeAttribute("src");
    };
    modalImage.src = imageUrl;
    imageContainer.classList.remove("hidden");
  } else if (imageContainer && modalImage) {
    imageContainer.classList.add("hidden");
    modalImage.removeAttribute("src");
    modalImage.alt = "";
  }

  // Always start a newly opened announcement at the top.
  const scroller = document.getElementById("modal-announcement-content");
  if (scroller) scroller.scrollTop = 0;

  window.toggleModal("view-announcement-modal");
};

/**
 * The announcement modal originally split the body into a 2-column grid:
 * the text scrolled on its own while the image was pinned in a separate
 * cell and capped in height, so tall images were cropped and never moved.
 * Reflow it into ONE vertical scroll container holding the image and the
 * text, so the entire content — image included — scrolls together.
 * Runs once; safe to call on every open.
 */
function makeAnnouncementBodyScrollable() {
  const content = document.getElementById("modal-announcement-content");
  if (!content || content.dataset.ovScrollable === "1") return;
  content.dataset.ovScrollable = "1";

  // `custom-scrollbar` has no stylesheet rule in this project, so give the
  // scroll area a slim visible scrollbar (injected once).
  if (!document.getElementById("ov-announcement-scroll-style")) {
    const style = document.createElement("style");
    style.id = "ov-announcement-scroll-style";
    style.textContent = `
      #modal-announcement-content { scrollbar-width: thin; scrollbar-color: #94a3b8 transparent; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
      #modal-announcement-content::-webkit-scrollbar { width: 8px; }
      #modal-announcement-content::-webkit-scrollbar-track { background: transparent; }
      #modal-announcement-content::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 9999px; }
      #modal-announcement-content::-webkit-scrollbar-thumb:hover { background-color: #94a3b8; }
    `;
    document.head.appendChild(style);
  }

  const textPanel = document.getElementById("modal-announcement-text-panel");
  const imageContainer = document.getElementById(
    "modal-announcement-image-container",
  );
  const modalImage = document.getElementById("modal-announcement-image");

  // Body becomes a single scrolling column instead of a clipped grid.
  content.className =
    "flex-1 min-h-0 mb-5 overflow-y-auto overflow-x-hidden custom-scrollbar space-y-4 pr-1";

  // Image flows at the top of that column, full width, uncropped.
  if (imageContainer) {
    imageContainer.className =
      "hidden bg-gray-100 border border-gray-200 rounded-md overflow-hidden text-center";
    // Move the image above the text so it reads naturally while scrolling.
    content.insertBefore(imageContainer, content.firstChild);
  }
  if (modalImage) {
    modalImage.className = "w-full h-auto object-contain mx-auto block";
  }

  // Text panel no longer scrolls by itself — the parent handles it.
  if (textPanel) {
    textPanel.className = "bg-gray-50 p-5 rounded-md";
  }
}

// ===== EVENT HANDLERS =====
window.handleRegisterClick = function (e, eid, et, ed, etm, el) {
  e.preventDefault();
  e.stopPropagation();
  window.confirmJoinEvent(eid, et, ed, etm, el);
  return false;
};

window.handleUnregisterClick = function (e, eid, et) {
  e.preventDefault();
  e.stopPropagation();
  window.unregisterFromEvent(eid, et);
  return false;
};

/** Event action buttons — distinct colors per state (Join = gold, Completed = green, Cancel = red). */
function eventJoinButtonHtml(onclickAttr) {
  return `<button type="button" onclick="${onclickAttr}" class="event-btn-join text-xs font-bold text-[#FFFFFF] bg-[#062764] hover:bg-[#062153] px-4 py-2 rounded-sm transition-all shadow-sm flex items-center justify-center space-x-1.5 w-full relative z-10"><i class="fa-solid fa-calendar-plus"></i><span>Join</span></button>`;
}
function eventCompletedButtonHtml() {
  return '<span class="event-btn-completed inline-flex items-center gap-2 text-xs font-semibold text-[#07cf7c] bg-[#001F3F] px-3 py-2 rounded-sm border border-[#07cf7c] w-full justify-center pointer-events-none"><i class="fa-solid fa-circle-check text-xs"></i><span>Completed</span></span>';
}
function eventCancelButtonHtml(onclickAttr, extraClass) {
  return `<button type="button" onclick="${onclickAttr}" class="event-btn-cancel text-xs font-semibold text-[#B42318] hover:text-white bg-[#FEE4E2] hover:bg-[#B42318] px-3 py-2 rounded-sm transition-all border border-[#FECACA] w-full relative z-10${extraClass ? " " + extraClass : ""}"><i class="fa-solid fa-calendar-minus mr-1.5"></i>Cancel Registration</button>`;
}

// ===== RENDER EVENTS =====
function renderPublicEvents() {
  const grid = document.getElementById("public-events-grid");
  if (!grid) return;
  getDocs(collection(db, "events")).then(
    (snap) => {
      scheduleNextEventStatusRefresh(snap);
      if (snap.empty) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-10 bg-white rounded-md border shadow-sm"><p class="text-sm text-gray-500">No upcoming events.</p></div>';
        return;
      }
      const sortedEvents = sortEvents(snap);
      if (!sortedEvents.length) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-10 bg-white rounded-md border shadow-sm"><p class="text-sm text-gray-500">No upcoming events.</p></div>';
        return;
      }
      let html = "";
      sortedEvents.forEach((ev) => {
        const esc = (t) => {
          const div = document.createElement("div");
          div.textContent = t || "";
          return div.innerHTML.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        };
        const dd = ev.date || "TBA",
          td = ev.time ? formatTimeDisplay(ev.time) : "";
        const dateStatus = getEventDateStatus(ev.date, ev.time),
          dateBadge = eventDateBadgeHtml(ev.date, ev.time),
          endedCardClass = dateStatus.ended ? " opacity-75 bg-gray-50" : "";
        let ti = "fa-calendar-check",
          pg = "from-tsu-blue to-tsu-dark";
        switch (ev.type) {
          case "Seminar":
            ti = "fa-chalkboard-user";
            pg = "from-[#800000] to-[#A52A2A]";
            break;
          case "Workshop":
            ti = "fa-toolbox";
            pg = "from-[#A52A2A] to-[#8B0000]";
            break;
          case "Meeting":
            ti = "fa-users";
            pg = "from-[#D49300] to-[#8B6914]";
            break;
          case "Sports":
            ti = "fa-futbol";
            pg = "from-[#005B9F] to-[#003B71]";
            break;
          case "Health":
            ti = "fa-heart-pulse";
            pg = "from-[#8B0000] to-[#600000]";
            break;
          case "Training":
            ti = "fa-graduation-cap";
            pg = "from-[#005B9F] to-[#003B71]";
            break;
          case "Celebration":
            ti = "fa-cake-candles";
            pg = "from-[#F2A900] to-[#D49300]";
            break;
          case "Outreach":
            ti = "fa-hand-holding-heart";
            pg = "from-[#003B71] to-[#005B9F]";
            break;
          case "Environmental":
            ti = "fa-leaf";
            pg = "from-[#001F3F] to-[#003B71]";
            break;
          case "Cultural":
            ti = "fa-masks-theater";
            pg = "from-[#F2A900] to-[#D49300]";
            break;
          case "Fundraising":
            ti = "fa-sack-dollar";
            pg = "from-[#A52A2A] to-[#800000]";
            break;
        }
        const hi = ev.imageUrl && ev.imageUrl !== "";
        const is = hi
          ? `<div class="relative h-40 overflow-hidden rounded-t-md"><img src="${ev.imageUrl}" alt="${esc(ev.title)}" loading="lazy" decoding="async" class="w-full h-full object-cover ${dateStatus.ended ? "grayscale" : ""}"><div class="absolute top-3 left-3"><span class="inline-flex items-center space-x-1 text-[10px] font-bold uppercase tracking-wider event-type-badge text-white px-2.5 py-1 rounded-full"><i class="fa-solid ${ti} text-[#F2A900] text-[10px]"></i><span>${ev.type || "Event"}</span></span></div>${dateBadge ? `<div class="absolute top-3 right-3">${dateBadge}</div>` : ""}</div>`
          : `<div class="relative h-40 bg-gradient-to-br ${pg} flex items-center justify-center overflow-hidden rounded-t-md ${dateStatus.ended ? "grayscale" : ""}"><i class="fa-solid ${ti} text-white/30 text-5xl"></i><div class="absolute top-3 left-3"><span class="inline-flex items-center space-x-1 text-[10px] font-bold uppercase tracking-wider event-type-badge text-white px-2.5 py-1 rounded-full"><i class="fa-solid ${ti} text-[#F2A900] text-[10px]"></i><span>${ev.type || "Event"}</span></span></div>${dateBadge ? `<div class="absolute top-3 right-3">${dateBadge}</div>` : ""}</div>`;
        const ab = dateStatus.ended
          ? eventEndedButtonHtml()
          : eventJoinButtonHtml(
            "window.showAlert('Authentication Required','Please log in or create an account to join community events.','error')",
          );
        html += `<div class="bg-white rounded-md border border-gray-200 shadow-sm hover:shadow-lg transition-all overflow-hidden flex flex-col${endedCardClass}"><div onclick="openEventDetails('${esc(ev.title)}','${dd}','${td}','${esc(ev.location)}','${esc(ev.desc || "")}')" class="cursor-pointer group">${is}<div class="p-4 pb-2"><h3 class="text-sm font-bold text-gray-900 group-hover:text-[#F2A900] transition-colors line-clamp-2 leading-snug mb-2">${ev.title || "Untitled Event"}</h3><div class="space-y-2"><div class="flex items-center space-x-1.5 text-xs text-[#353535]"><i class="fa-solid fa-calendar text-[#D49300] w-4"></i><span class="font-semibold text-[#353535]">${dd}</span>${td ? `<span class="font-medium text-[#353535]">| ${td}</span>` : ""}</div><div class="flex items-center space-x-1.5 text-xs text-[#353535]"><i class="fa-solid fa-location-dot text-[#D49300] w-4"></i><span class="font-semibold text-[#353535] truncate">${ev.location || "TBA"}</span></div></div></div></div><div class="px-4 pb-4 pt-3 border-t border-gray-100 mt-auto">${ab}</div></div>`;
      });
      grid.innerHTML = html;
    },
  );
}

function renderEvents() {
  const grid = document.getElementById("events-grid");
  if (!grid) return;
  getDocs(collection(db, "events")).then(
    (snap) => {
      scheduleNextEventStatusRefresh(snap);
      if (snap.empty) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-16 bg-white rounded-md border shadow-sm"><p class="text-base text-gray-400">No upcoming events.</p></div>';
        return;
      }
      const sortedEvents = sortEvents(snap);
      if (!sortedEvents.length) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-16 bg-white rounded-md border shadow-sm"><p class="text-base text-gray-400">No upcoming events.</p></div>';
        return;
      }
      let html = "";
      sortedEvents.forEach((ev) => {
        const id = ev.id;
        const esc = (t) => {
          const div = document.createElement("div");
          div.textContent = t || "";
          return div.innerHTML.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        };
        const isReg = registeredEventIds.has(id),
          isComp = completedEventIds.has(id);
        const dd = ev.date || "TBA",
          td = ev.time ? formatTimeDisplay(ev.time) : "";
        const dateStatus = getEventDateStatus(ev.date, ev.time),
          dateBadge = eventDateBadgeHtml(ev.date, ev.time),
          endedCardClass = dateStatus.ended ? " opacity-75 bg-gray-50" : "";
        const hi = ev.imageUrl && ev.imageUrl !== "";
        let ti, pg;
        switch (ev.type) {
          case "Seminar":
            ti = "fa-chalkboard-user";
            pg = "from-[#800000] to-[#A52A2A]";
            break;
          case "Workshop":
            ti = "fa-toolbox";
            pg = "from-[#A52A2A] to-[#8B0000]";
            break;
          case "Meeting":
            ti = "fa-users";
            pg = "from-[#D49300] to-[#8B6914]";
            break;
          case "Sports":
            ti = "fa-futbol";
            pg = "from-[#005B9F] to-[#003B71]";
            break;
          case "Health":
            ti = "fa-heart-pulse";
            pg = "from-[#8B0000] to-[#600000]";
            break;
          case "Training":
            ti = "fa-graduation-cap";
            pg = "from-[#005B9F] to-[#003B71]";
            break;
          case "Celebration":
            ti = "fa-cake-candles";
            pg = "from-[#F2A900] to-[#D49300]";
            break;
          case "Outreach":
            ti = "fa-hand-holding-heart";
            pg = "from-[#003B71] to-[#005B9F]";
            break;
          case "Environmental":
            ti = "fa-leaf";
            pg = "from-[#001F3F] to-[#003B71]";
            break;
          case "Cultural":
            ti = "fa-masks-theater";
            pg = "from-[#F2A900] to-[#D49300]";
            break;
          case "Fundraising":
            ti = "fa-sack-dollar";
            pg = "from-[#A52A2A] to-[#800000]";
            break;
          default:
            ti = "fa-calendar-check";
            pg = "from-[#003B71] to-[#005B9F]";
        }
        const is = hi
          ? `<div class="relative h-40 overflow-hidden"><img src="${ev.imageUrl}" alt="${esc(ev.title)}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 pointer-events-none ${dateStatus.ended ? "grayscale" : ""}"><div class="absolute top-3 left-3"><span class="inline-flex items-center space-x-1 text-[10px] font-bold uppercase tracking-wider event-type-badge text-white px-2.5 py-1 rounded-full pointer-events-none"><i class="fa-solid ${ti} text-[#F2A900] text-[10px]"></i><span>${ev.type || "Event"}</span></span></div>${dateBadge ? `<div class="absolute top-3 right-3 pointer-events-none">${dateBadge}</div>` : ""}</div>`
          : `<div class="relative h-40 bg-gradient-to-br ${pg} flex items-center justify-center overflow-hidden ${dateStatus.ended ? "grayscale" : ""}"><i class="fa-solid ${ti} text-white/30 text-6xl pointer-events-none"></i><div class="absolute top-3 left-3"><span class="inline-flex items-center space-x-1 text-[10px] font-bold uppercase tracking-wider event-type-badge text-white px-2.5 py-1 rounded-full pointer-events-none"><i class="fa-solid ${ti} text-[#F2A900] text-[10px]"></i><span>${ev.type || "Event"}</span></span></div>${dateBadge ? `<div class="absolute top-3 right-3 pointer-events-none">${dateBadge}</div>` : ""}</div>`;
        let ab = "";
        if (isComp) ab = eventCompletedButtonHtml();
        else if (dateStatus.ended) ab = eventEndedButtonHtml();
        else if (isReg)
          ab = eventCancelButtonHtml(
            `handleUnregisterClick(event,'${id}','${esc(ev.title)}')`,
          );
        else
          ab = eventJoinButtonHtml(
            `handleRegisterClick(event,'${id}','${esc(ev.title)}','${dd}','${td}','${esc(ev.location)}')`,
          );
        html += `<div class="bg-white rounded-md border border-gray-200 shadow-sm hover:shadow-lg transition-all overflow-hidden flex flex-col${endedCardClass}"><div onclick="openEventDetails('${esc(ev.title)}','${dd}','${td}','${esc(ev.location)}','${esc(ev.desc || "")}')" class="cursor-pointer group">${is}<div class="p-4 pb-2"><h3 class="text-sm font-bold text-gray-900 group-hover:text-[#F2A900] transition-colors line-clamp-2 leading-snug mb-2">${ev.title || "Untitled Event"}</h3><div class="space-y-2"><div class="flex items-center space-x-1.5 text-xs text-[#353535]-500"><i class="fa-solid fa-calendar text-[#353535] w-4"></i><span class="font-medium text-[#353535]">${dd}</span>${td ? `<span class="text-[#353535]-800">| ${td}</span>` : ""}</div><div class="flex items-center space-x-1.5 text-xs text-gray-500"><i class="fa-solid fa-location-dot text-[#353535] w-4"></i><span class="font-medium text-[#353535] truncate">${ev.location || "TBA"}</span></div></div></div></div><div class="px-4 pb-4 pt-3 border-t border-gray-100 mt-auto">${ab}</div></div>`;
      });
      grid.innerHTML = html;
    },
  );
}

function renderMyEvents() {
  const grid = document.getElementById("my-events-grid");
  if (!grid) return;
  if (
    !loggedInUser ||
    (registeredEventIds.size === 0 && completedEventIds.size === 0)
  ) {
    grid.innerHTML =
      '<div class="col-span-full text-center py-16 bg-white rounded-md border shadow-sm"><p class="text-base text-gray-400">No registered events.</p></div>';
    return;
  }
  getDocs(collection(db, "events")).then(
    (snap) => {
      const myEvents = [];
      snap.forEach((d) => {
        const id = d.id;
        if (!registeredEventIds.has(id) && !completedEventIds.has(id)) return;
        myEvents.push({ id: d.id, ...d.data() });
      });

      if (!myEvents.length) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-16 bg-white rounded-md border shadow-sm"><p class="text-base text-gray-400">No active records.</p></div>';
        return;
      }

      const sortedEvents = sortEvents(myEvents);
      let html = "";
      sortedEvents.forEach((ev) => {
        const id = ev.id;
        const esc = (t) => {
          const div = document.createElement("div");
          div.textContent = t || "";
          return div.innerHTML.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        };
        const isComp = completedEventIds.has(id),
          dateStatus = getEventDateStatus(ev.date, ev.time),
          dateBadge = eventDateBadgeHtml(ev.date, ev.time),
          endedCardClass = dateStatus.ended ? " opacity-75 bg-gray-50" : "";
        const sb = isComp
          ? '<span class="event-btn-completed inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full"><i class="fa-solid fa-circle-check text-[9px]"></i><span>Completed</span></span>'
          : dateStatus.ended
            ? '<span class="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600"><i class="fa-solid fa-flag-checkered text-[9px]"></i><span>Ended</span></span>'
            : '<span class="event-badge-registered inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full"><i class="fa-solid fa-clock text-[9px]"></i><span>Registered</span></span>';
        const cb = !isComp && !dateStatus.ended
          ? eventCancelButtonHtml(
            `handleUnregisterClick(event,'${id}','${esc(ev.title)}')`,
            "mt-2",
          )
          : "";
        let ti, pg;
        switch (ev.type) {
          case "Seminar":
            ti = "fa-chalkboard-user";
            pg = "from-[#800000] to-[#A52A2A]";
            break;
          case "Workshop":
            ti = "fa-toolbox";
            pg = "from-[#A52A2A] to-[#8B0000]";
            break;
          case "Meeting":
            ti = "fa-users";
            pg = "from-[#D49300] to-[#8B6914]";
            break;
          case "Sports":
            ti = "fa-futbol";
            pg = "from-[#005B9F] to-[#003B71]";
            break;
          case "Health":
            ti = "fa-heart-pulse";
            pg = "from-[#8B0000] to-[#600000]";
            break;
          case "Training":
            ti = "fa-graduation-cap";
            pg = "from-[#005B9F] to-[#003B71]";
            break;
          case "Celebration":
            ti = "fa-cake-candles";
            pg = "from-[#F2A900] to-[#D49300]";
            break;
          case "Outreach":
            ti = "fa-hand-holding-heart";
            pg = "from-[#003B71] to-[#005B9F]";
            break;
          case "Environmental":
            ti = "fa-leaf";
            pg = "from-[#001F3F] to-[#003B71]";
            break;
          case "Cultural":
            ti = "fa-masks-theater";
            pg = "from-[#F2A900] to-[#D49300]";
            break;
          case "Fundraising":
            ti = "fa-sack-dollar";
            pg = "from-[#A52A2A] to-[#800000]";
            break;
          default:
            ti = "fa-calendar-check";
            pg = "from-[#003B71] to-[#005B9F]";
        }
        const hi = ev.imageUrl && ev.imageUrl !== "";
        const is = hi
          ? `<div class="relative h-32 overflow-hidden"><img src="${ev.imageUrl}" alt="${esc(ev.title)}" loading="lazy" decoding="async" class="w-full h-full object-cover pointer-events-none ${dateStatus.ended ? "grayscale" : ""}"><div class="absolute top-2 left-2"><span class="inline-flex items-center space-x-1 text-[10px] font-bold uppercase tracking-wider event-type-badge text-white px-2 py-0.5 rounded-full"><i class="fa-solid ${ti} text-[#F2A900] text-[9px]"></i><span>${ev.type || "Event"}</span></span></div>${dateBadge ? `<div class="absolute top-2 right-2">${dateBadge}</div>` : ""}</div>`
          : `<div class="relative h-32 bg-gradient-to-br ${pg} flex items-center justify-center overflow-hidden ${dateStatus.ended ? "grayscale" : ""}"><i class="fa-solid ${ti} text-white/30 text-5xl"></i><div class="absolute top-2 left-2"><span class="inline-flex items-center space-x-1 text-[10px] font-bold uppercase tracking-wider event-type-badge text-white px-2 py-0.5 rounded-full"><i class="fa-solid ${ti} text-[#F2A900] text-[9px]"></i><span>${ev.type || "Event"}</span></span></div>${dateBadge ? `<div class="absolute top-2 right-2">${dateBadge}</div>` : ""}</div>`;
        html += `<div class="bg-white rounded-md border border-gray-200 shadow-sm hover:shadow-lg transition-all overflow-hidden flex flex-col${endedCardClass}"><div onclick="openEventDetails('${esc(ev.title)}','${ev.date || "TBA"}','${ev.time ? formatTimeDisplay(ev.time) : ""}','${esc(ev.location)}','${esc(ev.desc || "")}')" class="cursor-pointer group">${is}<div class="p-4 pb-2"><div class="flex items-center justify-between mb-2"><h3 class="text-sm font-bold text-gray-900 group-hover:text-[#F2A900] transition-colors line-clamp-1 leading-snug flex-1 mr-2">${ev.title || "Untitled Event"}</h3>${sb}</div><div class="space-y-1.5"><div class="flex items-center space-x-1.5 text-xs text-[#353535]"><i class="fa-solid fa-calendar text-[#D49300] w-4"></i><span class="font-semibold text-[#353535]">${ev.date || "TBA"}</span>${ev.time ? `<span class="font-medium text-[#353535]">| ${formatTimeDisplay(ev.time)}</span>` : ""}</div><div class="flex items-center space-x-1.5 text-xs text-[#353535]"><i class="fa-solid fa-location-dot text-[#D49300] w-4"></i><span class="font-semibold text-[#353535] truncate">${ev.location || "TBA"}</span></div></div></div></div>${cb ? `<div class="px-4 pb-4">${cb}</div>` : ""}</div>`;
      });
      grid.innerHTML = html;
    },
  );
}

// ===== EVENT OPERATIONS =====
window.confirmJoinEvent = function (eid, et, ed, etm, el) {
  if (!loggedInUser) {
    window.showAlert("Error", "Please login.", "error");
    return;
  }
  if (getEventDateStatus(ed, etm).ended) {
    window.showAlert(
      "Event Ended",
      "Registration is closed because this event has reached its scheduled date and time.",
      "warning",
    );
    return;
  }
  if (registeredEventIds.has(eid) || completedEventIds.has(eid)) {
    window.showAlert("Already Registered", "", "error");
    return;
  }
  let msg = `Join: "${et}"?`;
  if (ed) msg += `\nDate: ${ed}`;
  if (etm) msg += `\nTime: ${etm}`;
  if (el) msg += `\nLocation: ${el}`;
  window.showConfirmPopup("Join Event?", msg, async () => {
    await performJoinEvent(eid, et);
  });
};

async function performJoinEvent(eid, et) {
  showLoading("Joining...");
  try {
    // Re-check the live event document so an expired event cannot be joined
    // through a stale card or a direct function call.
    const liveEvent = await getDoc(doc(db, "events", eid));
    if (
      liveEvent.exists() &&
      getEventDateStatus(liveEvent.data().date, liveEvent.data().time).ended
    ) {
      hideLoading();
      window.showAlert(
        "Event Ended",
        "Registration is closed because this event has reached its scheduled date and time.",
        "warning",
      );
      renderEvents();
      return;
    }

    const snap = await getDocs(
      query(
        collection(db, "participants"),
        where("residentId", "==", loggedInUser.id),
        where("eventId", "==", eid),
        limit(1),
      ),
    );
    if (!snap.empty) {
      let found = false;
      snap.forEach((d) => {
        if (
          d.data().status === STATUS.REGISTERED ||
          d.data().status === STATUS.COMPLETED
        )
          found = true;
      });
      if (found) {
        hideLoading();
        window.showAlert("Already Registered", "", "error");
        return;
      }
    }
    await addDoc(collection(db, "participants"), {
      residentId: loggedInUser.id,
      residentName: loggedInUser.name,
      residentEmail: loggedInUser.email,
      eventTitle: et,
      eventId: eid,
      timestamp: serverTimestamp(),
      status: STATUS.REGISTERED,
    });
    registeredEventIds.add(eid);
    sessionStorage.setItem(
      "registeredEvents",
      JSON.stringify([...registeredEventIds]),
    );
    renderEvents();
    renderMyEvents();
    hideLoading();
    window.showAlert("Success!", `Registered for "${et}".`, "success");
  } catch (e) {
    hideLoading();
    window.showAlert("Error", "Failed to register.", "error");
  }
}

window.unregisterFromEvent = function (eid, et) {
  if (!loggedInUser) return;
  window.showConfirmPopup("Cancel?", `Unregister from "${et}"?`, async () => {
    showLoading("Cancelling...");
    try {
      const snap = await getDocs(
        query(
          collection(db, "participants"),
          where("residentId", "==", loggedInUser.id),
          where("eventId", "==", eid),
          where("status", "==", STATUS.REGISTERED),
          limit(1),
        ),
      );
      if (!snap.empty) {
        const p = [];
        snap.forEach((d) =>
          p.push(
            updateDoc(doc(db, "participants", d.id), {
              status: STATUS.CANCELLED,
              cancelledAt: serverTimestamp(),
            }),
          ),
        );
        await Promise.all(p);
      }
      registeredEventIds.delete(eid);
      sessionStorage.setItem(
        "registeredEvents",
        JSON.stringify([...registeredEventIds]),
      );
      renderEvents();
      renderMyEvents();
      hideLoading();
      window.showAlert("Cancelled", "Unregistered.", "success");
    } catch (e) {
      hideLoading();
      window.showAlert("Error", "Failed.", "error");
    }
  });
};

eventsUnsubscribe = onSnapshot(
  collection(db, "events"),
  () => {
    renderEvents();
    renderPublicEvents();
    if (loggedInUser) {
      renderDashboardAgenda();
      renderMyEvents();
    }
  },
);

// ===== DONATIONS & HOURS =====
// Community Donations: shows CONFIRMED donations only (pending/rejected are
// visible to the donor in their personal "My Donations" history instead).
// The Amount/Item column was removed for privacy — only donor, type, purpose,
// and status are shown publicly.
onSnapshot(
  query(collection(db, "donations"), orderBy("createdAt", "desc")),
  (snap) => {
    const tbody = document.getElementById("public-donations-tbody");
    if (!tbody) return;

    let html = "";
    snap.forEach((donationDoc) => {
      const data = donationDoc.data();

      // Only confirmed/approved donations are displayed publicly.
      if (effectiveStatus(data) !== STATUS.APPROVED) return;

      const donationType = String(data.donationType || "Php").toLowerCase();
      const typeDisplay = donationType === "item" ? "Item" : "Php";
      const statusBadge =
        '<span class="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-800"><i class="fa-solid fa-circle-check"></i>Confirmed</span>';

      html += `<tr class="border-b border-gray-100 hover:bg-emerald-50/40 transition-colors">
          <td class="px-3 py-3 font-bold text-xs text-gray-800">${escapeAnnouncementHtml(data.donorName || "Anonymous")}</td>
          <td class="px-3 py-3 text-xs text-gray-600">${typeDisplay}</td>
          <td class="px-3 py-3 text-xs text-gray-600">${escapeAnnouncementHtml(data.purpose || "General support")}</td>
          <td class="px-3 py-3">${statusBadge}</td>
      </tr>`;
    });

    tbody.innerHTML =
      html ||
      '<tr><td colspan="4" class="text-center py-6 text-xs text-gray-400"><i class="fa-solid fa-hand-holding-heart text-xl block mb-2 text-gray-300"></i>No confirmed donations yet.</td></tr>';
  },
  (err) => {
    console.error("Community donations listener error:", err);
    const tbody = document.getElementById("public-donations-tbody");
    if (tbody)
      tbody.innerHTML =
        '<tr><td colspan="4" class="text-center py-6 text-xs text-gray-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Could not load community donations. Check your connection and refresh.</td></tr>';
  },
);

function initUserHourTracker() {
  if (!loggedInUser?.id) return;
  dashboardServiceHours = 0;
  if (hoursUnsubscribe) hoursUnsubscribe();
  hoursUnsubscribe = onSnapshot(
    query(
      collection(db, "service_hours"),
      where("residentId", "==", loggedInUser.id),
    ),
    (snap) => {
      const tbody = document.getElementById("user-hours-tbody"),
        display = document.getElementById("total-hours-display");
      if (!tbody || !display) return;
      let html = "",
        total = 0;
      snap.forEach((d) => {
        const data = d.data();
        // REJECTION BUG FIX: normalized status comparison.
        const st = effectiveStatus(data);
        if (st === STATUS.APPROVED) total += parseFloat(data.hours || 0);
        let badge =
          st === STATUS.APPROVED
            ? '<span class="text-[10px] rounded-full px-2 py-0.5 font-normal text-emerald-800">✓ Approved</span>'
            : st === STATUS.REJECTED
              ? '<span class="text-[10px] rounded-full px-2 py-0.5 font-normal text-red-800">✗ Rejected</span>'
              : '<span class="text-[10px] rounded-full px-2 py-0.5 font-normal text-amber-800">Pending</span>';
        html += `<tr class="border-b"><td class="px-3 py-2 text-xs">${data.eventTitle || "Community Service"}</td><td class="px-3 py-2 text-xs font-bold">${data.hours || 0} hrs</td><td class="px-3 py-2">${badge}</td></tr>`;
      });
      tbody.innerHTML =
        html ||
        '<tr><td colspan="3" class="text-center py-4 text-xs text-gray-400">No hours recorded yet.</td></tr>';
      display.innerText = `${total} Hours`;
      dashboardServiceHours = total;
      refreshDashboardOverview(false);
    },
    (err) => {
      console.error("Service hours listener error:", err);
      const tbody = document.getElementById("user-hours-tbody");
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="3" class="text-center py-4 text-xs text-gray-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Could not load service hours. Check your connection and refresh.</td></tr>';
    },
  );
}

// ===== VOLUNTEER FORM =====
document
  .getElementById("volunteer-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!loggedInUser) {
      window.showAlert("Error", "Please login first.", "error");
      return;
    }
    const skills = document.getElementById("vol-skills")?.value || "",
      availability = document.getElementById("vol-avail")?.value || "",
      experience = document.getElementById("vol-experience")?.value || "",
      notes = document.getElementById("vol-notes")?.value.trim() || "";
    if (!skills) {
      window.showAlert("Error", "Select your primary skill.", "error");
      return;
    }
    if (!availability) {
      window.showAlert("Error", "Select your availability.", "error");
      return;
    }
    if (!selectedSkillVerificationFile) {
      window.showAlert("Error", "Upload proof of your skill.", "error");
      return;
    }
    showLoading("Submitting...");
    try {
      let vd = null;
      if (selectedSkillVerificationFile)
        vd = await convertFileToBase64(selectedSkillVerificationFile);
      await addDoc(collection(db, "volunteers"), {
        residentId: loggedInUser.id,
        name: loggedInUser.name,
        email: loggedInUser.email,
        skills,
        experience,
        verificationFile: vd
          ? {
            fileName: selectedSkillVerificationFile.name,
            fileType: selectedSkillVerificationFile.type,
            fileSize: selectedSkillVerificationFile.size,
            data: vd,
            uploadedAt: new Date().toISOString(),
          }
          : null,
        notes,
        availability,
        createdAt: serverTimestamp(),
        status: STATUS.PENDING,
      });
      hideLoading();
      document.getElementById("volunteer-form")?.reset();
      removeSkillVerification();
      window.showAlert(
        "Application Submitted!",
        "Your volunteer application has been submitted for review.",
        "success",
      );
    } catch (err) {
      hideLoading();
      window.showAlert("Error", "Failed to submit.", "error");
    }
  });

window.handleSkillVerificationUpload = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  if (
    ![
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ].includes(file.type)
  ) {
    window.showAlert("Error", "Invalid file type.", "error");
    event.target.value = "";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    window.showAlert("Error", "File < 5MB.", "error");
    event.target.value = "";
    return;
  }
  selectedSkillVerificationFile = file;
  const ph = document.getElementById("skill-upload-placeholder"),
    pv = document.getElementById("skill-upload-preview"),
    fn = document.getElementById("skill-file-name"),
    fs = document.getElementById("skill-file-size"),
    dz = document.getElementById("skill-verification-dropzone");
  if (ph) ph.classList.add("hidden");
  if (pv) pv.classList.remove("hidden");
  if (fn) fn.textContent = file.name;
  if (fs) {
    const sk = (file.size / 1024).toFixed(1),
      sm = (file.size / (1024 * 1024)).toFixed(1);
    fs.textContent = file.size > 1024 * 1024 ? `${sm} MB` : `${sk} KB`;
  }
  if (dz) {
    dz.classList.add("border-emerald-500", "bg-emerald-50");
    dz.classList.remove("border-gray-300");
  }
};

window.removeSkillVerification = function () {
  selectedSkillVerificationFile = null;
  const inp = document.getElementById("skill-verification-input"),
    ph = document.getElementById("skill-upload-placeholder"),
    pv = document.getElementById("skill-upload-preview"),
    dz = document.getElementById("skill-verification-dropzone");
  if (inp) inp.value = "";
  if (ph) ph.classList.remove("hidden");
  if (pv) pv.classList.add("hidden");
  if (dz) {
    dz.classList.remove("border-emerald-500", "bg-emerald-50");
    dz.classList.add("border-gray-300");
  }
};

function convertFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===== DONATION FORM =====
// ===== DONATION TYPE SWITCHING =====
window.switchDonationType = function (type) {
  const isMoney = type === "money";
  const moneyTab = document.getElementById("donation-type-money");
  const itemTab = document.getElementById("donation-type-item");
  const moneyForm = document.getElementById("donation-money-form");
  const itemForm = document.getElementById("donation-item-form");
  // const hint = document.getElementById("donation-type-hint");
  const activeCls =
    "donation-type-btn is-active flex-1 py-2 px-3 rounded-md text-xs font-bold transition-all";
  const idleCls =
    "donation-type-btn flex-1 py-2 px-3 rounded-md text-xs font-bold transition-all";

  function paint(btn, active) {
    if (!btn) return;
    btn.className = active ? activeCls : idleCls;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.style.background = active ? "#ffffff" : "transparent";
    btn.style.color = active ? "#001F3F" : "#64748B";
    btn.style.boxShadow = active
      ? "0 2px 8px rgba(0,31,63,0.16), 0 1px 2px rgba(0,31,63,0.08)"
      : "none";
    const icon = btn.querySelector("i");
    if (icon) icon.style.color = active ? "#003B71" : "#64748B";
  }

  paint(moneyTab, isMoney);
  paint(itemTab, !isMoney);
  if (moneyForm) moneyForm.classList.toggle("hidden", !isMoney);
  if (itemForm) itemForm.classList.toggle("hidden", isMoney);
  // if (hint) {
  //   hint.textContent = isMoney
  //     ? "Active: Money donation"
  //     : "Active: Item donation";
  // }
};

// ===== SET DONATION AMOUNT =====
window.setDonationAmount = function (amount) {
  const inp = document.getElementById("don-amount");
  if (inp) {
    inp.value = amount;
  }
};

// ===== MONEY DONATION FORM =====
document
  .getElementById("donation-money-form")
  ?.addEventListener("submit", async function (e) {
    e.preventDefault();

    if (!loggedInUser) {
      window.showAlert("Error", "Please login.", "error");
      return;
    }

    const amount = parseFloat(
      document.getElementById("don-amount")?.value || 0,
    );
    const purpose =
      document.getElementById("don-money-purpose")?.value.trim() || "";

    if (!amount || amount <= 0 || isNaN(amount)) {
      window.showAlert("Error", "Please enter a valid amount.", "error");
      return;
    }

    if (!purpose) {
      window.showAlert(
        "Error",
        "Please enter a purpose for your donation.",
        "error",
      );
      return;
    }

    // Open payment modal for money donation
    window.openPaymentModal(
      `₱${amount.toLocaleString()}`,
      purpose,
      "money",
      amount,
    );
  });

// ===== ITEM DONATION FORM =====
document
  .getElementById("donation-item-form")
  ?.addEventListener("submit", async function (e) {
    e.preventDefault();

    if (!loggedInUser) {
      window.showAlert("Error", "Please login.", "error");
      return;
    }

    const itemDescription =
      document.getElementById("don-item-description")?.value.trim() || "";
    const itemValue = parseFloat(
      document.getElementById("don-item-value")?.value || 0,
    );
    const purpose =
      document.getElementById("don-item-purpose")?.value.trim() || "";
    // CATEGORIZED ITEMS: category + quantity are now captured with every
    // item donation so history shows exactly what and how much was given.
    const itemCategory =
      document.getElementById("don-item-category")?.value || "";
    const itemQuantity = parseInt(
      document.getElementById("don-item-qty")?.value || "0",
      10,
    );
    const itemUnit =
      document.getElementById("don-item-unit")?.value.trim() || "";

    if (!itemCategory) {
      window.showAlert(
        "Error",
        "Please select a category for your item donation.",
        "error",
      );
      return;
    }

    if (!itemQuantity || itemQuantity < 1 || isNaN(itemQuantity)) {
      window.showAlert(
        "Error",
        "Please enter a valid quantity (at least 1).",
        "error",
      );
      return;
    }

    if (!itemDescription) {
      window.showAlert(
        "Error",
        "Please describe the items you're donating.",
        "error",
      );
      return;
    }

    if (!purpose) {
      window.showAlert(
        "Error",
        "Please enter a purpose for your donation.",
        "error",
      );
      return;
    }

    // Show loading
    window.showLoading("Submitting donation...");

    try {
      // Save item donation directly (no payment needed)
      const donationData = {
        donorName: loggedInUser.name || "Anonymous",
        donorId: loggedInUser.id || "",
        donationType: "item",
        itemDescription: itemDescription,
        itemCategory: itemCategory,
        itemQuantity: itemQuantity,
        itemUnit: itemUnit || null,
        itemValue: itemValue > 0 ? itemValue : null,
        purpose: purpose,
        status: STATUS.PENDING,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, "donations"), donationData);

      // Reset form
      document.getElementById("donation-item-form").reset();

      window.hideLoading();
      window.showAlert(
        "Thank You!",
        "Your item donation has been submitted for review. The municipality will contact you for pickup or drop-off details.",
        "success",
      );
    } catch (error) {
      window.hideLoading();
      window.showAlert(
        "Error",
        "Failed to submit donation. Please try again.",
        "error",
      );
      console.error("Item donation error:", error);
    }
  });

// ===== BREADCRUMBS (navigation history per section) =====
const TAB_LABELS = {
  home: { label: "Home", icon: "fa-house" },
  announcements: { label: "Announcements", icon: "fa-bullhorn" },
  events: { label: "Community Events", icon: "fa-calendar-days" },
  "my-events": { label: "My Events", icon: "fa-calendar-check" },
  volunteers: { label: "Volunteers", icon: "fa-hands-holding" },
  hours: { label: "Service Hours", icon: "fa-clock" },
  donations: { label: "Donations", icon: "fa-hand-holding-heart" },
  profile: { label: "Profile", icon: "fa-user" },
  notifications: { label: "Notifications", icon: "fa-bell" },
};

let breadcrumbTrail = [];
try {
  breadcrumbTrail = JSON.parse(
    sessionStorage.getItem("breadcrumbTrail") || "[]",
  ).filter((id) => TAB_LABELS[id]);
} catch (e) {
  breadcrumbTrail = [];
}

function updateBreadcrumbs(tabId) {
  if (!TAB_LABELS[tabId]) return;
  // Maintain a browsing trail: revisiting a section trims the trail back to
  // that entry (classic breadcrumb history behavior).
  const existingIdx = breadcrumbTrail.indexOf(tabId);
  if (existingIdx !== -1) {
    breadcrumbTrail = breadcrumbTrail.slice(0, existingIdx + 1);
  } else {
    breadcrumbTrail.push(tabId);
  }
  // "home" is always the root of the trail.
  breadcrumbTrail = breadcrumbTrail.filter((id) => id !== "home");
  breadcrumbTrail.unshift("home");
  // Cap the visible history at the last 4 sections after Home.
  if (breadcrumbTrail.length > 5)
    breadcrumbTrail = ["home", ...breadcrumbTrail.slice(-4)];
  try {
    sessionStorage.setItem("breadcrumbTrail", JSON.stringify(breadcrumbTrail));
  } catch (e) { }
  renderBreadcrumbs(tabId);
}

function renderBreadcrumbs(activeTabId) {
  const bar = document.getElementById("breadcrumb-bar");
  if (!bar) return;
  const parts = breadcrumbTrail.map((id, idx) => {
    const info = TAB_LABELS[id];
    const isLast = idx === breadcrumbTrail.length - 1;
    const sep =
      idx > 0
        ? '<i class="fa-solid fa-chevron-right breadcrumb-sep" aria-hidden="true"></i>'
        : "";
    if (isLast && id === activeTabId) {
      return `${sep}<span class="breadcrumb-item is-current" aria-current="page"><i class="fa-solid ${info.icon}"></i>${info.label}</span>`;
    }
    return `${sep}<button type="button" class="breadcrumb-item" onclick="switchTab('${id}')" title="Go back to ${info.label}"><i class="fa-solid ${info.icon}"></i>${info.label}</button>`;
  });
  bar.innerHTML = `<nav aria-label="Breadcrumb" class="breadcrumb-nav">${parts.join("")}</nav>`;
  bar.classList.remove("hidden");
}

// ===== TAB SWITCHER =====
window.switchTab = function (tabId) {
  closeAllHeaderDropdowns();
  closeMobileMenu();
  const nd = document.getElementById("notification-dropdown");
  if (nd && !nd.classList.contains("hidden")) {
    nd.classList.add("hidden");
    showingAllNotifications = false;
  }
  const mnd = document.getElementById("mobile-notification-dropdown");
  if (mnd && !mnd.classList.contains("hidden")) {
    mnd.classList.add("hidden");
    mobileShowingAllNotifications = false;
  }
  if (isTabSwitching) return;
  isTabSwitching = true;
  showLoading("Loading...");
  setTimeout(() => {
    document
      .querySelectorAll(".tab-content")
      .forEach((el) => el.classList.add("hidden"));
    const target = document.getElementById(tabId);
    if (target) target.classList.remove("hidden");
    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.className =
        "nav-link w-full flex items-center space-x-2 px-3 py-2 rounded-md text-[11px] text-gray-300 transition-all";
    });
    const activeBtn = Array.from(document.querySelectorAll(".nav-link")).find(
      (b) => b.getAttribute("onclick")?.includes(tabId),
    );
    if (activeBtn)
      activeBtn.className =
        "nav-link w-full flex items-center space-x-2 px-3 py-2 rounded-md text-[11px] bg-tsu-dark text-tsu-gold border border-tsu-gold/20 shadow-lg";
    saveActiveTab(tabId);
    updateBreadcrumbs(tabId);
    if (tabId === "home") refreshDashboardOverview(true);
    if (tabId === "my-events") renderMyEvents();
    if (tabId === "profile" && loggedInUser) {
      setTimeout(() => {
        disableAllProfileFields();
        document.getElementById("cancel-edit-btn")?.classList.add("hidden");
      }, 100);
    }
    setTimeout(() => {
      hideLoading();
      isTabSwitching = false;
    }, 300);
  }, 600);
};

window.openEventDetails = function (title, date, time, location, desc) {
  const mT = document.getElementById("modal-event-title"),
    mD = document.getElementById("modal-event-date"),
    mL = document.getElementById("modal-event-location"),
    mDesc = document.getElementById("modal-event-desc");
  if (mT) mT.innerText = title;
  let dd = `Date: ${date || "TBA"}`;
  if (time) dd += ` at ${time}`;
  const dateStatusBadge = eventDateBadgeHtml(date, time);
  if (mD)
    mD.innerHTML = `<i class="fa-solid fa-calendar mr-1.5"></i><span>${dd}</span>${dateStatusBadge ? `<span class="ml-auto">${dateStatusBadge}</span>` : ""}`;
  if (mL)
    mL.innerHTML = `<i class="fa-solid fa-location-dot mr-1.5"></i>Location: ${location || "TBA"}`;
  if (mDesc) mDesc.innerHTML = desc;
  window.toggleModal("view-event-modal");
};

window.toggleModal = function (modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.toggle("hidden");
};

// ===== INITIALIZATION =====
document.addEventListener("DOMContentLoaded", () => {
  startDashboardClock();
  disableNativeFormValidation();
  window.updateRegisterConsentState();
  if (document.getElementById("donation-type-money")) {
    window.switchDonationType("money");
  }
  setupPhoneRestrictions();
  hideNotificationBell();
  renderPublicEvents();
  closeAllHeaderDropdowns();

  document.addEventListener("click", function (e) {
    const triggers = document.querySelectorAll(".header-dropdown-trigger");
    let inside = false;
    triggers.forEach((t) => {
      if (t.contains(e.target)) inside = true;
    });
    if (!inside) closeAllHeaderDropdowns();
    const tBtn = e.target.closest(".header-dropdown-trigger > button");
    if (tBtn) {
      e.preventDefault();
      e.stopPropagation();
      const p = tBtn.parentElement,
        d = p.querySelector(".header-dropdown");
      const isOpen = d && d.classList.contains("show");
      closeAllHeaderDropdowns();
      if (d && !isOpen) d.classList.add("show");
    }
    const dLink = e.target.closest(".header-dropdown button");
    if (dLink) setTimeout(() => closeAllHeaderDropdowns(), 100);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeAllHeaderDropdowns();
      closeMobileMenu();
      const authOverlay = document.getElementById("auth-form-overlay");
      if (authOverlay && !authOverlay.classList.contains("hidden")) {
        window.closeAuthPanels();
      }
      const nd = document.getElementById("notification-dropdown");
      if (nd && !nd.classList.contains("hidden")) {
        nd.classList.add("hidden");
        showingAllNotifications = false;
      }
      window.closeNotificationDetail();
    }
  });
  document
    .getElementById("notification-detail-modal")
    ?.addEventListener("click", function (e) {
      if (e.target === this) window.closeNotificationDetail();
    });

  const mobileOverlay = document.getElementById("mobile-overlay");
  if (mobileOverlay)
    mobileOverlay.addEventListener("click", () => window.toggleMobileMenu());
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      const sidebar = document.getElementById("sidebar");
      if (
        sidebar &&
        sidebar.classList.contains("translate-x-0") &&
        window.innerWidth < 1024
      )
        window.toggleMobileMenu();
    });
  });
  window.addEventListener("resize", () => {
    const sidebar = document.getElementById("sidebar"),
      overlay = document.getElementById("mobile-overlay");
    if (window.innerWidth >= 1024 && sidebar) {
      sidebar.classList.remove("translate-x-0");
      sidebar.classList.add("-translate-x-full");
      if (overlay) overlay.classList.add("hidden");
      document.body.style.overflow = "";
    }
  });

  showBootLoader();
  showLoading("Securing session...");
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // LOGIN REFRESH BUG FIX: user.reload() is a network call — on slow
      // internet it used to throw and abort the whole session restore.
      // Retry with a buffer and, if it still fails, continue with the
      // locally cached auth state instead of breaking the refresh.
      try {
        await withRetryBuffer(() => user.reload(), {
          retries: 2,
          baseDelay: 1200,
          label: "auth reload",
        });
      } catch (reloadErr) {
        console.warn(
          "user.reload() failed (slow connection) — continuing with cached auth state.",
        );
      }
      if (!user.emailVerified) {
        clearUserSession();
        loggedInUser = null;
        stopSessionHeartbeat();
        // Signing out an unverified account must not hide/reset the login form.
        document.getElementById("auth-screen")?.classList.remove("hidden");
        document.getElementById("dashboard")?.classList.add("hidden");
        hideNotificationBell();
        await signOut(auth);
        hideLoading();
        hideBootLoader();
        return;
      }
      try {
        // LOGIN REFRESH BUG FIX: a single failed server read used to force a
        // sign-out, so refreshing the page on slow internet logged users out.
        // Now: (1) retry the server read with a backoff buffer, (2) fall back
        // to the local Firestore cache, and only give up if the profile truly
        // cannot be retrieved anywhere.
        let snap;
        try {
          snap = await withRetryBuffer(
            () => getDocFromServer(doc(db, "residents", user.uid)),
            { retries: 3, baseDelay: 1500, label: "profile restore" },
          );
        } catch (netErr) {
          console.warn(
            "Server profile read failed after retries, falling back to cache:",
            netErr?.code || netErr?.message,
          );
          try {
            snap = await getDoc(doc(db, "residents", user.uid));
          } catch (cacheErr) {
            snap = null;
          }
          if (!snap || !snap.exists()) {
            // Still nothing — keep the Firebase session alive (do NOT sign
            // out) so the next refresh with better signal restores it, but
            // show the login screen with a clear explanation for now.
            stopSessionHeartbeat();
            window.closeAuthPanels?.();
            document.getElementById("auth-screen")?.classList.remove("hidden");
            document.getElementById("dashboard")?.classList.add("hidden");
            hideNotificationBell();
            renderPublicEvents();
            hideLoading();
            hideBootLoader();
            window.showAlert(
              "Slow Connection",
              "We could not retrieve your account data right now. You are still signed in — please check your internet connection and refresh the page.",
              "error",
            );
            return;
          }
        }

        // A soft-deleted profile still exists, so also treat a MISSING
        // document as a hard delete and refuse the session.
        if (snap.exists()) {
          const ud = snap.data();
          // Refuse to restore a session for a disabled or archived account.
          if (isAccountDisabled(ud)) {
            const wasDeleted =
              ud.isDeleted === true || ud.accountStatus === "Deleted";
            clearUserSession();
            loggedInUser = null;
            stopSessionHeartbeat();
            await signOut(auth);
            window.closeAuthPanels?.();
            document.getElementById("auth-screen")?.classList.remove("hidden");
            document.getElementById("dashboard")?.classList.add("hidden");
            hideNotificationBell();
            renderPublicEvents();
            hideLoading();
            hideBootLoader();
            window.showAlert(
              wasDeleted ? "Account Deleted" : "Account Disabled",
              accountLockMessage(ud),
              "error",
            );
            return;
          }
          const ss = localStorage.getItem("barangayUser");
          if (ss) {
            try {
              const ps = JSON.parse(ss);
              if (!currentSessionToken && ud.sessionToken)
                currentSessionToken = ud.sessionToken;
            } catch (e) { }
          }
          loggedInUser = { id: snap.id, ...ud };
          saveUserSession(loggedInUser);
          const se = sessionStorage.getItem("registeredEvents");
          if (se)
            try {
              registeredEventIds = new Set(JSON.parse(se));
            } catch (e) {
              registeredEventIds = new Set();
            }
          const sc = sessionStorage.getItem("completedEvents");
          if (sc)
            try {
              completedEventIds = new Set(JSON.parse(sc));
            } catch (e) {
              completedEventIds = new Set();
            }
          window.closeAuthPanels();
          document.getElementById("auth-screen")?.classList.add("hidden");
          document.getElementById("dashboard")?.classList.remove("hidden");
          showNotificationBell();
          updateUIWithUserData(loggedInUser);
          await setUserStatus(loggedInUser.id, true);
          startSessionHeartbeat(loggedInUser.id);
          watchAccountStatus(loggedInUser.id);
          initUserHourTracker();
          await loadUserRegisteredEvents();
          setupParticipantsListener();
          initializeAllUserListeners();
          initNotificationsListener();
          // Restored session: re-point the weather card at this resident.
          window.updateWeatherLocation?.(true);
          renderEvents();
          hideBootLoader();
          setTimeout(() => window.switchTab(getSavedActiveTab()), 400);
        } else {
          clearUserSession();
          stopSessionHeartbeat();
          await signOut(auth);
          hideLoading();
          hideBootLoader();
        }
      } catch (e) {
        console.error("Session restore error:", e);
        hideLoading();
        hideBootLoader();
      }
    } else {
      clearUserSession();
      loggedInUser = null;
      stopSessionHeartbeat();
      // A failed/unverified login signs out too; keep the auth panel and
      // entered credentials visible. Successful login and explicit logout
      // already close the panel in their respective handlers.
      document.getElementById("auth-screen")?.classList.remove("hidden");
      document.getElementById("dashboard")?.classList.add("hidden");
      hideNotificationBell();
      renderPublicEvents();
      hideLoading();
      hideBootLoader();
    }
  });
});

window.addEventListener("beforeunload", () => {
  if (loggedInUser?.id) {
    sessionStorage.setItem(
      "registeredEvents",
      JSON.stringify([...registeredEventIds]),
    );
    sessionStorage.setItem(
      "completedEvents",
      JSON.stringify([...completedEventIds]),
    );
    setUserStatus(loggedInUser.id, false);
  }
  stopSessionHeartbeat();
  if (participantsUnsubscribe) participantsUnsubscribe();
  if (notificationsUnsubscribe) notificationsUnsubscribe();
  if (donationsUnsubscribe) donationsUnsubscribe();
  if (volunteersUnsubscribe) volunteersUnsubscribe();
  if (hoursUnsubscribe) hoursUnsubscribe();
});

// ===== LOGOUT =====
window.triggerLogoutConfirmation = function () {
  window.showConfirmPopup("Log Out", "Are you sure?", async () => {
    showLoading("Logging out...");
    stopSessionHeartbeat();
    if (loggedInUser?.id) {
      // setUserStatus already refuses to write to an archived/disabled
      // profile. Only clear the token when the account is still in good
      // standing, otherwise we would wipe the admin's revocation and let a
      // deleted account log back in.
      await setUserStatus(loggedInUser.id, false);
      try {
        const check = await getDocFromServer(
          doc(db, "residents", loggedInUser.id),
        );
        if (check.exists() && !isAccountDisabled(check.data())) {
          await updateDoc(doc(db, "residents", loggedInUser.id), {
            sessionToken: null,
            isOnline: false,
            lastActive: serverTimestamp(),
          });
        }
      } catch (e) { }
    }
    if (accountStatusUnsubscribe) {
      accountStatusUnsubscribe();
      accountStatusUnsubscribe = null;
    }
    await signOut(auth);
    clearUserSession();
    loggedInUser = null;
    currentSessionToken = null;
    document.getElementById("login-form")?.reset();
    document.getElementById("register-form")?.reset();
    window.closeAuthPanels();
    document.getElementById("auth-screen")?.classList.remove("hidden");
    document.getElementById("dashboard")?.classList.add("hidden");
    hideNotificationBell();
    renderPublicEvents();
    closeMobileMenu();
    if (alertTimeout) clearTimeout(alertTimeout);
    if (participantsUnsubscribe) participantsUnsubscribe();
    if (notificationsUnsubscribe) notificationsUnsubscribe();
    if (donationsUnsubscribe) donationsUnsubscribe();
    if (volunteersUnsubscribe) volunteersUnsubscribe();
    if (hoursUnsubscribe) hoursUnsubscribe();
    hideLoading();
    showLogoutBanner();
  });
};

function showLogoutBanner() {
  const eb = document.getElementById("logout-banner");
  if (eb) eb.remove();
  const b = document.createElement("div");
  b.id = "logout-banner";
  b.className =
    "fixed top-0 left-0 right-0 z-[300] transform -translate-y-full transition-transform duration-500 ease-in-out";
  b.innerHTML = `<div class="bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-6 py-4 shadow-2xl"><div class="max-w-4xl mx-auto flex items-center justify-between"><div class="flex items-center space-x-3"><div class="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center"><i class="fa-solid fa-circle-check text-white text-lg"></i></div><div><h3 class="font-extrabold text-sm">Successfully Logged Out</h3><p class="text-xs text-emerald-100 mt-0.5">You have been securely signed out.</p></div></div><button onclick="closeLogoutBanner()" class="text-white/80 hover:text-white p-1.5 rounded-md hover:bg-white/10"><i class="fa-solid fa-xmark text-sm"></i></button></div></div>`;
  document.body.appendChild(b);
  setTimeout(() => {
    b.classList.remove("-translate-y-full");
    b.classList.add("translate-y-0");
  }, 100);
  setTimeout(() => {
    closeLogoutBanner();
  }, 7000);
}

window.closeLogoutBanner = function () {
  const b = document.getElementById("logout-banner");
  if (b) {
    b.classList.add("-translate-y-full");
    b.classList.remove("translate-y-0");
    setTimeout(() => b.remove(), 500);
  }
};

// Replace the existing payment-modal-close event listener with this:

document
  .getElementById("payment-modal-close")
  ?.addEventListener("click", function (e) {
    // Prevent event bubbling
    e.preventDefault();
    e.stopPropagation();

    // Close any QR/proof overlay before resetting payment data
    window.closePaymentQrPopup?.();

    // Reset payment form data
    currentDonationData = null;
    selectedPaymentMethod = null;

    // Reset payment form
    const paymentForm = document.getElementById("payment-form");
    if (paymentForm) paymentForm.reset();

    // Remove selected class from payment method buttons
    document
      .querySelectorAll(".payment-method-btn")
      .forEach((b) => b.classList.remove("selected"));

    // Hide QR code container
    const qr = document.getElementById("qr-code-container");
    if (qr) qr.classList.add("hidden");

    // Hide cash password section, screenshot section and their confirm buttons
    const pwdSection = document.getElementById("payment-password-section");
    if (pwdSection) pwdSection.classList.add("hidden");
    const cashBtn = document.getElementById("payment-cash-confirm-btn");
    if (cashBtn) cashBtn.classList.add("hidden");
    const screenshotSection = document.getElementById(
      "payment-screenshot-section",
    );
    if (screenshotSection) screenshotSection.classList.add("hidden");
    const screenshotBtn = document.getElementById(
      "payment-submit-screenshot-btn",
    );
    if (screenshotBtn) screenshotBtn.classList.add("hidden");

    // Hide the modal directly
    const modal = document.getElementById("payment-modal");
    if (modal) {
      modal.classList.add("hidden");
    }

    // Restore body scroll
    document.body.style.overflow = "";
  });
document
  .getElementById("payment-modal")
  ?.addEventListener("click", function (e) {
    if (e.target === this) {
      window.closePaymentQrPopup?.();
      currentDonationData = null;
      selectedPaymentMethod = null;
      document.getElementById("payment-form")?.reset();
      document
        .querySelectorAll(".payment-method-btn")
        .forEach((b) => b.classList.remove("selected"));
      this.classList.add("hidden");
      const qr = document.getElementById("qr-code-container");
      if (qr) qr.classList.add("hidden");
      const pwdSection = document.getElementById("payment-password-section");
      if (pwdSection) pwdSection.classList.add("hidden");
      const cashBtn = document.getElementById("payment-cash-confirm-btn");
      if (cashBtn) cashBtn.classList.add("hidden");
      const screenshotSection = document.getElementById(
        "payment-screenshot-section",
      );
      if (screenshotSection) screenshotSection.classList.add("hidden");
      const screenshotBtn = document.getElementById(
        "payment-submit-screenshot-btn",
      );
      if (screenshotBtn) screenshotBtn.classList.add("hidden");
    }
  });

// ==================== ANTI-DEBUGGING & DEVELOPER TOOLS PROTECTION ====================
(function () {
  // Disable right-click context menu
  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    return false;
  });

  // Disable keyboard shortcuts for developer tools
  document.addEventListener("keydown", function (e) {
    // F12 key
    if (e.keyCode === 123) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+I (Chrome, Firefox Dev Tools)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 73) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+J (Chrome Console)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 74) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+C (Chrome Element Selector)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 67) {
      e.preventDefault();
      return false;
    }

    // Ctrl+U (View Source)
    if (e.ctrlKey && e.keyCode === 85) {
      e.preventDefault();
      return false;
    }

    // Ctrl+S (Save Page)
    if (e.ctrlKey && e.keyCode === 83) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+K (Firefox Console)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 75) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+E (Firefox Network Tab)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 69) {
      e.preventDefault();
      return false;
    }

    // F5 and Ctrl+R (Refresh - optional, might want to allow refresh)
    // if (e.keyCode === 116 || (e.ctrlKey && e.keyCode === 82)) {
    //     e.preventDefault();
    //     return false;
    // }
  });

  // Detect if Developer Tools is open using various methods
  function detectDevTools() {
    const threshold = 160;
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;

    // Method 1: Window size difference detection
    if (widthThreshold || heightThreshold) {
      handleDevToolsDetected();
    }

    // Method 2: Console.log timing detection
    const startTime = performance.now();
    debugger;
    const endTime = performance.now();

    if (endTime - startTime > 100) {
      handleDevToolsDetected();
    }

    // Method 3: Firefox specific detection
    if (window.devtools && window.devtools.open) {
      handleDevToolsDetected();
    }
  }

  // Method 4: Using requestAnimationFrame to detect console
  let devtoolsOpen = false;
  const element = new Image();
  Object.defineProperty(element, "id", {
    get: function () {
      devtoolsOpen = true;
      handleDevToolsDetected();
    },
  });

  setInterval(function () {
    devtoolsOpen = false;
    console.log("%c", element);
    if (devtoolsOpen) {
      handleDevToolsDetected();
    }
  }, 1000);

  // Method 5: Detect Firebug
  if (window.console && (window.console.firebug || window.console.exception)) {
    handleDevToolsDetected();
  }

  function handleDevToolsDetected() {
    // Clear console
    console.clear();

    // Show warning
    console.log(
      "%c⚠️ WARNING ⚠️",
      "color: red; font-size: 30px; font-weight: bold;",
    );
    console.log(
      "%cDeveloper tools detected!",
      "color: orange; font-size: 20px;",
    );
    console.log(
      "%cThis action has been logged and reported to the administrator.",
      "color: red; font-size: 14px;",
    );
    console.log(
      "%cPlease close developer tools immediately.",
      "color: orange; font-size: 14px;",
    );

    // Optional: Log the attempt
    if (typeof loggedInAdmin !== "undefined" && loggedInAdmin) {
      try {
        // You can add Firestore logging here if needed
        // addDoc(collection(db, 'security_logs'), { ... });
      } catch (e) { }
    }

    // Optional: Show modal warning
    showDevToolsWarning();
  }

  function showDevToolsWarning() {
    // Remove existing warning if any
    const existing = document.getElementById("devtools-warning");
    if (existing) existing.remove();

    const warningModal = document.createElement("div");
    warningModal.id = "devtools-warning";
    warningModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.9);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;

    warningModal.innerHTML = `
            <div style="
                background: white;
                border-radius: 20px;
                padding: 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
                box-shadow: 0 25px 50px rgba(0,0,0,0.5);
                animation: fadeInUp 0.3s ease-out;
            ">
                <div style="
                    width: 80px;
                    height: 80px;
                    background: #fee2e2;
                    color: #dc2626;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0 auto 20px;
                    font-size: 40px;
                ">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <h2 style="
                    color: #1f2937;
                    font-size: 24px;
                    font-weight: 800;
                    margin-bottom: 10px;
                ">⚠️ Security Warning</h2>
                <p style="
                    color: #6b7280;
                    font-size: 14px;
                    margin-bottom: 10px;
                    line-height: 1.6;
                ">
                    Developer tools have been detected on this page.
                </p>
                <p style="
                    color: #dc2626;
                    font-size: 13px;
                    font-weight: 600;
                    margin-bottom: 20px;
                    background: #fee2e2;
                    padding: 12px;
                    border-radius: 10px;
                ">
                    Using developer tools is strictly prohibited. This action has been logged.
                </p>
                <button onclick="document.getElementById('devtools-warning').remove()" style="
                    background: #2563eb;
                    color: white;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                " onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">
                    <i class="fa-solid fa-check mr-2"></i>I Understand
                </button>
            </div>
        `;

    document.body.appendChild(warningModal);
  }

  // Run detection periodically
  setInterval(detectDevTools, 2000);

  // Prevent dragging of images and links
  document.addEventListener("dragstart", function (e) {
    if (e.target.tagName === "IMG" || e.target.tagName === "A") {
      e.preventDefault();
      return false;
    }
  });

  // Prevent text selection (optional - might affect usability)
  // document.addEventListener('selectstart', function(e) {
  //     e.preventDefault();
  //     return false;
  // });

  // // Disable copy/paste (optional)
  // document.addEventListener('copy', function(e) {
  //     e.preventDefault();
  //     return false;
  // });
  // document.addEventListener('cut', function(e) {
  //     e.preventDefault();
  //     return false;
  // });

  // Override console methods to prevent logging
  const noop = function () { };
  const methods = [
    "log",
    "debug",
    "warn",
    "info",
    "error",
    "exception",
    "table",
    "trace",
  ];

  // Uncomment to completely disable console
  // methods.forEach(function(method) {
  //     console[method] = noop;
  // });

  console.log(
    "%c🔒 Admin Panel Security Active",
    "color: green; font-size: 14px; font-weight: bold;",
  );
})();


/* =====================================================================
 * ADD-ON MODULE 1 — LOCATION-BASED / VERIFIED ADDRESS INPUT
 * ---------------------------------------------------------------------
 * Prevents fake or made-up addresses by resolving whatever the resident
 * types against a real geocoding service (OpenStreetMap / Nominatim,
 * free + no API key). Provides:
 *   - live autocomplete suggestions while typing
 *   - a "Use my current location" button (GPS reverse geocoding)
 *   - a verified / not-verified badge under the field
 *   - ensureValid() used by the register + profile forms before saving
 * Only #reg-address and #prof-address are touched.
 * ===================================================================== */
(function () {
  "use strict";

  const GEO_SEARCH = "https://nominatim.openstreetmap.org/search";
  const GEO_REVERSE = "https://nominatim.openstreetmap.org/reverse";
  const COUNTRY = "ph"; // restrict matches to the Philippines
  const MIN_CHARS = 4;
  const DEBOUNCE_MS = 400;

  // inputId -> { verified: bool, lat, lon, display, placeId }
  const state = new Map();
  const cache = new Map();

  function getState(id) {
    if (!state.has(id)) state.set(id, { verified: false });
    return state.get(id);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  async function geocode(text) {
    const key = "s:" + text.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const url =
      `${GEO_SEARCH}?format=jsonv2&addressdetails=1&limit=6` +
      `&countrycodes=${COUNTRY}&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("geocoder unavailable");
    const data = await res.json();
    cache.set(key, data);
    return data;
  }

  async function reverseGeocode(lat, lon) {
    const url = `${GEO_REVERSE}?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("geocoder unavailable");
    return res.json();
  }

  /** Build a tidy "Street, Barangay, City, Province" label. */
  function prettyAddress(item) {
    const a = item.address || {};
    const parts = [
      a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road,
      a.neighbourhood || a.suburb || a.village || a.hamlet,
      a.town || a.city || a.municipality || a.city_district,
      a.state || a.province,
    ].filter(Boolean);
    // De-duplicate repeated administrative names
    const seen = new Set();
    const out = parts.filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return out.length ? out.join(", ") : item.display_name;
  }

  function ensureUi(input) {
    if (input.dataset.ovAddrReady === "1") return;
    input.dataset.ovAddrReady = "1";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");

    const holder = document.createElement("div");
    holder.className = "relative";
    input.parentNode.insertBefore(holder, input);
    holder.appendChild(input);

    // dropdown of suggestions
    const list = document.createElement("div");
    list.id = input.id + "-suggestions";
    list.className =
      "hidden absolute left-0 right-0 top-full mt-1 z-[9998] bg-white border border-gray-200 rounded-md shadow-xl max-h-60 overflow-y-auto text-left";
    holder.appendChild(list);

    // status row: badge + GPS button
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-2 mt-1.5";
    row.innerHTML =
      `<p id="${input.id}-status" class="text-[10px] font-semibold text-gray-400 flex items-center gap-1">` +
      `<button type="button" id="${input.id}-gps" class="shrink-0 text-[10px] font-thin px-2 py-1 text-tsu-gold flex items-center gap-1">` +
      `<i class="fa-solid fa-location-crosshairs"></i>Use my location</button>`;
    input.parentNode.parentNode.insertBefore(row, holder.nextSibling);

    return { holder, list };
  }

  function setStatus(input, kind, msg) {
    const el = document.getElementById(input.id + "-status");
    if (!el) return;
    const map = {
      idle: ["text-gray-400", "fa-circle-info"],
      loading: ["text-gray-400", "fa-spinner fa-spin"],
      ok: ["text-emerald-600", "fa-circle-check"],
      bad: ["text-red-500", "fa-circle-exclamation"],
    };
    const [color, icon] = map[kind] || map.idle;
    el.className = `text-[10px] font-semibold flex items-center gap-1 ${color}`;
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${esc(msg)}</span>`;
  }

  function markUnverified(input, msg) {
    const s = getState(input.id);
    s.verified = false;
    s.lat = s.lon = s.display = undefined;
    setStatus(
      input,
      msg ? "bad" : "idle",
      msg || "Start typing, then pick your address from the list.",
    );
  }

  function markVerified(input, item) {
    const s = getState(input.id);
    s.verified = true;
    s.lat = item.lat;
    s.lon = item.lon;
    s.display = input.value;
    s.placeId = item.place_id;
    setStatus(input, "ok", "Address verified");
  }

  function closeList(input) {
    document.getElementById(input.id + "-suggestions")?.classList.add("hidden");
  }

  function renderList(input, items) {
    const list = document.getElementById(input.id + "-suggestions");
    if (!list) return;
    if (!items.length) {
      list.innerHTML =
        '<div class="px-3 py-2.5 text-xs text-gray-500">No matching address found. Try including your barangay and city.</div>';
      list.classList.remove("hidden");
      return;
    }
    list.innerHTML = items
      .map(
        (it, i) =>
          `<button type="button" data-idx="${i}" class="w-full text-left px-3 py-2.5 text-xs text-gray-700 hover:bg-tsu-light border-b border-gray-100 last:border-0 flex items-start gap-2">` +
          `<i class="fa-solid fa-location-dot text-tsu-blue mt-0.5"></i>` +
          `<span><span class="font-semibold block">${esc(prettyAddress(it))}</span>` +
          `<span class="text-[10px] text-gray-400 block truncate">${esc(it.display_name)}</span></span></button>`,
      )
      .join("");
    list.classList.remove("hidden");
    list.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const it = items[Number(btn.dataset.idx)];
        input.value = prettyAddress(it);
        markVerified(input, it);
        closeList(input);
      });
    });
  }

  function attach(inputId) {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.ovAddrReady === "1") return;
    ensureUi(input);

    let timer = null;
    input.addEventListener("input", () => {
      markUnverified(input);
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < MIN_CHARS) {
        closeList(input);
        return;
      }
      setStatus(input, "loading", "Searching addresses...");
      timer = setTimeout(async () => {
        try {
          const items = await geocode(q);
          if (input.value.trim() !== q) return;
          renderList(input, items);
          setStatus(
            input,
            items.length ? "idle" : "bad",
            items.length
              ? "Select your address from the list to verify it."
              : "No real address matched. Add your barangay and city.",
          );
        } catch (err) {
          setStatus(input, "bad", "Address lookup unavailable right now.");
        }
      }, DEBOUNCE_MS);
    });

    input.addEventListener("blur", () => setTimeout(() => closeList(input), 150));
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= MIN_CHARS && !getState(inputId).verified)
        input.dispatchEvent(new Event("input"));
    });

    document
      .getElementById(inputId + "-gps")
      ?.addEventListener("click", () => useCurrentLocation(inputId));

    // The profile address is locked until "Edit Profile" is pressed. Mirror
    // that state onto the helper row without touching the existing
    // enable/disable helpers.
    const syncDisabled = () => {
      const row = document.getElementById(inputId + "-status")?.parentElement;
      const gps = document.getElementById(inputId + "-gps");
      const locked = !!input.disabled;
      if (row) row.classList.toggle("hidden", locked);
      if (gps) gps.disabled = locked;
      if (locked) closeList(input);
    };
    new MutationObserver(syncDisabled).observe(input, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    syncDisabled();
  }

  function useCurrentLocation(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (!navigator.geolocation) {
      setStatus(input, "bad", "Location is not supported on this device.");
      return;
    }
    setStatus(input, "loading", "Getting your location...");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const item = await reverseGeocode(latitude, longitude);
          if (!item || item.error) throw new Error("no match");
          input.value = prettyAddress(item);
          markVerified(input, {
            lat: latitude,
            lon: longitude,
            place_id: item.place_id,
          });
          setStatus(input, "ok", "Address verified from your location");
          closeList(input);
        } catch (e) {
          setStatus(input, "bad", "Could not resolve your location. Type it instead.");
        }
      },
      () => setStatus(input, "bad", "Location permission denied. Type your address."),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }

  /**
   * Called by the forms before saving. Returns true when the address is a
   * real, resolvable place. If the resident typed a value without picking a
   * suggestion, we geocode it once and auto-correct it to the closest match.
   */
  async function ensureValid(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return true; // field not on this page — nothing to guard
    const value = input.value.trim();
    const s = getState(inputId);
    if (!value) {
      setStatus(input, "bad", "Address is required.");
      return false;
    }
    if (s.verified && s.display === value) return true;
    if (value.length < MIN_CHARS) {
      setStatus(input, "bad", "Please enter a complete address.");
      return false;
    }
    setStatus(input, "loading", "Verifying address...");
    try {
      const items = await geocode(value);
      if (!items.length) {
        setStatus(
          input,
          "bad",
          "That address could not be found. Please enter a real address.",
        );
        return false;
      }
      // Auto-correct to the best real match
      input.value = prettyAddress(items[0]);
      markVerified(input, items[0]);
      setStatus(input, "ok", "Address verified");
      return true;
    } catch (err) {
      setStatus(input, "bad", "Address lookup unavailable. Try again shortly.");
      return false;
    }
  }

  function reset(inputId) {
    state.delete(inputId);
    const input = document.getElementById(inputId);
    if (input) markUnverified(input);
  }

  function getCoords(inputId) {
    const s = state.get(inputId);
    if (!s || !s.verified) return null;
    return {
      lat: parseFloat(s.lat),
      lng: parseFloat(s.lon),
      verified: true,
      placeId: s.placeId || null,
    };
  }

  function init() {
    attach("reg-address");
    attach("prof-address");
  }

  window.OVAddress = { init, attach, ensureValid, reset, getCoords, useCurrentLocation };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* =====================================================================
 * ADD-ON MODULE 2 — DASHBOARD WEATHER UPDATES
 * ---------------------------------------------------------------------
 * Uses the free Open-Meteo API (no API key required). The card is mounted
 * in the resident dashboard overview and refreshes every 15 minutes. It
 * falls back to Victoria's coordinates when location access is unavailable.
 * ===================================================================== */
(function () {
  "use strict";

  const API = "https://api.open-meteo.com/v1/forecast";
  const DEFAULT_PLACE = { name: "Victoria, Tarlac", lat: 15.5786, lon: 120.6817 };
  const REFRESH_MS = 15 * 60 * 1000;
  let timer = null;
  let place = { ...DEFAULT_PLACE };

  const WMO = {
    0: ["Clear sky", "fa-sun", "text-amber-500"],
    1: ["Mainly clear", "fa-sun", "text-amber-500"],
    2: ["Partly cloudy", "fa-cloud-sun", "text-amber-400"],
    3: ["Overcast", "fa-cloud", "text-gray-400"],
    45: ["Fog", "fa-smog", "text-gray-400"],
    48: ["Rime fog", "fa-smog", "text-gray-400"],
    51: ["Light drizzle", "fa-cloud-rain", "text-sky-400"],
    53: ["Drizzle", "fa-cloud-rain", "text-sky-400"],
    55: ["Heavy drizzle", "fa-cloud-rain", "text-sky-500"],
    61: ["Light rain", "fa-cloud-rain", "text-sky-500"],
    63: ["Rain", "fa-cloud-showers-heavy", "text-sky-600"],
    65: ["Heavy rain", "fa-cloud-showers-heavy", "text-sky-700"],
    66: ["Freezing rain", "fa-cloud-rain", "text-sky-600"],
    67: ["Freezing rain", "fa-cloud-rain", "text-sky-600"],
    71: ["Light snow", "fa-snowflake", "text-sky-300"],
    73: ["Snow", "fa-snowflake", "text-sky-300"],
    75: ["Heavy snow", "fa-snowflake", "text-sky-300"],
    80: ["Rain showers", "fa-cloud-sun-rain", "text-sky-500"],
    81: ["Rain showers", "fa-cloud-showers-heavy", "text-sky-600"],
    82: ["Violent showers", "fa-cloud-showers-water", "text-sky-700"],
    95: ["Thunderstorm", "fa-cloud-bolt", "text-indigo-500"],
    96: ["Thunderstorm, hail", "fa-cloud-bolt", "text-indigo-600"],
    99: ["Thunderstorm, hail", "fa-cloud-bolt", "text-indigo-600"],
  };

  const info = (code) => WMO[code] || ["Unavailable", "fa-cloud", "text-gray-400"];

  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  /** Mount the weather card in the dashboard overview's dedicated slot. */
  function mount() {
    const slot = document.getElementById("dashboard-weather-slot");
    if (!slot) return null;

    const existing = document.getElementById("weather-widget");
    if (existing) {
      // If an older page layout placed it elsewhere, move it without
      // rebuilding so the current forecast stays visible.
      if (existing.parentElement !== slot) slot.appendChild(existing);
      return existing;
    }

    const card = document.createElement("div");
    card.id = "weather-widget";
    card.className =
      "ov-dashboard-card bg-white rounded-lg border border-gray-200 shadow-soft overflow-hidden";
    card.innerHTML = skeleton();
    slot.appendChild(card);
    return card;
  }

  function skeleton() {
    return `<div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-extrabold text-tsu-blue flex items-center gap-2"><i class="fa-solid fa-cloud-sun text-tsu-gold"></i>Weather Update</h3>
      </div>
      <div class="animate-pulse space-y-3">
        <div class="h-10 bg-gray-100 rounded-md w-2/3"></div>
        <div class="h-3 bg-gray-100 rounded-md w-1/2"></div>
        <div class="grid grid-cols-3 gap-2 pt-2">
          <div class="h-14 bg-gray-100 rounded-md"></div>
          <div class="h-14 bg-gray-100 rounded-md"></div>
          <div class="h-14 bg-gray-100 rounded-md"></div>
        </div>
      </div>
    </div>`;
  }

  function errorCard(msg) {
    return `<div class="p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-extrabold text-tsu-blue flex items-center gap-2"><i class="fa-solid fa-cloud-sun text-tsu-gold"></i>Weather Update</h3>
        <button type="button" onclick="refreshWeather()" class="text-[10px] font-bold text-tsu-blue hover:underline"><i class="fa-solid fa-rotate-right mr-1"></i>Retry</button>
      </div>
      <p class="text-xs text-gray-500">${escapeHtml(msg)}</p>
    </div>`;
  }

  function dayName(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-PH", { weekday: "short" });
  }

  function render(card, data) {
    const cur = data.current || {};
    const [label, icon, color] = info(cur.weather_code);
    const daily = data.daily || {};
    const days = (daily.time || []).slice(0, 4);

    const advisory =
      [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(cur.weather_code)
        ? '<div class="mt-4 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 p-3"><i class="fa-solid fa-triangle-exclamation text-amber-500 text-xs mt-0.5"></i><p class="text-[11px] text-amber-800 font-semibold leading-snug">Rain or storms in the area. Please stay safe and monitor barangay advisories.</p></div>'
        : "";

    const forecast = days
      .map((t, i) => {
        const [dl, di, dc] = info((daily.weather_code || [])[i]);
        const hi = Math.round((daily.temperature_2m_max || [])[i]);
        const lo = Math.round((daily.temperature_2m_min || [])[i]);
        const pop = (daily.precipitation_probability_max || [])[i];
        return `<div class="rounded-md bg-gray-50 border border-gray-100 p-2 text-center" title="${escapeHtml(dl)}">
          <p class="text-[10px] font-bold text-gray-500 uppercase">${i === 0 ? "Today" : escapeHtml(dayName(t))}</p>
          <i class="fa-solid ${di} ${dc} text-base my-1"></i>
          <p class="text-[11px] font-extrabold text-gray-800">${hi}&deg;<span class="text-gray-400 font-semibold">/${lo}&deg;</span></p>
          <p class="text-[9px] text-sky-600 font-semibold"><i class="fa-solid fa-droplet"></i> ${pop == null ? "--" : pop}%</p>
        </div>`;
      })
      .join("");

    const updated = new Date().toLocaleTimeString("en-PH", {
      hour: "numeric",
      minute: "2-digit",
    });

    // Tell the resident WHERE this forecast is for, and how we know.
    const SOURCE = {
      gps: ["fa-location-crosshairs", "Based on your current location"],
      profile: ["fa-house-chimney", "Based on your registered address"],
      address: ["fa-house-chimney", "Based on your registered address"],
      default: ["fa-location-dot", "Default barangay location"],
    };
    const [sourceIcon, sourceLabel] = SOURCE[place.source] || SOURCE.default;

    card.innerHTML = `<div class="bg-gradient-to-br from-tsu-blue to-tsu-blueDark p-5 text-white">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-extrabold flex items-center gap-2"><i class="fa-solid fa-cloud-sun text-tsu-gold"></i>Weather Update</h3>
          <button type="button" onclick="refreshWeather()" class="text-[10px] font-bold text-tsu-gold hover:text-white transition-colors" title="Refresh"><i class="fa-solid fa-rotate-right"></i></button>
        </div>
        <p class="text-[10px] text-gray-300 mt-1 flex items-center gap-1"><i class="fa-solid ${sourceIcon}"></i><span class="truncate">${escapeHtml(place.name)}</span></p>
        <p class="text-[9px] text-gray-400 mt-0.5">${escapeHtml(sourceLabel)}</p>
        <div class="flex items-center gap-4 mt-4">
          <i class="fa-solid ${icon} ${color} text-4xl drop-shadow"></i>
          <div>
            <p class="text-4xl font-extrabold leading-none">${Math.round(cur.temperature_2m)}<span class="text-xl align-top">&deg;C</span></p>
            <p class="text-xs font-semibold text-gray-200 mt-1">${escapeHtml(label)}</p>
          </div>
        </div>
        <p class="text-[10px] text-gray-300 mt-2">Feels like ${Math.round(cur.apparent_temperature)}&deg;C</p>
      </div>
      <div class="p-5">
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-md bg-gray-50 border border-gray-100 p-2">
            <i class="fa-solid fa-droplet text-sky-500 text-xs"></i>
            <p class="text-[11px] font-extrabold text-gray-800 mt-1">${cur.relative_humidity_2m == null ? "--" : cur.relative_humidity_2m}%</p>
            <p class="text-[9px] text-gray-500 font-semibold uppercase">Humidity</p>
          </div>
          <div class="rounded-md bg-gray-50 border border-gray-100 p-2">
            <i class="fa-solid fa-wind text-emerald-500 text-xs"></i>
            <p class="text-[11px] font-extrabold text-gray-800 mt-1">${cur.wind_speed_10m == null ? "--" : Math.round(cur.wind_speed_10m)} km/h</p>
            <p class="text-[9px] text-gray-500 font-semibold uppercase">Wind</p>
          </div>
          <div class="rounded-md bg-gray-50 border border-gray-100 p-2">
            <i class="fa-solid fa-cloud-rain text-indigo-500 text-xs"></i>
            <p class="text-[11px] font-extrabold text-gray-800 mt-1">${cur.precipitation == null ? "--" : cur.precipitation} mm</p>
            <p class="text-[9px] text-gray-500 font-semibold uppercase">Rain</p>
          </div>
        </div>
        ${advisory}
        <p class="text-[10px] font-bold text-gray-500 uppercase tracking-wider mt-5 mb-2">Next Few Days</p>
        <div class="grid grid-cols-4 gap-2">${forecast}</div>
        <p class="text-[9px] text-gray-400 mt-4 text-center">Updated ${escapeHtml(updated)} &middot; Open-Meteo</p>
      </div>`;
  }

  async function load() {
    const card = mount();
    if (!card) return;
    try {
      const url =
        `${API}?latitude=${place.lat}&longitude=${place.lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=Asia%2FManila&forecast_days=4`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Weather service returned " + res.status);
      const data = await res.json();
      render(card, data);
    } catch (err) {
      card.innerHTML = errorCard(
        "Weather is temporarily unavailable. Please check your connection.",
      );
    }
  }

  /* -------------------------------------------------------------
   * RESIDENT LOCATION RESOLUTION
   * The forecast must reflect where the RESIDENT actually is, so the
   * coordinates are resolved in priority order:
   *   1. Live GPS from the device (most accurate, needs permission)
   *   2. Coordinates saved with their verified registered address
   *   3. Geocoding their address text (older accounts with no coords)
   *   4. The barangay default, only as a last resort
   * ----------------------------------------------------------- */

  const GEO_SEARCH = "https://nominatim.openstreetmap.org/search";
  const GEO_REVERSE = "https://nominatim.openstreetmap.org/reverse";

  /** Short "Barangay, City" label from a Nominatim address object. */
  function shortPlaceName(a) {
    if (!a) return null;
    const parts = [
      a.neighbourhood || a.suburb || a.village || a.hamlet,
      a.town || a.city || a.municipality || a.city_district,
      a.state || a.province,
    ].filter(Boolean);
    const seen = new Set();
    const out = parts.filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return out.slice(0, 2).join(", ") || null;
  }

  /** 1. Live device GPS. */
  function getDevicePosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: +pos.coords.latitude.toFixed(4),
            lon: +pos.coords.longitude.toFixed(4),
            source: "gps",
          }),
        () => resolve(null), // denied / unavailable → fall through
        { timeout: 9000, maximumAge: 300000, enableHighAccuracy: false },
      );
    });
  }

  /** Turn GPS coordinates into a readable barangay/city label. */
  async function labelForCoords(lat, lon) {
    try {
      const res = await fetch(
        `${GEO_REVERSE}?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lon}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return shortPlaceName(data.address);
    } catch (e) {
      return null;
    }
  }

  /** 3. Geocode the resident's saved address text. */
  async function geocodeAddress(text) {
    try {
      const res = await fetch(
        `${GEO_SEARCH}?format=jsonv2&addressdetails=1&limit=1&countrycodes=ph&q=${encodeURIComponent(text)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return null;
      const items = await res.json();
      if (!items.length) return null;
      return {
        lat: +parseFloat(items[0].lat).toFixed(4),
        lon: +parseFloat(items[0].lon).toFixed(4),
        name: shortPlaceName(items[0].address) || text,
        source: "address",
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolve the resident's place. `preferGps` is false on the very first
   * paint so the card shows their registered area instantly instead of
   * blocking on the browser permission prompt.
   */
  async function resolvePlace(preferGps = true) {
    // 1. Live GPS
    if (preferGps) {
      const gps = await getDevicePosition();
      if (gps) {
        const name = await labelForCoords(gps.lat, gps.lon);
        return {
          name: name || "Your current location",
          lat: gps.lat,
          lon: gps.lon,
          source: "gps",
        };
      }
    }

    // 2. Coordinates stored with the verified registered address
    const u = typeof loggedInUser !== "undefined" ? loggedInUser : null;
    if (u && u.addressLat != null && u.addressLng != null) {
      const lat = parseFloat(u.addressLat),
        lon = parseFloat(u.addressLng);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        return {
          name: u.address || "Your registered address",
          lat: +lat.toFixed(4),
          lon: +lon.toFixed(4),
          source: "profile",
        };
      }
    }

    // 3. Geocode their address text (accounts created before geo-capture)
    if (u && u.address && String(u.address).trim().length > 3) {
      const geo = await geocodeAddress(String(u.address).trim());
      if (geo) return geo;
    }

    // 4. Barangay fallback
    return { ...DEFAULT_PLACE, source: "default" };
  }

  /** Re-resolve the resident's location, then refresh the forecast. */
  async function locateAndLoad(preferGps = true) {
    const resolved = await resolvePlace(preferGps);
    const moved =
      resolved.lat !== place.lat ||
      resolved.lon !== place.lon ||
      resolved.name !== place.name;
    place = resolved;
    if (moved || !document.getElementById("weather-widget")) await load();
    return place;
  }

  function start() {
    if (!document.getElementById("dashboard-weather-slot")) return;
    // First paint: use the resident's registered location immediately...
    locateAndLoad(false).then(() => {
      // ...then upgrade to live GPS if the device allows it.
      locateAndLoad(true);
    });
    clearInterval(timer);
    timer = setInterval(() => locateAndLoad(true), REFRESH_MS);
  }

  // Manual refresh re-resolves the location too, so a resident who just
  // granted permission or changed their address sees the right forecast.
  window.refreshWeather = () => locateAndLoad(true);
  window.initWeatherWidget = start;
  window.updateWeatherLocation = locateAndLoad;

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
})();

(function () {
  "use strict";

  // Opt-in switch. Left off because Cloudflare injects these itself at the
  // edge; flipping it on would duplicate what the edge already does.
  var ENABLE_CLOUDFLARE_SHIMS = false;
  if (!ENABLE_CLOUDFLARE_SHIMS) return;

  // Bail out when not served from a Cloudflare edge, so local dev and any
  // non-CF host stay free of console 404s.
  function onCloudflareEdge() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  // --- 1. Email obfuscation decoder ------------------------------------
  function loadEmailDecoder() {
    if (document.querySelector('script[data-cf-email-decode]')) return;
    var s = document.createElement("script");
    s.src = "/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js";
    s.setAttribute("data-cfasync", "false");
    s.setAttribute("data-cf-email-decode", "");
    s.async = true;
    s.onerror = function () {
      /* Not on a CF edge — nothing to decode. Ignore. */
    };
    document.head.appendChild(s);
  }

  // --- 2. Challenge-platform beacon ------------------------------------
  // Mirrors Cloudflare's original technique: a hidden 1x1 iframe is used as a
  // clean execution context for the probe, keeping it out of the main window.
  function loadChallengeBeacon() {
    if (window.__ovCfBeaconLoaded) return; // guards against the old duplicate
    window.__ovCfBeaconLoaded = true;

    var frame = document.createElement("iframe");
    frame.height = 1;
    frame.width = 1;
    frame.style.position = "absolute";
    frame.style.top = 0;
    frame.style.left = 0;
    frame.style.border = "none";
    frame.style.visibility = "hidden";
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    document.body.appendChild(frame);

    var doc = frame.contentDocument ||
      (frame.contentWindow && frame.contentWindow.document);
    if (!doc) return;

    var probe = doc.createElement("script");
    probe.src = "/cdn-cgi/challenge-platform/scripts/jsd/main.js";
    probe.onerror = function () {
      /* Endpoint absent off-edge. Ignore. */
    };
    (doc.head || doc.getElementsByTagName("head")[0]).appendChild(probe);
  }

  function start() {
    if (!onCloudflareEdge() || !document.body) return;
    loadEmailDecoder();
    loadChallengeBeacon();
  }

  // user.js is a deferred ES module, so the DOM is normally parsed by now;
  // the readyState check keeps it correct either way.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();



/* =====================================================================
 * ADD-ON MODULE 3 — STRONG PASSWORD POLICY
 * ---------------------------------------------------------------------
 * Replaces the old "6 characters minimum" rule with a real strength
 * policy, enforced when a resident CREATES AN ACCOUNT (#reg-password)
 * and when they CHANGE their password from the profile tab
 * (#prof-password).
 *
 * Enforced requirements:
 *   - 10 to 64 characters
 *   - at least one uppercase letter, one lowercase letter, one number
 *     and one special character
 *   - no spaces or tabs
 *   - must not contain the resident's name, email name or mobile number
 *   - must not be a common / predictable password (blocklist + runs)
 *   - the confirm field must match exactly
 *
 * Everything is tuned from PASSWORD_POLICY below - e.g. change
 * minLength to 12 for an even stricter rule.
 *
 * NOTE: this is the client-side gate. For defence in depth also switch on
 * Firebase Authentication's own password policy
 * (Firebase Console -> Authentication -> Settings -> Password policy) with
 * the same minimum length and character requirements, so the server
 * rejects weak passwords too.
 * ===================================================================== */
(function () {
  "use strict";

  /* ----------------------------------------------------------------
   * 1. POLICY CONFIGURATION
   * ---------------------------------------------------------------- */
  const PASSWORD_POLICY = {
    minLength: 10,
    maxLength: 64,
    rejectCommonPasswords: true,
    rejectPersonalInfo: true,
    rejectWhitespace: true,
  };

  /* ----------------------------------------------------------------
   * 2. COMMONLY ABUSED PASSWORDS (blocklist)
   * ---------------------------------------------------------------- */
  const COMMON_PASSWORDS = new Set(
    [
      "password", "password1", "password12", "password123", "password1234",
      "passw0rd", "p@ssw0rd", "p@ssword1", "password!", "password@123",
      "123456", "1234567", "12345678", "123456789", "1234567890", "12345",
      "1234", "123123", "111111", "000000", "121212", "654321", "987654321",
      "qwerty", "qwerty123", "qwertyuiop", "1q2w3e4r", "1qaz2wsx", "qazwsx",
      "asdfghjkl", "zxcvbnm", "abc123", "abcd1234", "a1b2c3d4", "letmein",
      "welcome", "welcome1", "welcome123", "admin", "admin123", "administrator",
      "root", "guest", "test123", "changeme", "iloveyou", "iloveyou1",
      "sunshine", "princess", "football", "baseball", "basketball", "superman",
      "batman", "monkey", "dragon", "master", "shadow", "michael", "jordan",
      "harley", "ranger", "trustno1", "secret", "sample123", "temp123",
      "pilipinas", "philippines", "mabuhay", "mahalkita", "juandelacruz",
      "juandc", "juan123", "pedro123", "victoria", "victoria123", "onevictoria",
      "tarlac", "tarlac123", "barangay", "barangay123", "municipality",
      "resident", "resident123", "bagongpilipinas",
    ].map((entry) => entry.toLowerCase()),
  );

  const KEYBOARD_RUNS = [
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
    "1234567890",
    "0987654321",
    "abcdefghij",
    "jihgfedcba",
  ];

  /* ----------------------------------------------------------------
   * 3. SMALL HELPERS
   * ---------------------------------------------------------------- */
  const normalize = (value) => String(value == null ? "" : value).toLowerCase();

  /** Keep letters and digits only - "Juan_2026!" becomes "juan2026". */
  const stripSymbols = (value) => normalize(value).replace(/[^a-z0-9]/g, "");

  /** Fold the usual leetspeak swaps so "P@ssw0rd" is still recognised. */
  const foldLeet = (value) =>
    normalize(value)
      .replace(/[4@]/g, "a")
      .replace(/[3]/g, "e")
      .replace(/[1!|]/g, "i")
      .replace(/0/g, "o")
      .replace(/[5$]/g, "s")
      .replace(/7/g, "t")
      .replace(/[^a-z0-9]/g, "");

  /** A run of 5+ identical, ascending or descending characters ("aaaaa", "abcde"). */
  function hasCharacterRun(flat, windowSize) {
    if (flat.length < windowSize) return false;
    for (let i = 0; i + windowSize <= flat.length; i++) {
      const slice = flat.slice(i, i + windowSize);
      let ascending = true;
      let descending = true;
      let repeated = true;
      for (let j = 1; j < slice.length; j++) {
        const diff = slice.charCodeAt(j) - slice.charCodeAt(j - 1);
        if (diff !== 1) ascending = false;
        if (diff !== -1) descending = false;
        if (diff !== 0) repeated = false;
      }
      if (ascending || descending || repeated) return true;
    }
    return false;
  }

  function hasPredictableRun(password, windowSize = 5) {
    const flat = stripSymbols(password);
    if (!flat) return false;
    if (hasCharacterRun(flat, windowSize)) return true;
    const sliceLength = Math.max(4, windowSize - 1);
    return KEYBOARD_RUNS.some((row) => flat.includes(row.slice(0, sliceLength)));
  }

  /** Every possible weak "shape" of the password, for the blocklist lookup. */
  function weakKeyCandidates(password) {
    const keys = new Set();
    const raw = normalize(password);
    const flat = stripSymbols(password);
    keys.add(raw);
    keys.add(flat);
    keys.add(foldLeet(password));
    // "Password123!" -> "password123" -> "password"
    const withoutYear = flat.replace(/(19|20)\d{2}$/, "");
    keys.add(withoutYear);
    const withoutDigits = withoutYear.replace(/\d+$/, "");
    keys.add(withoutDigits);
    return [...keys].filter((key) => key.length >= 4);
  }

  function isCommonPassword(password) {
    if (!PASSWORD_POLICY.rejectCommonPasswords) return false;
    if (!password) return false;
    if (COMMON_PASSWORDS.size === 0) return false;
    return weakKeyCandidates(password).some((key) => COMMON_PASSWORDS.has(key));
  }

  /** Build the fragments a password must not contain (name / email / phone). */
  function personalTokens(identity) {
    const tokens = new Set();
    const add = (value, minLength) => {
      const token = stripSymbols(value);
      if (token.length >= minLength) tokens.add(token);
    };

    const name = String(identity?.name || "").trim();
    if (name) {
      name.split(/\s+/).forEach((part) => add(part, 4));
      add(name.replace(/\s+/g, ""), 6);
    }

    const email = String(identity?.email || "").trim().toLowerCase();
    if (email.includes("@")) {
      const local = email.split("@")[0];
      add(local, 4);
      local.split(/[._\-+]+/).forEach((part) => add(part, 4));
      add(local.replace(/\d+$/, ""), 4);
    }

    const digits = String(identity?.phone || "").replace(/\D/g, "");
    if (digits.length >= 7) {
      tokens.add(digits);
      tokens.add(digits.slice(-7));
    }

    return [...tokens].filter((token) => token.length >= 4);
  }

  function containsPersonalInfo(password, identity) {
    if (!PASSWORD_POLICY.rejectPersonalInfo) return false;
    if (!password) return false;
    const flat = stripSymbols(password);
    const folded = foldLeet(password);
    return personalTokens(identity).some(
      (token) =>
        flat.includes(token) ||
        folded.includes(token) ||
        (flat.length >= 4 && foldLeet(token).includes(flat)),
    );
  }

  /* ----------------------------------------------------------------
   * 4. THE RULES (one entry = one line in the checklist)
   * ---------------------------------------------------------------- */
  const RULES = [
    {
      id: "length",
      label: `At least ${PASSWORD_POLICY.minLength} characters`,
      test: (password) => password.length >= PASSWORD_POLICY.minLength,
    },
    { id: "upper", label: "One uppercase letter (A-Z)", test: (p) => /[A-Z]/.test(p) },
    { id: "lower", label: "One lowercase letter (a-z)", test: (p) => /[a-z]/.test(p) },
    { id: "number", label: "One number (0-9)", test: (p) => /[0-9]/.test(p) },
    {
      id: "special",
      label: "One special character (! @ # $ ...)",
      test: (p) => /[^A-Za-z0-9\s]/.test(p),
    },
    {
      id: "nospace",
      label: "No spaces or tabs",
      test: (p) => !PASSWORD_POLICY.rejectWhitespace || !/\s/.test(p),
    },
    {
      id: "personal",
      label: "Not based on your name, email or mobile number",
      test: (p, identity) => !containsPersonalInfo(p, identity),
    },
    {
      id: "common",
      label: "Not a commonly used or easily guessed password",
      test: (p) => !isCommonPassword(p),
    },
    {
      id: "sequence",
      label: "No long runs like 12345, abcde or qwerty",
      test: (p) => !hasPredictableRun(p, 5),
    },
  ];

  /* ----------------------------------------------------------------
   * 5. STRENGTH SCORING
   * ---------------------------------------------------------------- */
  const MAX_SCORE = 9;
  const STRENGTH_BANDS = [
    { key: "veryWeak", label: "Very weak", bar: "bg-red-500", text: "text-red-400", min: 0 },
    { key: "weak", label: "Weak", bar: "bg-orange-500", text: "text-orange-300", min: 3 },
    { key: "fair", label: "Fair", bar: "bg-amber-400", text: "text-amber-300", min: 5 },
    { key: "strong", label: "Strong", bar: "bg-emerald-500", text: "text-emerald-400", min: 7 },
    { key: "veryStrong", label: "Very strong", bar: "bg-emerald-400", text: "text-emerald-300", min: 9 },
  ];

  function scorePassword(password, identity = {}) {
    const value = String(password || "");
    let score = 0;

    if (value.length >= PASSWORD_POLICY.minLength) score += 2;
    if (value.length >= 12) score += 1;
    if (value.length >= 16) score += 1;
    if (value.length >= 20) score += 1;

    score += [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter((re) =>
      re.test(value),
    ).length;

    if (isCommonPassword(value) || containsPersonalInfo(value, identity)) {
      score = Math.min(score, 2); // blocklisted guesses can never look strong
    } else if (hasPredictableRun(value, 5)) {
      score = Math.min(score, 4);
    }

    score = Math.max(0, Math.min(MAX_SCORE, score));
    const band =
      [...STRENGTH_BANDS].reverse().find((entry) => score >= entry.min) ||
      STRENGTH_BANDS[0];
    const percent = value.length
      ? Math.max(6, Math.round((score / MAX_SCORE) * 100))
      : 0;

    return { score, maxScore: MAX_SCORE, percent, band };
  }

  /* ----------------------------------------------------------------
   * 6. PUBLIC EVALUATION API
   * ---------------------------------------------------------------- */
  /**
   * Check one password against the whole policy.
   * @returns {{valid:boolean, failures:string[], rules:Array, score:number,
   *            percent:number, band:object}}
   */
  function evaluate(password, identity = {}) {
    const value = String(password || "");
    const hasInput = value.length > 0;
    const rules = RULES.map((rule) => ({
      id: rule.id,
      label: rule.label,
      met: hasInput && rule.test(value, identity),
    }));

    const failures = [];
    if (!hasInput) {
      failures.push(`At least ${PASSWORD_POLICY.minLength} characters`);
    } else {
      rules.forEach((rule) => {
        if (!rule.met) failures.push(rule.label);
      });
      if (value.length > PASSWORD_POLICY.maxLength) {
        failures.push(`At most ${PASSWORD_POLICY.maxLength} characters`);
      }
    }

    return {
      password: value,
      rules,
      failures,
      valid: hasInput && failures.length === 0,
      ...scorePassword(value, identity),
    };
  }

  /** "A • B • C" - ready for the toast/alert body. */
  function describe(evaluation) {
    if (!evaluation || evaluation.valid) return "";
    return evaluation.failures.join(" • ");
  }

  /* ----------------------------------------------------------------
   * 7. CREATE-ACCOUNT FORM UI
   * ---------------------------------------------------------------- */
  const PASSWORD_ID = "reg-password";
  const CONFIRM_ID = "reg-confirm-password";

  function readRegisterIdentity() {
    return {
      name: document.getElementById("reg-name")?.value || "",
      email: document.getElementById("reg-email")?.value || "",
      phone: document.getElementById("reg-phone")?.value || "",
    };
  }

  function paintChecklist(evaluation, hasInput) {
    document
      .querySelectorAll("#reg-password-requirements [data-pw-rule]")
      .forEach((item) => {
        const rule = evaluation.rules.find(
          (entry) => entry.id === item.dataset.pwRule,
        );
        const met = !!rule?.met;
        item.classList.toggle("text-emerald-300", met);
        item.classList.toggle("text-red-400", !met && hasInput);
        item.classList.toggle("text-gray-400", !met && !hasInput);

        const icon = item.querySelector("i");
        if (!icon) return;
        icon.className = met
          ? "fa-solid fa-circle-check mt-0.5 text-[9px] text-emerald-400 shrink-0"
          : `fa-solid fa-circle-xmark mt-0.5 text-[9px] shrink-0 ${hasInput ? "text-red-400" : "text-gray-500"}`;
      });
  }

  function paintStrength(evaluation, password) {
    const bar = document.getElementById("reg-password-strength-bar");
    const label = document.getElementById("reg-password-strength-label");
    const track = document.getElementById("reg-password-strength-track");
    const hint = document.getElementById("reg-password-length-hint");
    const hasInput = password.length > 0;

    if (bar) {
      bar.className = `h-full rounded-full transition-all duration-300 ${evaluation.band.bar}`;
      bar.style.width = `${hasInput ? evaluation.percent : 0}%`;
    }
    if (track) {
      track.setAttribute("aria-valuenow", String(hasInput ? evaluation.percent : 0));
    }
    if (label) {
      label.className = `text-[9px] font-bold uppercase tracking-wider ${hasInput ? evaluation.band.text : "text-gray-400"}`;
      label.innerHTML = hasInput
        ? `<i class="fa-solid fa-shield-halved mr-1"></i>Strength: ${evaluation.band.label}`
        : '<i class="fa-solid fa-shield-halved mr-1"></i>Strength: waiting for input';
    }
    if (hint) {
      const remaining = PASSWORD_POLICY.minLength - password.length;
      hint.textContent = hasInput
        ? remaining > 0
          ? `${password.length} / ${PASSWORD_POLICY.minLength} - ${remaining} more`
          : `${password.length} characters`
        : `0 / ${PASSWORD_POLICY.minLength}`;
      hint.className = `text-[9px] font-medium ${remaining > 0 ? "text-gray-400" : "text-emerald-400"}`;
    }
  }

  function paintConfirmStatus(password, confirm) {
    const el = document.getElementById("reg-confirm-password-status");
    const matches = password.length > 0 && confirm === password;
    const mismatch = confirm.length > 0 && confirm !== password;
    if (!el) return matches;

    el.className = `mt-1 text-[10px] font-medium ${matches ? "text-emerald-300" : mismatch ? "text-red-400" : "text-gray-400"
      }`;
    el.innerHTML = matches
      ? '<i class="fa-solid fa-circle-check mr-1"></i>Passwords match'
      : mismatch
        ? '<i class="fa-solid fa-circle-xmark mr-1" style="color:#ef4444"></i>Passwords do not match yet'
        : '<i class="fa-solid fa-circle-info mr-1"></i>Re-type the same password';
    return matches;
  }

  /** Small line under the button that says what is still missing. */
  function paintSubmitHint(evaluation, consent) {
    const button = document.getElementById("register-submit-btn");
    if (!button) return;
    const password = document.getElementById(PASSWORD_ID)?.value || "";
    const confirm = document.getElementById(CONFIRM_ID)?.value || "";
    // Password/confirm problems are reported inline under their own fields,
    // so this line only covers the one thing that has no text field: the
    // Privacy Policy checkbox.
    let message = "";
    if (!consent) {
      message = "Tick the Privacy Policy box to enable this button.";
    }

    let hint = document.getElementById("reg-submit-hint");
    if (!message) {
      if (hint) hint.remove();
      return;
    }
    if (!hint) {
      hint = document.createElement("p");
      hint.id = "reg-submit-hint";
      hint.innerHTML = '<i class="fa-solid fa-circle-exclamation mt-0.5"></i>';
      hint.appendChild(document.createElement("span"));
      button.insertAdjacentElement("afterend", hint);
    }
    // Missing consent = instruction (amber). Anything wrong with the password
    // or the confirm field = ERROR (red).
    hint.className = consent
      ? "mt-2 text-[10px] font-semibold text-red-400 flex items-start gap-1.5"
      : "mt-2 text-[10px] font-medium text-amber-300 flex items-start gap-1.5";
    const span = hint.querySelector("span");
    if (span) span.textContent = message;
  }

  /**
   * Keeps the Create Account button in sync with the form.
   *
   * The button is locked by the PRIVACY POLICY CHECKBOX ONLY. The password
   * rules are still fully enforced — but on click (see the register submit
   * handler) instead of by greying the button out, because disabling it on
   * a password mistake made it look broken ("naka-check na, ayaw pa rin").
   * The live checklist / strength meter and the hint under the button still
   * show exactly which rule is missing.
   *
   * Wired into updateRegisterConsentState() as well.
   */
  function syncRegisterSubmitState(precomputed) {
    const button = document.getElementById("register-submit-btn");
    if (!button) return false;

    const password = document.getElementById(PASSWORD_ID)?.value || "";
    const confirm = document.getElementById(CONFIRM_ID)?.value || "";
    const evaluation =
      precomputed || evaluate(password, readRegisterIdentity());
    const consent =
      document.getElementById("reg-privacy-consent")?.checked === true;
    const ready = consent && evaluation.valid && confirm === password;

    // Only the Privacy Policy gate disables the button.
    button.disabled = !consent;
    button.setAttribute("aria-disabled", consent ? "false" : "true");
    button.title = !consent
      ? "Accept the Privacy Policy to continue"
      : ready
        ? "Create your account"
        : `Password requirements not met: ${describe(evaluation) || "passwords must match"}`;
    paintSubmitHint(evaluation, consent);
    return ready;
  }

  /**
   * Red border + focus on the field that failed. Delegates to the shared
   * red-error helper so the password fields look exactly like every other
   * invalid field in the app (red border, red ring, message cleared on input).
   */
  function flagInvalidInput(id) {
    const input = document.getElementById(id);
    if (!input) return;
    if (window.markFieldInvalid) {
      window.markFieldInvalid(id);
      try {
        input.focus({ preventScroll: false });
      } catch (e) {
        input.focus();
      }
      return;
    }
    input.classList.remove("border-white/20");
    input.classList.add("border-red-500");
    try {
      input.focus({ preventScroll: false });
    } catch (e) {
      input.focus();
    }
    const clear = () => {
      input.classList.remove("border-red-500");
      input.classList.add("border-white/20");
      input.removeEventListener("input", clear);
      input.removeEventListener("blur", clear);
    };
    input.addEventListener("input", clear);
    input.addEventListener("blur", clear);
  }

  function refreshRegisterPasswordUI() {
    const input = document.getElementById(PASSWORD_ID);
    if (!input) return null;
    const password = input.value || "";
    const confirm = document.getElementById(CONFIRM_ID)?.value || "";
    const evaluation = evaluate(password, readRegisterIdentity());

    paintChecklist(evaluation, password.length > 0);
    paintStrength(evaluation, password);
    paintConfirmStatus(password, confirm);
    syncRegisterSubmitState(evaluation);
    return evaluation;
  }

  /** Clear the meter/checklist whenever the register form is reset. */
  function resetRegisterPasswordUI() {
    [PASSWORD_ID, CONFIRM_ID].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.type = "password";
      input.classList.remove("border-red-500", "border-rose-500");
      input.classList.add("border-white/20");
      window.clearFieldInvalid?.(id);
    });
    document.querySelectorAll("[data-pw-toggle-icon]").forEach((icon) => {
      icon.classList.remove("fa-eye-slash");
      icon.classList.add("fa-eye");
    });
    document.querySelectorAll("[data-pw-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", "Show password");
    });
    refreshRegisterPasswordUI();
  }

  function initVisibilityToggles() {
    document.querySelectorAll("[data-pw-toggle]").forEach((button) => {
      if (button.dataset.pwToggleReady === "1") return;
      button.dataset.pwToggleReady = "1";
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.pwToggle);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        const icon = button.querySelector("[data-pw-toggle-icon], i");
        if (icon) {
          icon.classList.toggle("fa-eye", !show);
          icon.classList.toggle("fa-eye-slash", show);
        }
        button.setAttribute("aria-pressed", show ? "true" : "false");
        button.setAttribute("aria-label", show ? "Hide password" : "Show password");
        refreshRegisterPasswordUI();
      });
    });
  }

  function attachRegisterPasswordWatchers() {
    // The "personal" rule depends on the name/email/phone fields, so they
    // re-run the checklist too.
    [PASSWORD_ID, CONFIRM_ID, "reg-name", "reg-email", "reg-phone"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.dataset.pwWatch === "1") return;
      el.dataset.pwWatch = "1";
      el.addEventListener("input", refreshRegisterPasswordUI);
    });
  }

  /**
   * Safety net so the button state never depends on how the checkbox is
   * wired in the HTML: if the page does not call
   * updateRegisterConsentState() when the box is ticked, we call it here.
   */
  function attachRegisterConsentWatcher() {
    const consent = document.getElementById("reg-privacy-consent");
    if (consent && consent.dataset.pwConsentWatch !== "1") {
      consent.dataset.pwConsentWatch = "1";
      const resync = () => window.updateRegisterConsentState?.();
      consent.addEventListener("change", resync);
      consent.addEventListener("click", resync);
    }
    const form = document.getElementById("register-form");
    if (form && form.dataset.pwFormWatch !== "1") {
      form.dataset.pwFormWatch = "1";
      form.addEventListener("change", () => window.updateRegisterConsentState?.());
    }
  }

  /**
   * Safety net: if the Create Account button is NOT a native submit button of
   * #register-form (e.g. it sits outside the form or is type="button"), a
   * click would otherwise do nothing. Forward it to the form's submit event
   * so the existing register handler still validates and creates the account.
   */
  function attachRegisterSubmitFallback() {
    const button = document.getElementById("register-submit-btn");
    if (!button || button.dataset.pwSubmitFallback === "1") return;
    button.dataset.pwSubmitFallback = "1";
    const form = document.getElementById("register-form");
    if (!form) return;
    const nativeSubmit =
      String(button.type || "submit").toLowerCase() === "submit" &&
      button.closest("form") === form;
    if (nativeSubmit) return;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    });
  }

  function init() {
    if (!document.getElementById(PASSWORD_ID)) return;
    initVisibilityToggles();
    attachRegisterPasswordWatchers();
    attachRegisterConsentWatcher();
    attachRegisterSubmitFallback();
    resetRegisterPasswordUI();
  }

  /* ----------------------------------------------------------------
   * 8. EXPORTS (used by the register + profile submit handlers)
   * ---------------------------------------------------------------- */
  const policySummary = `${PASSWORD_POLICY.minLength}-${PASSWORD_POLICY.maxLength} characters with uppercase, lowercase, numbers and special characters, and must not contain your name, email or number`;

  window.OVPassword = {
    policy: PASSWORD_POLICY,
    summary: policySummary,
    evaluate,
    describe,
    /** Standard toast text for a failed attempt. */
    alertText(evaluation) {
      return `Your password must meet every requirement: ${describe(evaluation)}. Use ${PASSWORD_POLICY.minLength} or more characters.`;
    },
    refreshUI: refreshRegisterPasswordUI,
    resetUI: resetRegisterPasswordUI,
    syncSubmitState: syncRegisterSubmitState,
    flagInvalidInput,
  };
  // Called by updateRegisterConsentState(), closeAuthPanels(), toggleAuthPanels()
  window.syncRegisterSubmitState = syncRegisterSubmitState;
  window.resetRegisterPasswordUI = resetRegisterPasswordUI;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* =====================================================================
 * ADD-ON MODULE 4 — LIVE INLINE FIELD VALIDATION
 * ---------------------------------------------------------------------
 * Every invalid input is now reported ON THE FIELD ITSELF: the box turns
 * red and a short red note appears right below it. No toast for field
 * errors any more — a toast only shows when something is not tied to one
 * field (network failure, account disabled, too many attempts, ...).
 *
 * This module runs the SAME rules as the register/login submit handlers,
 * but the moment the resident leaves a field (blur) or changes a select,
 * so the red indication appears while filling the form instead of only
 * after pressing the button.
 *
 * Rules kept in sync with the submit handlers:
 *   name    letters + spaces only
 *   email   normal email shape
 *   phone   11 digits starting with 09
 *   age     15 - 120
 *   gender  must be chosen
 *   address at least "Barangay, City"
 *   password  full policy from ADD-ON MODULE 3 (window.OVPassword)
 *   confirm   must equal the password
 * ===================================================================== */
(function () {
  "use strict";

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const NAME_RE = /^[a-zA-ZñÑ\s.]+$/;
  const PHONE_RE = /^09\d{9}$/;

  const value = (id) => document.getElementById(id)?.value?.trim() || "";

  const registerIdentity = () => ({
    name: value("reg-name"),
    email: value("reg-email"),
    phone: value("reg-phone"),
  });

  /* ---------------- the rules: return "" when the value is fine -------- */
  const RULES = {
    "reg-name": (v) =>
      !v
        ? "This field is required"
        : NAME_RE.test(v)
          ? ""
          : "Letters and spaces only",

    "reg-email": (v) =>
      !v
        ? "This field is required"
        : EMAIL_RE.test(v)
          ? ""
          : "Enter a valid email address",

    "reg-phone": (v) =>
      !v
        ? "This field is required"
        : !PHONE_RE.test(v)
          ? "Must be 11 digits starting with 09"
          : "",

    "reg-age": (v) => {
      if (!v) return "This field is required";
      const age = Number(v);
      return !Number.isFinite(age) || age < 15 || age > 120
        ? "Must be between 15 and 120"
        : "";
    },

    "reg-gender": (v) => (v ? "" : "Please select a gender"),

    "reg-address": (v) =>
      !v
        ? "This field is required"
        : v.length < 4
          ? "Include your barangay and city"
          : "",

    "reg-password": (v) => {
      if (!v) return "This field is required";
      const check = window.OVPassword?.evaluate(v, registerIdentity());
      if (!check) {
        // Policy module missing: fall back to the hard minimums.
        return v.length >= 10 && /[A-Z]/.test(v) && /[a-z]/.test(v) &&
          /[0-9]/.test(v) && /[^A-Za-z0-9\s]/.test(v)
          ? ""
          : "Use 10+ characters with uppercase, lowercase, a number and a special character";
      }
      return check.valid ? "" : check.failures.join(" • ");
    },

    "reg-confirm-password": (v) =>
      !v
        ? "This field is required"
        : v === value("reg-password")
          ? ""
          : "Passwords do not match",

    "login-email": (v) =>
      !v
        ? "This field is required"
        : !EMAIL_RE.test(v)
          ? "Enter a valid email address"
          : "",

    "login-password": (v) =>
      v ? "" : "This field is required",
  };

  /* ------------------------- wiring ---------------------------------- */
  function validateField(id, { quiet } = {}) {
    const rule = RULES[id];
    const el = document.getElementById(id);
    if (!rule || !el) return true;
    const message = rule(String(el.value || "").trim());
    if (message) {
      if (!quiet) window.markFieldInvalid?.(id, message);
      return false;
    }
    window.clearFieldInvalid?.(id);
    return true;
  }

  function attach(id) {
    const el = document.getElementById(id);
    if (!el || el.dataset.ovLiveValidate === "1") return;
    el.dataset.ovLiveValidate = "1";

    // Leaving a field only complains about what was actually typed in it
    // (e.g. "juan@" is not an email). Still-empty fields are left alone until
    // the resident presses the button — nobody wants red boxes on a form they
    // have not started filling in yet.
    const validateOnBlur = () => {
      if (String(el.value || "").trim() === "") {
        window.clearFieldInvalid?.(id);
        return;
      }
      validateField(id);
    };
    el.addEventListener("blur", validateOnBlur);
    el.addEventListener("change", validateOnBlur);

    // Typing clears the note immediately (handled by the red-error helper),
    // and the note comes back on blur if the value is still wrong.
    el.addEventListener("input", () => {
      if (String(el.value || "").trim() === "") window.clearFieldInvalid?.(id);
    });
  }

  /** The confirm field depends on the password, so re-check it when it changes. */
  function attachPasswordLink() {
    const password = document.getElementById("reg-password");
    if (!password || password.dataset.ovLiveLink === "1") return;
    password.dataset.ovLiveLink = "1";
    password.addEventListener("input", () => {
      const confirm = document.getElementById("reg-confirm-password");
      if (confirm && String(confirm.value || "") !== "") {
        validateField("reg-confirm-password", { quiet: true });
      }
    });
  }

  function init() {
    Object.keys(RULES).forEach(attach);
    attachPasswordLink();
    // A <select> has no "typed" state: actually choosing an option is the
    // change. A select that is (back to) empty is only reported on submit.
    const gender = document.getElementById("reg-gender");
    gender?.addEventListener("change", () => {
      if (String(gender.value || "").trim() === "") return;
      validateField("reg-gender");
    });
  }

  window.OVLiveValidation = { rules: RULES, validateField, init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


/* #page-overlay / #page-content are static markup that merged.js never
           touches - the Back button's closePage() had no definition anywhere, so
           clicking it threw a ReferenceError. Minimal implementation: hide the
           overlay and clear its content. */
window.closePage = function () {
  var overlay = document.getElementById("page-overlay");
  if (overlay) overlay.classList.add("hidden");
  var content = document.getElementById("page-content");
  if (content) content.innerHTML = "";
};
window.openPage = function (html) {
  var overlay = document.getElementById("page-overlay");
  var content = document.getElementById("page-content");
  if (content) content.innerHTML = html || "";
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.scrollTop = 0;
  }
};

// ===== EXPORT GLOBALS =====
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.openMobileMenu = openMobileMenu;
window.closeMobileMenu = closeMobileMenu;
window.openNotificationDetail = window.openNotificationDetail;
window.closeNotificationDetail = window.closeNotificationDetail;
window.clearAllNotifications = window.clearAllNotifications;
window.deleteNotification = window.deleteNotification;
window.joinEvent = window.confirmJoinEvent;
window.confirmJoinEvent = window.confirmJoinEvent;
window.performJoinEvent = performJoinEvent;
window.unregisterFromEvent = window.unregisterFromEvent;
window.selectPaymentMethod = window.selectPaymentMethod;
window.setAmount = window.setAmount;
window.processPayment = window.processPayment;
window.confirmCashPayment = window.confirmCashPayment;
window.submitPaymentWithScreenshot = window.submitPaymentWithScreenshot;
window.openPaymentModal = window.openPaymentModal;
window.formatTimeDisplay = formatTimeDisplay;
window.triggerProfilePicUpload = window.triggerProfilePicUpload;
window.handleProfilePicChange = window.handleProfilePicChange;
window.removeProfilePic = window.removeProfilePic;
window.toggleEditMode = window.toggleEditMode;
window.cancelEdit = window.cancelEdit;
window.saveProfileChanges = window.saveProfileChanges;
window.openAnnouncementDetails = window.openAnnouncementDetails;
window.handleRegisterClick = window.handleRegisterClick;
window.handleUnregisterClick = window.handleUnregisterClick;
window.handleSkillVerificationUpload = window.handleSkillVerificationUpload;
window.removeSkillVerification = window.removeSkillVerification;
window.toggleNotificationDropdown = window.toggleNotificationDropdown;
window.toggleMoreNotifications = window.toggleMoreNotifications;
window.markNotificationAsRead = window.markNotificationAsRead;
window.markAllNotificationsAsRead = window.markAllNotificationsAsRead;
window.handleNotificationClick = window.handleNotificationClick;
window.toggleMobileNotificationDropdown = window.toggleMobileNotificationDropdown;
window.toggleMoreMobileNotifications = window.toggleMoreMobileNotifications;
window.copyToClipboard = window.copyToClipboard;
window.downloadQRCode = window.downloadQRCode;
window.shareQRCode = window.shareQRCode;
window.handleForgotPassword = window.handleForgotPassword;
window.handleResendVerification = window.handleResendVerification;
window.closeResendVerificationModal = window.closeResendVerificationModal;
window.switchDonationType = window.switchDonationType;
window.setDonationAmount = window.setDonationAmount;
window.toggleProfPassword = window.toggleProfPassword;