'use strict';

// Records every route registration made against Express while the application is
// being wired, then flattens them into "METHOD /full/path" strings.
//
// Express 5 layers do not retain the mount prefix they were created with, so the
// inventory cannot be recovered by walking app.router.stack after the fact. Instead
// this patches the shared router prototype before app.js is required and observes
// the registrations as they happen. Both app.get(...) and router.get(...) reach
// Router#route, so patching `route` and `use` covers every registration path.

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

function routerPrototypeOf(express) {
  let proto = Object.getPrototypeOf(express.Router());
  while (proto && !Object.getOwnPropertyNames(proto).includes('route')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) throw new Error('could not locate the Express router prototype');
  return proto;
}

function isRouter(value) {
  return typeof value === 'function' && Array.isArray(value.stack) && typeof value.handle === 'function';
}

function normalizePaths(path) {
  if (Array.isArray(path)) return path.flatMap(normalizePaths);
  if (typeof path === 'string') return [path];
  if (path instanceof RegExp) return [`(regexp:${path.source})`];
  return ['/'];
}

function joinPath(prefix, path) {
  const left = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const right = path === '/' ? '' : (path.startsWith('/') ? path : `/${path}`);
  return `${left}${right}` || '/';
}

// Patches Express in place. Call before requiring app.js, then call restore() so
// the rest of the suite sees an unpatched Express.
function startRecording(express) {
  const proto = routerPrototypeOf(express);
  const originalUse = proto.use;
  const originalRoute = proto.route;

  const ids = new WeakMap();
  let nextId = 0;
  const idOf = (router) => {
    if (!ids.has(router)) ids.set(router, `r${++nextId}`);
    return ids.get(router);
  };

  const mounts = [];      // { parent, prefix, child }
  const endpoints = [];   // { router, method, path }

  proto.use = function recordingUse(...args) {
    const hasPath = typeof args[0] === 'string' || Array.isArray(args[0]) || args[0] instanceof RegExp;
    const prefixes = hasPath ? normalizePaths(args[0]) : ['/'];
    for (const handler of args.slice(hasPath ? 1 : 0)) {
      if (!isRouter(handler)) continue;
      for (const prefix of prefixes) {
        mounts.push({ parent: idOf(this), prefix, child: idOf(handler) });
      }
    }
    return originalUse.apply(this, args);
  };

  proto.route = function recordingRoute(path) {
    const route = originalRoute.call(this, path);
    const routerId = idOf(this);
    const paths = normalizePaths(path);
    for (const method of HTTP_METHODS) {
      if (typeof route[method] !== 'function' || route[`__recorded_${method}`]) continue;
      const originalMethod = route[method];
      route[`__recorded_${method}`] = true;
      route[method] = function recordingRouteMethod(...handlers) {
        for (const one of paths) endpoints.push({ router: routerId, method, path: one });
        return originalMethod.apply(this, handlers);
      };
    }
    return route;
  };

  return {
    restore() {
      proto.use = originalUse;
      proto.route = originalRoute;
    },
    // Walks the mount graph from the app's own router, so every router reachable
    // from the app contributes its endpoints at each prefix it is mounted under.
    collect(app) {
      const rootId = ids.get(app.router || app._router);
      if (!rootId) return [];

      const childrenOf = new Map();
      for (const mount of mounts) {
        if (!childrenOf.has(mount.parent)) childrenOf.set(mount.parent, []);
        childrenOf.get(mount.parent).push(mount);
      }
      const endpointsOf = new Map();
      for (const endpoint of endpoints) {
        if (!endpointsOf.has(endpoint.router)) endpointsOf.set(endpoint.router, []);
        endpointsOf.get(endpoint.router).push(endpoint);
      }

      const found = new Set();
      const walk = (routerId, prefix, seen) => {
        if (seen.has(routerId)) return;
        const nextSeen = new Set(seen).add(routerId);
        for (const endpoint of endpointsOf.get(routerId) || []) {
          found.add(`${endpoint.method.toUpperCase()} ${joinPath(prefix, endpoint.path)}`);
        }
        for (const mount of childrenOf.get(routerId) || []) {
          walk(mount.child, joinPath(prefix, mount.prefix), nextSeen);
        }
      };
      walk(rootId, '/', new Set());

      return [...found].sort();
    },
  };
}

module.exports = { startRecording };
