/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var assert = require('assert-plus');
var fs = require('fs');
var toml = require('toml');
var VError = require('verror').VError;

var common = require('./common');


var CONFIG_FILE = '~/.grrrc';
var CACHE_FILE = '~/.grrcache';


/**
 * Load the grr config. This is a TOML file at ~/.grrrc
 */
function loadConfigSync(opts) {
    assert.object(opts.log, 'opts.log');

    var config;
    var configPath = common.tildeSync(CONFIG_FILE);
    if (fs.existsSync(configPath)) {
        opts.log.trace({configPath: configPath}, 'loading grr config');
        var raw = fs.readFileSync(configPath, 'utf8');
        try {
            config = toml.parse(raw);
        } catch (e) {
            throw new VError(e, 'invalid config in "%s" at line %s, '
                + 'column %s: %s', CONFIG_FILE, e.line, e.column, e.message);
        }
    } else {
        config = {};
    }

    return config;
}

function loadCacheSync(opts) {
    assert.object(opts.log, 'opts.log');

    var cache;
    var cachePath = common.tildeSync(CACHE_FILE);
    if (fs.existsSync(cachePath)) {
        opts.log.trace({cachePath: cachePath}, 'loading grr cache');
        var raw = fs.readFileSync(cachePath, 'utf8');
        try {
            cache = JSON.parse(raw);
        } catch (err) {
            opts.log.trace({err: err, cachePath: cachePath}, 'invalid cache');
            fs.unlinkSync(cachePath);
            cache = {};
        }
    } else {
        cache = {};
    }

    return cache;
}

function saveCacheSync(opts) {
    assert.object(opts.log, 'opts.log');
    assert.object(opts.cache, 'opts.cache');

    var cachePath = common.tildeSync(CACHE_FILE);
    fs.writeFileSync(cachePath, JSON.stringify(opts.cache));
}



//---- exports

module.exports = {
    CONFIG_FILE: CONFIG_FILE,
    loadConfigSync: loadConfigSync,
    loadCacheSync: loadCacheSync,
    saveCacheSync: saveCacheSync
};

// vim: set softtabstop=4 shiftwidth=4:
