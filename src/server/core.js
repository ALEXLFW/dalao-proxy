const request = require('request');
const path = require('path');
const querystring = require('querystring');
const _ = require('lodash');

const {
    joinUrl,
    addHttpProtocol,
    isStaticResouce,
    splitTargetAndPath,
    transformPath,
} = require('../utils');

let shouldCleanUpAllConnections;
// * Why collect connections?
// When switch cache option(or config options), HTTP/1.1 will use `Connection: Keep-Alive` by default,
// which will cause client former TCP socket conection still work, or in short, it makes hot reload did
// not work immediately.
let connections = [];
let plugins = [];

function _invokeMethod(target, method, ...args) {
    if (!target) return;
    const targetMethod = target[method];
    if (typeof targetMethod === 'function') {
        targetMethod.call(target, ...args)
    }
}

// base function for invoke all middlewares
function _invokeAllPlugins(functionName, ...args) {
    plugins.forEach(plugin => {
        _invokeMethod(plugin, functionName, ...args);
    });
}

function noop() { }

function nonCallback(next) { next && next(false); }

function interrupter(reason) {
    if (reason) {
        reject(new PluginInterrupt(reason));
    }
    else resolve(context);
}

/**
 * proxyRequestWrapper
 * @summary proxy life cycle flow detail
 * - Middleware: Resolve request params data          [life-cycle:onRequest]
 * - Route matching
 * - Middleware: Route matching result                [life-cycle:onRouteMatch]
 * - Route proxy
 * - Calculate proxy route
 * - Middleware: before proxy request                 [life-cycle:beforeProxy]
 * - Proxy request
 * - Collect request data received                    [life-cycle:onRequestData]
 * - Middleware: after proxy request                  [life-cycle:afterProxy]
 */
