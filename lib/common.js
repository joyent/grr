/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var forkExecWait = require('forkexec').forkExecWait;
var path = require('path');
var VError = require('verror').VError;


// ---- support stuff

/// A split with sensible semantics for forEach().
function fsplit(str, separator) {
    return str.split(',').filter(function (s) { if (s !== '') return s; });
}

function objCopy(obj, target) {
    assert.object(obj, 'obj');
    assert.optionalObject(obj, 'target');

    if (target === undefined) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


function deepObjCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Resolve "~/..." and "~" to an absolute path.
 *
 * Limitations:
 * - This does not handle "~user/...".
 * - This depends on the HOME envvar being defined (%USERPROFILE% on Windows).
 */
function tildeSync(s) {
    var envvar = (process.platform === 'win32' ? 'USERPROFILE' : 'HOME');
    var home = process.env[envvar];
    if (!home) {
        throw new VError('cannot determine home dir: %s environment ' +
            'variable is not defined', envvar);
    }

    if (s === '~') {
        return home;
    } else if (s.slice(0, 2) === '~/' ||
        (process.platform === 'win32' && s.slice(0, 2) === '~'+path.sep))
    {
        return path.resolve(home, s.slice(2));
    } else {
        return s;
    }
}

function indent(s, indentation) {
    if (!indentation) {
        indentation = '    ';
    }
    var lines = s.split(/\r\n|\n|\r/g);
    return indentation + lines.join('\n' + indentation);
}

/*
 * A wrapper around forkExecWait that prints what it is doing.
 *
 * TODO: pass through all forkExecWait opts
 */
function forkExecWaitAndPrint(opts, cb) {
    assert.arrayOfString(opts.argv, 'opts.argv');
    assert.optionalBool(opts.indent, 'opts.indent');
    assert.optionalObject(opts.log, 'opts.log');

    var style = function (s) { return s; };
    if (opts.indent) {
        style = indent;
    }

    // TODO: do better on quoting
    console.log(style('$ ' + opts.argv.join(' ')));

    forkExecWait({argv: opts.argv}, function (err, info) {
        if (opts.log) {
            opts.log.trace({argv: opts.argv, err: err, info: info},
                'forkExecWait');
        }
        if (info.stdout) {
            console.log(style(info.stdout));
        }
        if (info.stderr) {
            console.error(style(info.stderr));
        }
        cb(err, info);
    });
}

function forkExecWaitAndLog(opts, cb) {
    assert.arrayOfString(opts.argv, 'opts.argv');
    assert.object(opts.log, 'opts.log');
    forkExecWait({argv: opts.argv}, function (err, info) {
        opts.log.trace({argv: opts.argv, err: err, info: info}, 'forkExecWait');
        cb(err, info);
    });
}


//---- exports

module.exports = {
    fsplit: fsplit,
    objCopy: objCopy,
    deepObjCopy: deepObjCopy,
    tildeSync: tildeSync,
    indent: indent,
    forkExecWaitAndPrint: forkExecWaitAndPrint,
    forkExecWaitAndLog: forkExecWaitAndLog
};

// vim: set softtabstop=4 shiftwidth=4:
