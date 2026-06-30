const sessions = new Map(); // userId -> session object

function trackActivity(req, res, next) {
  if (req.user?.id) {
    sessions.set(req.user.id, {
      userId:       req.user.id,
      username:     req.user.username,
      role:         req.user.role,
      lastPath:     `${req.method} ${req.path}`,
      lastActivity: new Date(),
      ip:           req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown',
    });
  }
  next();
}

function getActiveSessions(thresholdMinutes = 30) {
  const cutoff = Date.now() - thresholdMinutes * 60 * 1000;
  const active = [];
  for (const [, s] of sessions) {
    if (new Date(s.lastActivity).getTime() > cutoff) active.push(s);
  }
  return active.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
}

function removeSession(userId) {
  sessions.delete(String(userId));
}

module.exports = { trackActivity, getActiveSessions, removeSession };
