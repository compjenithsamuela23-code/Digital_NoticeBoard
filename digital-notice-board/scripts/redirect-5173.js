const http = require('http');

const REDIRECT_PORT = Number(process.env.REDIRECT_PORT || 5173);
const TARGET_ORIGIN = process.env.REDIRECT_TARGET_ORIGIN || 'http://localhost:5001';

const server = http.createServer((req, res) => {
  const location = `${TARGET_ORIGIN}${req.url || '/'}`;
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end(`Redirecting to ${location}`);
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Redirect server listening on http://localhost:${REDIRECT_PORT} -> ${TARGET_ORIGIN}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
