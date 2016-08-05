#!/usr/bin/env node
/**
 * -*- mode: js -*-
 *
 * The `grr` CLI
 */

var assert = require('assert-plus');
var dashdash = require('dashdash');

var pkg = require('../package.json');


// ---- globals and constants

var options = [
    {
        name: 'version',
        type: 'bool',
        help: 'Print version and exit.'
    },
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    }
];


// ---- support functions


// ---- mainline

function main(argv) {
    var parser = dashdash.createParser({options: options});
    try {
        var opts = parser.parse(process.argv);
    } catch (e) {
        console.error('grr: error: %s', e.message);
        process.exit(1);
    }

    if (opts.help) {
        var help = parser.help({includeEnv: true}).trimRight();
        p('Filter a JSON object stream into a table, with a column for each\n'
            + 'key, or selected keys. The input must be either a JSON array\n'
            + 'of objects or a newline-separated JSON object with one object\n'
            + 'per line.\n'
            + '\n'
            + 'Usage:\n'
            + '    tabula [<options>] [<keys>...]\n'
            + '\n'
            + 'Options:\n'
            + help + '\n'
            + '\n'
            + 'Examples:\n'
            // JSSTYLED
            + '    $ echo \'[{"name":"Trent","age":41},{"name":"Ewan","age":7}]\' | tabula\n'
            + '    NAME   AGE\n'
            + '    Trent  41\n'
            + '    Ewan   7\n'
            + '\n'
            + '    # Explicit list columns. Use "lookup:name" to set column\n'
            + '    # header "name".\n'
            // JSSTYLED
            + '    $ echo \'[{"name":"Trent","age":41},{"name":"Ewan","age":7}]\' | tabula name age:YEARS\n'
            + '    NAME   YEARS\n'
            + '    Trent  41\n'
            + '    Ewan   7');
        process.exit(0);
    } else if (opts.version) {
        console.log('grr ' + pkg.version);
        console.log(pkg.homepage);
        process.exit(0);
    }

    XXX
}


// ---- exports

module.exports = {
    main: main
};

// vim: set softtabstop=4 shiftwidth=4:
