import admin, { isFirebaseConfigured } from '../config/firebaseAdmin.js';

// Verifies the Firebase ID token sent as: Authorization: Bearer <token>
// On success, attaches the decoded token to req.decoded (contains req.decoded.email)
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  if (!isFirebaseConfigured()) {
    return res.status(503).send({
      message: 'Firebase Admin is not configured. Add FIREBASE_SERVICE_ACCOUNT_BASE64 to server/.env.',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).send({ message: 'unauthorized access' });
  }
};

export default verifyToken;
