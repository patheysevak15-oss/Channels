// Vercel entry point. vercel.json sends /proxy and every /api/* request here;
// the original path arrives in ?__route=.
const { createHandler } = require('../lib/core');
const { createStorage } = require('../lib/storage');

const handle = createHandler({ storage: createStorage('/tmp/sevaktv') });

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://vercel');
  const route = url.searchParams.get('__route') || url.pathname;
  url.searchParams.delete('__route');
  const pathname = route.startsWith('/') ? route : '/' + route;
  const handled = await handle(req, res, pathname, url.searchParams);
  if (!handled) {
    res.statusCode = 404;
    res.end('Not found');
  }
};
