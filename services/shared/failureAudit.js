// Record failed public mutations without storing bodies, passwords, or tokens.
function failureAudit(db, service) {
  return (req, res, next) => {
    const original = res.json.bind(res);
    res.json = function (body) {
      if (req.user && req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && res.statusCode >= 400) {
        const resource = req.path.match(/\/(?:orders|deliveries)\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
        db.query(`INSERT INTO admin_data.request_failures
          (service, actor_id, actor_role, resource_id, method, path, status_code, reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [service, req.user.id, req.user.role, resource || null, req.method, req.path.slice(0, 300), res.statusCode, String(body?.error || 'Request failed').slice(0, 1000)])
          .catch((error) => console.error('Failed to persist request audit:', error.message));
      }
      return original(body);
    };
    next();
  };
}
module.exports = { failureAudit };
