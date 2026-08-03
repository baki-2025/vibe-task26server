// Usage: verifyRole(usersCollection, ['admin']) or verifyRole(usersCollection, ['buyer','admin'])
// Must run AFTER verifyToken, since it relies on req.decoded.email
const verifyRole = (usersCollection, allowedRoles = []) => {
  return async (req, res, next) => {
    try {
      const email = req.decoded?.email;
      if (!email) {
        return res.status(401).send({ message: 'unauthorized access' });
      }

      const user = await usersCollection.findOne({ email });

      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).send({ message: 'forbidden access' });
      }

      req.currentUser = user;
      next();
    } catch (error) {
      console.error('Role verification failed:', error.message);
      return res.status(500).send({ message: 'internal server error' });
    }
  };
};

export default verifyRole;
