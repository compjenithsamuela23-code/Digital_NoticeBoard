const { app, ensureRuntimeInitialized } = require('../index');

module.exports = async (req, res) => {
  try {
    await ensureRuntimeInitialized();
    if (typeof req.url === 'string' && !req.url.startsWith('/api')) {
      req.url = req.url.startsWith('/') ? `/api${req.url}` : `/api/${req.url}`;
    }
    return app(req, res);
  } catch (error) {
    console.error('❌ Serverless bootstrap error:', error);
    return res.status(500).json({ error: 'Server initialization failed.' });
  }
};
