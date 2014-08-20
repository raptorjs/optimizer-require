'use strict';

var fs = require('fs');

var nextId = 0;

var Readable = require('stream').Readable;
var util = require('util');

function noop() {}

function DeferredStream(startFn, options) {
    var self = this;

    Readable.call(this, options);

    // When _read is called, we need to start pushing data
    self._read = function() {
        self._read = noop;
        startFn.call(self);
    };

    return self;
}

util.inherits(DeferredStream, Readable);

module.exports = DeferredStream;

function MockOptimizerContext() {
    this.attributes = {};
    this.phaseAttributes = {};
    var requireExtensions = {
        json: {
            object: true,
            reader: require('../lib/json-reader')
        }
    };

    this.dependencies = {
        getRegisteredRequireExtension: function(ext) {
            return requireExtensions[ext];
        }, 
        getRequireReader: function(ext) {
            var requireInfo = requireExtensions[ext];
            return requireInfo ? requireInfo.reader : null;
        }
    };
}

var MOCK_CACHE = {
    get: function(key, options, callback) {
        if (options.builder) {
            options.builder(callback);
        } else {
            callback();
        }
    },

    put: function(key, value, options) {

    }
};

MockOptimizerContext.prototype = {
    uniqueId: function() {
        return nextId++;
    },

    getFileLastModified: function(path, callback) {
        callback(null, -1);
    },

    cache: {
        getCache: function(name) {
            return MOCK_CACHE;
        }
    },

    isAsyncBundlingPhase: function() {
        return false;
    },

    cachingFs: {
        existsSync: function(filePath) {
            return fs.existsSync(filePath);
        }
    },

    deferredStream: function(startFn, options) {
        return new DeferredStream(startFn, options);
    }
};

module.exports = MockOptimizerContext;