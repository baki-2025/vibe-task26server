import admin from 'firebase-admin';

// There are two supported ways to provide credentials:
// 1) FIREBASE_SERVICE_ACCOUNT_BASE64 - base64-encoded JSON of your service account
// 2) FIREBASE_SERVICE_ACCOUNT_PATH   - path to the service account json file on disk
//
// To generate the file: Firebase Console -> Project Settings -> Service Accounts
// -> Generate new private key.
//
// To base64-encode it (so it can live safely in a single .env line):
//   macOS/Linux: base64 -i serviceAccountKey.json | tr -d '\n'
//   Windows (PowerShell): [Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccountKey.json"))

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      'base64'
    ).toString('utf-8');
    serviceAccount = JSON.parse(decoded);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const { readFileSync } = await import('fs');
    serviceAccount = JSON.parse(
      readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf-8')
    );
  }
} catch (error) {
  console.warn('⚠️  Firebase service account could not be parsed:', error.message);
}

if (serviceAccount) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
} else {
  console.warn(
    '⚠️  No Firebase service account provided. Set FIREBASE_SERVICE_ACCOUNT_BASE64 ' +
      'or FIREBASE_SERVICE_ACCOUNT_PATH in your .env file. Protected API routes will return a clear 503 error until then.'
  );
}

export const isFirebaseConfigured = () => admin.apps.length > 0;
export default admin;
