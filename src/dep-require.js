'use strict';

var nodePath = require('path');
var ok = require('assert').ok;
var equal = require('assert').equal;
var VAR_REQUIRE_PROCESS = 'process=require("process")';
var inspectCache = require('./inspect-cache');
var Deduper = require('./util/Deduper');
var normalizeMain = require('lasso-modules-client/transport').normalizeMain;
var lassoCachingFS = require('lasso-caching-fs');

function buildAsyncInfo(path, asyncBlocks, lassoContext) {
    if (asyncBlocks.length === 0) {
        return null;
    }

    var key = 'require-async|' + path;

    var asyncInfo = lassoContext.data[key];

    if (!lassoContext.data[key]) {

        var asyncMeta = {};

        asyncBlocks.forEach(function(asyncBlock) {
            var uniqueId = lassoContext.uniqueId();
            var name = asyncBlock.name = '_' + uniqueId;
            asyncMeta[name] = asyncBlock.dependencies;
        });

        asyncInfo = lassoContext.data[key] = {
            asyncMeta: asyncMeta,
            asyncBlocks: asyncBlocks
        };
    }

    return asyncInfo;
}

function create(config, lasso) {
    config = config || {};
    var globals = config.globals;
    var resolver = config.resolver;
    var getClientPathInfo = config.getClientPathInfo;

    var readyDependency = lasso.dependencies.createDependency({
        type: 'commonjs-ready',
        inline: 'end'
    }, __dirname);

    var runtimeDependency = lasso.dependencies.createDependency({
        type: 'commonjs-runtime'
    }, __dirname);

    var processDependency = null;
    function getProcessDependency() {
        if (!processDependency) {
            processDependency = lasso.dependencies.createDependency({
                    type: 'require',
                    path: 'process',
                    from: __dirname
                }, __dirname);
        }
        return processDependency;
    }

    function handleMetaRemap(metaEntry, deduper) {
        var from = metaEntry.from;
        var to = metaEntry.to;

        var remapKey = deduper.remapKey(from, to);
        if (!deduper.hasRemap(remapKey)) {
            var fromPath = getClientPathInfo(from).logicalPath;
            var toPath;

            if (to === false) {
                toPath = false;
            } else {
                toPath = getClientPathInfo(to).logicalPath;
            }

            deduper.addDependency(remapKey, {
                type: 'commonjs-remap',
                from: fromPath,
                to: toPath
            });
        }
    }

    function handleMetaInstalled(metaEntry, deduper) {
        var packageName = metaEntry.packageName;
        var searchPath = metaEntry.searchPath;
        var basename = nodePath.basename(searchPath);

        if (basename === 'node_modules') {
            var parentPath = nodePath.dirname(searchPath);
            var childName = packageName;

            var pkg = lassoCachingFS.readPackageSync(nodePath.join(searchPath, packageName, 'package.json'));
            var childVersion = (pkg && pkg.version) || '0';

            let key = deduper.installedKey(parentPath, childName, childVersion);

            if (!deduper.hasInstalled(key)) {
                deduper.addDependency(key, {
                    type: 'commonjs-installed',
                    parentPath: parentPath,
                    childName: childName,
                    childVersion: childVersion
                });
            }

        } else {
            let key = deduper.searchPathKey(searchPath);
            if (!deduper.hasSearchPath(key)) {
                var searchPathInfo = getClientPathInfo(searchPath);

                // This is a non-standard standard search path entry
                deduper.addDependency(key, {
                    type: 'commonjs-search-path',
                    path: searchPathInfo.logicalPath
                });
            }
        }
    }

    function handleMetaMain(metaEntry, deduper) {
        var dir = metaEntry.dir;
        var main = metaEntry.main;

        var key = deduper.mainKey(dir, main);

        if (!deduper.hasMain(key)) {
            var dirClientPathInfo = getClientPathInfo(metaEntry.dir);
            // var mainClientPathInfo = getClientPathInfo(metaEntry.main);
            //
            // var relativePath = nodePath.relative(dirClientPathInfo.clientRealPath, mainClientPathInfo.clientRealPath);

            var relativePath = normalizeMain(metaEntry.dir, metaEntry.main);

            deduper.addDependency(key, {
                type: 'commonjs-main',
                dir: dirClientPathInfo.realPath,
                main: relativePath,
                _sourceFile: metaEntry.main
            });
        }
    }

    function handleMetaBuiltin(metaEntry, deduper) {
        var name = metaEntry.name;
        var target = metaEntry.target;

        var key = deduper.builtinKey(name, target);

        if (!deduper.hasBuiltin(key)) {
            var targetClientPathInfo = getClientPathInfo(metaEntry.target);

            deduper.addDependency(key, {
                type: 'commonjs-builtin',
                name: name,
                target: targetClientPathInfo.realPath,
                _sourceFile: metaEntry.target
            });
        }
    }

    function handleMeta(meta, deduper) {
        for (var i=0; i<meta.length; i++) {
            var metaEntry = meta[i];
            switch(metaEntry.type) {
                case 'remap':
                    handleMetaRemap(metaEntry, deduper);
                    break;
                case 'installed':
                    handleMetaInstalled(metaEntry, deduper);
                    break;
                case 'main':
                    handleMetaMain(metaEntry, deduper);
                    break;
                case 'builtin':
                    handleMetaBuiltin(metaEntry, deduper);
                    break;
                default:
                    throw new Error('Unsupported meta entry: ' + JSON.stringify(metaEntry));
            }
        }
    }
    return {
        properties: {
            path: 'string',
            from: 'string',
            run: 'boolean',
            wait: 'boolean',
            resolved: 'object'
        },

        init: function(lassoContext) {
            if (!this.path) {
                let error = new Error('Invalid "require" dependency. "path" property is required');
                console.error(module.id, error.stack, this);
                throw error;
            }

            if (!this.resolved) {
                var from = this.from || this.getParentManifestDir();
                var path = this.path;

                var fromFile = this.getParentManifestPath();
                this.resolved = resolver.resolveRequireCached(path, from, lassoContext);

                if (!this.resolved) {
                    throw new Error('Module not found: ' + path + ' (from "' + from + '" and referenced in ' + fromFile + ')');
                }

                this.meta = this.resolved.meta;
            }

            if (this.run === true) {
                if (this.wait == null && config.runImmediately === true) {
                    this.wait = false;
                }

                this.wait = this.wait !== false;
            }

            ok(this.path);

        },

        calculateKey() {
            // This is a unique key that prevents the same dependency from being
            // added to the dependency graph repeatedly
            var key = 'modules-require:' + this.path + '@' + this.from;
            if (this.run) {
                key += '|run';

                if (this.wait === false) {
                    key += '|wait';
                }
            }
            return key;
        },

        getDir: function() {
            return nodePath.dirname(this.resolved.path);
        },

        getRequireHandler: function(resolved, lassoContext) {
            // Use the file extension to get the information for the require
            var extension = nodePath.extname(resolved.path);
            if (extension) {
                extension = extension.substring(1); // Remove the leading dot
            }

            var requireHandler = lassoContext.dependencyRegistry.getRequireHandler(resolved.path, lassoContext);

            if (!requireHandler) {
                return null;
            }

            var createReadStream = requireHandler.createReadStream;
            var getLastModified = requireHandler.getLastModified;
            var object = requireHandler.object === true;

            var transforms = config.transforms;

            var transformedReader;

            if (transforms) {
                transformedReader = function () {
                    var inStream = createReadStream();
                    return transforms.apply(resolved.path, inStream, lassoContext);
                };
            } else {
                transformedReader = createReadStream;
            }

            return {
                createReadStream: transformedReader,
                getLastModified: getLastModified,
                object: object
            };
        },

        getDependencies: function(lassoContext) {
            ok(lassoContext, '"lassoContext" argument expected');

            var requireHandler;

            // the array of dependencies that we will be returning
            var dependencies = [];
            var deduper = new Deduper(lassoContext, dependencies);

            // Include client module system if needed and we haven't included it yet
            if (config.includeClient !== false) {
                deduper.addRuntime(runtimeDependency);
            }

            if (!lassoContext.isAsyncBundlingPhase()) {
                // Add a dependency that will trigger all of the deferred
                // run modules to run once all of the code has been loaded
                // for the page
                deduper.addReady(readyDependency);
            }

            var resolved = this.resolved;

            if (resolved.voidRemap) {
                // This module has been remapped to a void/empty object
                // because it is a server-side only module. Nothing
                // else to do.
                return [dependencies];
            }

            var run = this.run === true;
            var wait = this.wait !== false;

            if (resolved.type) {
                // This is not really a require dependency since a type was provided
                return [
                    {
                        type: resolved.type,
                        path: resolved.path
                    }
                ];
            }

            requireHandler = this.getRequireHandler(resolved, lassoContext);

            if (!requireHandler) {
                // This is not really a dependency that compiles down to a CommonJS module
                // so just add it to the dependency graph
                return [resolved.path];
            }

            var dirname = nodePath.dirname(resolved.path);

            if (this.meta) {
                handleMeta(this.meta, deduper);
            }

            return Promise.resolve()
                .then(() => {
                    // Fixes https://github.com/lasso-js/lasso-require/issues/21
                    // Static JavaScript objects should not need to be inspected
                    if (requireHandler.object) {
                        // Don't actually inspect the required module if it is an object.
                        // For example, this would be the case with require('./foo.json')
                        return requireHandler.getLastModified()
                            .then((lastModified) => {
                                return {
                                    createReadStream: requireHandler.createReadStream,
                                    lastModified: lastModified
                                };
                            });
                    }

                    return inspectCache.inspectCached(
                        resolved.path,
                        requireHandler.createReadStream,
                        requireHandler.getLastModified,
                        lassoContext,
                        config);
                })
                .then((inspectResult) => {
                    var asyncMeta;
                    var asyncBlocks;

                    if (inspectResult && inspectResult.asyncBlocks && inspectResult.asyncBlocks.length) {
                        var asyncInfo = buildAsyncInfo(resolved.path, inspectResult.asyncBlocks, lassoContext);
                        if (asyncInfo) {
                            asyncBlocks = asyncInfo.asyncBlocks;
                            asyncMeta = asyncInfo.asyncMeta;
                        }
                    }

                    // require was for a source file
                    var additionalVars;
                    ok(inspectResult,'inspectResult should not be null');

                    // the requires that were read from inspection (may remain undefined if no inspection result)
                    var requires = inspectResult.requires;

                    if (inspectResult.processGlobal) {
                        deduper.addProcess(getProcessDependency());
                        additionalVars = [VAR_REQUIRE_PROCESS];
                    }



                    ok(inspectResult.createReadStream, 'createReadStream expected after inspectResult');
                    ok(inspectResult.lastModified, 'lastModified expected after inspectResult');
                    equal(typeof inspectResult.lastModified, 'number', 'lastModified should be a number');

                    var defGlobals = globals ? globals[this.resolved.path] : null;



                    // Also check if the directory has an browser.json and if so we should include that as well
                    var lassoJsonPath = nodePath.join(dirname, 'browser.json');
                    if (lassoContext.cachingFs.existsSync(lassoJsonPath)) {
                        dependencies.push({
                            type: 'package',
                            path: lassoJsonPath
                        });
                    } else {
                        lassoJsonPath = nodePath.join(dirname, 'optimizer.json');
                        if (lassoContext.cachingFs.existsSync(lassoJsonPath)) {
                            dependencies.push({
                                type: 'package',
                                path: lassoJsonPath
                            });
                        }
                    }

                    // Include all additional dependencies (these were the ones found in the source code)
                    if (requires && requires.length) {
                        requires.forEach(function(inspectResultRequire) {
                            var inspectResultResolved = inspectResultRequire.resolved;

                            var meta = inspectResultResolved.meta;
                            if (meta) {
                                handleMeta(meta, deduper);
                            }

                            var path = inspectResultRequire.path;

                            var requireKey = deduper.requireKey(path, dirname);

                            if (!deduper.hasRequire(requireKey)) {
                                deduper.addDependency(requireKey, {
                                    type: 'require',
                                    path: inspectResultRequire.path,
                                    from: dirname,
                                    resolved: inspectResultResolved
                                });
                            }
                        });
                    }

                    var defKey = deduper.defKey(resolved.clientRealPath);

                    if (!deduper.hasDef(defKey)) {
                        var defDependency = {
                            type: 'commonjs-def',
                            path: resolved.clientRealPath,
                            file: resolved.path
                        };

                        if (additionalVars) {
                            defDependency._additionalVars = additionalVars;
                        }

                        if (requireHandler.object) {
                            // If true, then the module will not be wrapped inside a factory function
                            defDependency.object = true;
                        }

                        if (defGlobals) {
                            defDependency.globals = defGlobals;
                        }

                        // Pass along the createReadStream and the lastModified to the def dependency
                        defDependency.requireCreateReadStream = inspectResult.createReadStream;
                        defDependency.inspected = inspectResult;
                        defDependency.asyncBlocks = asyncBlocks;
                        defDependency.requireLastModified = inspectResult.lastModified;

                        deduper.addDependency(defKey, defDependency);
                    }


                    // Do we also need to add dependency to run the dependency?
                    if (run === true) {

                        var runKey = deduper.runKey(resolved.clientLogicalPath, wait);

                        if (!deduper.hasRun(runKey)) {
                            var runDependency = {
                                type: 'commonjs-run',
                                path: resolved.clientLogicalPath,
                                wait: wait,
                                file: resolved.path
                            };

                            if (wait === false) {
                                runDependency.wait = false;
                            }

                            deduper.addDependency(runKey, runDependency);
                        }
                    }

                    if (asyncMeta) {
                        return {
                            dependencies: dependencies,
                            async: asyncMeta,
                            dirname: nodePath.dirname(resolved.path),
                            filename: resolved.path
                        };
                    } else {
                        return dependencies;
                    }
                });
        }
    };
}

exports.create = create;