const roles = new Set(['CUSTOMER', 'RESTAURANT', 'DELIVERY_PARTNER', 'SUPER_ADMIN']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userAuth(jwt, { jwtSecret, jwtIssuer }) {
  function authenticate(req, res, next) {
    const match = /^Bearer (\S+)$/i.exec(req.get('Authorization') || '');
    if (!match) return res.status(401).json({ error: 'Authentication required.' });
    try {
      const claims = jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'], issuer: jwtIssuer });
      if (typeof claims.sub !== 'string' || !uuidPattern.test(claims.sub) || !roles.has(claims.role)) {
        throw new Error('Invalid token claims.');
      }
      req.user = { id: claims.sub.toLowerCase(), role: claims.role };
    } catch {
      return res.status(401).json({ error: 'Invalid or expired access token.' });
    }
    next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (req.user.role !== role) return res.status(403).json({ error: 'Access denied.' });
      next();
    };
  }

  return { authenticate, requireRole };
}

module.exports = { userAuth };