function proxyRequestWrapper(config) {
    shouldCleanUpAllConnections = true;

    function proxyRequest(req, res) {
        const {
            host,
            port,
            headers,
            proxyTable,
        } = config;

        const { method, url } = req;
        const { host: requestHost } = req.headers;
        const _request = request[method.toLowerCase()];
        let matched;

        if (!isStaticResouce(url)) {
            cleanUpConnections();
            collectConnections();
        }

        // set response CORS
        setHeaders();

        Promise.resolve()
            .then(() => {
                const context = {
                    config,
                    request: req,
                    response: res
                };
                return context;
            })

            /**
             * Middleware: on request arrived
             * @lifecycle onRequest
             * @param {Object} context
             * @returns {Object} context
             */
            .then(context => Middleware_onRequest(context))

            /**
             * Route matching
             * @resolve context.matched
             * @returns {Object} context
             */
            .then(context => {
                // Matching strategy
                const proxyPaths = Object.keys(proxyTable);
                let mostAccurateMatch;
                let matchingLength = url.length;
                for (let index = 0; index < proxyPaths.length; index++) {
                    const proxyPath = proxyPaths[index];
                    const matchReg = new RegExp(`^${proxyPath}(.*)`);
                    let matchingResult;
                    if (matchingResult = url.match(matchReg)) {
                        const currentLenth = matchingResult[1].length;
                        if (currentLenth < matchingLength) {
                            matchingLength = currentLenth;
                            mostAccurateMatch = proxyPaths[index];
                            matched = matchingResult;
                        }
                    }
                }

                let proxyPath;
                let matchedRoute;

                // Matched Proxy
                if (mostAccurateMatch) {
                    proxyPath = mostAccurateMatch;
                    matchedRoute = proxyTable[proxyPath];

                    context.matched = {
                        path: proxyPath,
                        route: matchedRoute,
                    };
                    return context;
                }

                // if the request not in the proxy table
                else {
                    Promise.reject('\n> 😫  Oops, dalao can\'t match any route'.red);
                }
            })

            /**
             * Route matching result
             * @param {Object} context
             * @param {Object} context.matched
             * @resolve context.matched
             * @returns {Object} context
             */
            .then(context => Middleware_onRouteMatch(context))

            /**
             * Calculate proxy route
             * @desc transform url
             * @param {Object} context
             * @param {Object} context.matched
             * @resolve context.proxy
             * @returns {Object} context
             */
            .then(context => {
                const { route: matchedRoute, path: matchedPath } = context.matched;
                // route config
                const {
                    path: overwritePath,
                    target: overwriteHost,
                    pathRewrite: overwritePathRewrite,
                } = matchedRoute;

                const { target: overwriteHost_target, path: overwriteHost_path } = splitTargetAndPath(overwriteHost);
                const proxyedPath = overwriteHost_target + joinUrl(overwriteHost_path, overwritePath, matched[0]);
                const proxyUrl = transformPath(addHttpProtocol(proxyedPath), overwritePathRewrite);

                // invalid request
                if (new RegExp(`\\b${host}:${port}\\b`).test(overwriteHost)) {
                    res.writeHead(403, {
                        'Content-Type': 'text/html; charset=utf-8'
                    });
                    res.end(`
                        <h1>🔴  403 Forbidden</h1>
                        <p>Path to ${overwriteHost} proxy cancelled</p>
                        <h3>Can NOT proxy request to proxy server address, which may cause endless proxy loop.</h3>
                    `);

                    return Promise.reject(`> 🔴   Forbidden Hit! [${matchedPath}]`.red);
                }

                context.proxy = {
                    route: matchedRoute,
                    uri: proxyUrl
                };
                return context;
            })

            /**
             * Middleware: before proxy request
             * @lifecycle beforeProxy
             * @param {Object} context
             * @returns {Object} context
             */
            .then(context => Middleware_beforeProxy(context))

            /**
             * Proxy request
             * @desc send request
             * @param {Object} context
             * @param {Object} context.matched
             * @param {Object} context.proxy
             * @resolve context.proxy.response
             * @returns {Object} context
             */
            .then(context => {
                const { uri: proxyUrl } = context.proxy;
                const { path: matchedPath } = context.matched;
                
                const proxyReq = _request(proxyUrl);
                const responseStream = req.pipe(proxyReq);
                responseStream.pipe(res);
                req.pipe(responseStream);
                // proxyReq.setHeader('Content-Length', Buffer.byteLength(context.data.rawBody));
                // responseStream.end(context.data.rawBody);
                console.log(`> 🎯   Hit! [${matchedPath}]`.green + `   ${method.toUpperCase()}   ${url}  ${'>>>>'.green}  ${proxyUrl}`.white)

                context.proxy.response = responseStream;
                return context;
            })

            /**
             * Collect request data received
             * @desc collect raw request data
             * @param {Object} context
             * @resolve context.data
             * @returns {Object} context
             */
            .then(context => collectRequestData(context))

            /**
             * Middleware: after proxy request
             * @lifecycle afterProxy
             * @param {Object} context
             * @returns {Object} context
             */
            .then(context => Middleware_afterProxy(context))
            .catch(error => {
                if (!error instanceof PluginInterrupt) {
                    console.error(error);
                }
            })


        /********************************************************/
        /* Functions in Content ------------------------------- */
        /********************************************************/

        function collectRequestData(context) {
            return new Promise((resolve, reject) => {
                const reqContentType = req.headers['content-type'];

                const data = {
                    rawBody: '',
                    body: '',
                    query: querystring.parse(url.split('?')[1] || ''),
                    type: reqContentType
                };
                context.data = data;
                req.on('data', chunk => data.rawBody += chunk);
                req.on('end', () => {
                    if (!data.rawBody) return;

                    try {
                        if (/application\/x-www-form-urlencoded/.test(reqContentType)) {
                            data.body = querystring.parse(data.rawBody);
                        } else if (/application\/json/.test(reqContentType)) {
                            data.body = JSON.parse(data.rawBody);
                        } else if (/multipart\/form-data/.test(reqContentType)) {
                            data.body = data.rawBody;
                        }
                        resolve(context);
                    } catch (error) {
                        reject(error);
                        console.log(' > Error: can\'t parse requset body. ' + error.message);
                    }
                });
            });
        }

        function setHeaders() {
            res.setHeader('Via', 'HTTP/1.1 dalao-proxy');
            res.setHeader('Access-Control-Allow-Origin', requestHost);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
            res.setHeader('Access-Control-Allow-Credentials', true);
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Token');

            for (const header in headers) {
                res.setHeader(header.split('-').map(item => _.upperFirst(item.toLowerCase())).join('-'), headers[header]);
            }
        }

        // collect socket connection
        function collectConnections() {
            const connection = req.connection;
            if (connections.indexOf(connection) === -1) {
                connections.push(connection);
            }
        }

        // destroy all tcp connections
        function cleanUpConnections() {
            if (shouldCleanUpAllConnections) {
                connections.forEach(connection => connection.destroy());
                connections = [];
                shouldCleanUpAllConnections = false;
            }
        }


        /********************************************************/
        /* Middleware Functions in Content --------------------- */
        /********************************************************/

        // after request data resolved
        function Middleware_onRequest(context) {
            return new Promise((resolve, reject) => {
                _invokeAllPlugins('onRequest', context, err => {
                    if (err) return reject(err);
                    else resolve(context);
                });
            });
        }

        // on route match
        function Middleware_onRouteMatch(context) {
            return new Promise((resolve, reject) => {
                _invokeAllPlugins('onRouteMatch', context, err => {
                    if (err) return reject(err);
                    else resolve(context);
                });
            });
        }

        function Middleware_beforeProxy(context) {
            return new Promise((resolve, reject) => {
                _invokeAllPlugins('beforeProxy', context, err => {
                    if (err) return reject(err);
                    else resolve(context);
                });
            });
        }

        function Middleware_afterProxy(context) {
            _invokeAllPlugins('afterProxy', context);
        }
    }

    (function Middleware_beforeCreate() {
        _invokeAllPlugins('beforeCreate');
    })();
    return proxyRequest;
}


