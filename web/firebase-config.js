/* Firebase web configuration.
 *
 * These values are public on purpose. A Firebase web config is an address, not
 * a credential — it ships inside every Firebase site on the internet, and the
 * console shows it under "SDK setup and configuration" precisely because it is
 * meant to be readable. What actually protects the data is elsewhere:
 *
 *   - Firestore security rules (web/firestore.rules) decide who may read what;
 *   - the Authorized domains list decides which sites may sign people in.
 *
 * Fill these in from the Firebase console, then set the same project id as
 * FIREBASE_PROJECT_ID in Vercel so the mail function can verify sign-in tokens.
 * Steps in web/SETUP.md. Until they are filled in, the sign-in button hides
 * itself and the rest of the site carries on exactly as before.
 */

export const firebaseConfig = {
  apiKey: 'AIzaSyARJlhETntynLBGX0j-IlEiZVkEyrDuhjg',
  authDomain: 'souffleur-web.firebaseapp.com',
  projectId: 'souffleur-web',
  storageBucket: 'souffleur-web.firebasestorage.app',
  messagingSenderId: '555228075587',
  appId: '1:555228075587:web:6ac1ac9083fc05d9e366f6',
};

/* The one account that may read everybody else's row. Changing this alone is
   not enough — the same address is hard-coded in firestore.rules, which is
   what actually enforces it, and in the ADMIN_EMAIL Vercel variable, which
   decides where the "new sign-in" notice is sent. */
export const ADMIN_EMAIL = 'akshatg9636@gmail.com';

/* A half-filled config fails at sign-in time with an opaque Firebase error, so
   check up front and stay quiet instead. */
export const isConfigured =
  Object.values(firebaseConfig).every((v) => v && !String(v).includes('REPLACE_'));
