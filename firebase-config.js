/* Firebase connection for Zenitude Desk (project: ticketing-de6b4).
   This key is public by design. Access is controlled by firestore.rules. */
window.ZEN_DESK_FIREBASE_CONFIG = {
  apiKey: "AIzaSyC19zJK6CxghsFLy0zXC-rUs_WajlICDCc",
  authDomain: "ticketing-de6b4.firebaseapp.com",
  projectId: "ticketing-de6b4",
  storageBucket: "ticketing-de6b4.firebasestorage.app",
  messagingSenderId: "48592828740",
  appId: "1:48592828740:web:2782f0c73a43a1f39b3f11",
  measurementId: "G-8EP1TX7XCB"
};

/* App options */
window.ZEN_DESK_OPTIONS = {
  // These accounts are always IT administrators. Keep this list in step with
  // MAIN_ADMIN in firestore.rules, which is what actually grants the role.
  adminEmails: ["it@zenitudeconcierge.com"],
  // Let staff create their own end-user account from the sign-in page.
  allowSignup: true,
  // Restrict sign-up to these email domains, e.g. ["yourcompany.com"]. Empty = any domain.
  allowedEmailDomains: []
};