/**
 * Install plugins as proxy middleware
 * @param {Array} plugins plugin name array to install
 */
function usePlugins(pluginNames) {
    plugins = [];
    pluginNames.forEach(pluginName => {
        plugins.push(new Plugin(pluginName));
    });
}

class Plugin {
    /**
     * @param {String} id id of plugin
     * @param {String} pluginName
     */
    constructor(pluginName, id) {
        this.middleware = {};
        this.id = id || pluginName;
        try {
            let match;
            if (match = pluginName.match(/^BuildIn\:plugin\/(.+)$/i)) {
                const buildInPluginPath = path.resolve('src', 'plugins', match[1]);
                this.middleware = require(buildInPluginPath);
            }
            else {
                this.middleware = require(pluginName);
            }
        } catch (error) {
            let buildIns;
            if (buildIns = error.message.match(/^Cannot\sfind\smodule\s'(.+)'$/)) {
                console.log(`${error.message}. Please check if module '${buildIns[1]}' is installed`.red);
            }
            else {
                console.error(error);
            }
        }
    }

    _methodWrapper(method, replacement, ...args) {
        if (this.middleware[method]) {
            _invokeMethod(this.middleware, method, ...args);
        }
        else {
            replacement(args[1]);
        }
    }

    beforeCreate(context) {
        this._methodWrapper('beforeCreate', noop, context);
    }

    onRequest(context, next) {
        this._methodWrapper('onRequest', nonCallback, context, next);
    }

    onRouteMatch(context, next) {
        this._methodWrapper('onRouteMatch', nonCallback, context, next);
    }

    beforeProxy(context, next) {
        this._methodWrapper('beforeProxy', nonCallback, context, next);
    }

    afterProxy(context) {
        this._methodWrapper('afterProxy', noop, context);
    }
}

class PluginInterrupt extends Error {
    constructor(message) {
        super(message);
    }
}

module.exports = {
    httpCallback: proxyRequestWrapper,
    usePlugins
}