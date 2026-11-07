// Create React App ONLY: react-scripts loads this file automatically on npm start.
// npm install --save-dev http-proxy-middleware@2
// Never put the API secret in REACT_APP_* or frontend source code.
const { createProxyMiddleware } = require('http-proxy-middleware');

const backend = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
const apiKey = process.env.BACKEND_API_KEY || '';

module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: backend,
      changeOrigin: true,
      secure: true,
      // POST /api/detect -> POST /detect; GET /api/health -> GET /health
      pathRewrite: { '^/api(?=/|$)': '' },
      onProxyReq(proxyReq) {
        proxyReq.setHeader('ngrok-skip-browser-warning', 'true');
        proxyReq.removeHeader('X-API-Key');
        if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
      },
      onError(err, req, res) {
        console.error('[FastAPI proxy]', req.method, req.url, err.message);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: 'FastAPI proxy unavailable. Check BACKEND_URL and backend server.' }));
        }
      },
    }),
  );
};
