/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The `grr` CLI
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var vasync = require('vasync');
var VError = require('verror').VError;

var grr = require('./grr');
var pkg = require('../package.json');


// ---- globals and constants

var log = bunyan.createLogger({
    name: 'grr',
    level: 'warn',
    stream: process.stderr
});

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
    },
    {
        names: ['verbose', 'v'],
        type: 'bool',
        help: 'Verbose debugging output. Try `grr -v ... 2>&1 | bunyan`.'
    },
    {
        group: 'For creating/updating CRs'
    },
    //{
    //    names: ['dry-run', 'n'],
    //    type: 'bool',
    //    help: 'Go through the motions without actually commiting or pushing.',
    //    'default': false
    //},
    {
        names: ['parenthetical', 'p'],
        type: 'string',
        help: 'Add a parenthetical comment to the commit message. Typically '
            + 'used for followup commits on an issue already commited to.'
    },
    {
        names: ['update', 'u'],
        type: 'bool',
        help: 'Re-check cached issue info. This is useful if the issue title '
            + 'was changed.',
        'default': false
    },
    // TODO
    //{
    //    names: ['commit', 'c'],
    //    type: 'bool',
    //    help: 'Commit local changes.',
    //    'default': false
    //},
    {
        group: 'When done your CR'
    },
    {
        names: ['delete', 'D'],
        type: 'bool',
        help: 'Delete the local branch used for working with the CR. '
            + 'Typically this is used when you are done with the CR.'
    },
    {
        group: 'Miscellaneous CR operations'
    },
    {
        names: ['list', 'L'],
        type: 'bool',
        help: 'List outstanding code reviews for this component.'
    }
];

var parser = dashdash.createParser({options: options});


// ---- support functions

function usage() {
    var help = parser.help({includeEnv: true}).trimRight();
    /* BEGIN JSSTYLED */
    console.log([
        'Opinionated hand-holding of code review (CR) mechanics in Joyent\'s',
        'Gerrit at <https://cr.joyent.us>.',
        '',
        'Usage:',
        '    grr [<options>] [<issue>]  # create or update a CR',
        '    grr -D [<issue>]           # delete feature branch, switch to master',
        '    grr -L                     # list outstanding CRs for this component.',
        '',
        'Options:',
        help,
        '',
        'Where <issue> is a JIRA issue (the PROJ-123 name or the full URL) or a',
        'GitHub issue (the number, account/repo#num, or full URL).',
        '',
        'Examples:',
        '    grr TOOLS-123    # Start or update a branch and CR for this ticket',
        //'    grr --commit TOOLS-123    # ... also commit uncommited changes',
        '    grr              # Update the current CR (using the cached ticket)',
        '    grr -D           # All done. Del the branch and switch back to master'
    ].join('\n'));
    /* END JSSTYLED */
}


function mainFinish(err) {
    if (err) {
        var exitStatus = err.exitStatus || 1;
        var showErrStack = (log.level() <= bunyan.DEBUG); // use --verbose
        console.error('grr: error: %s',
            (showErrStack ? err.stack : err.message));

        // Use a soft exit (i.e. just set `process.exitCode`) if supported.
        var supportsProcessExitCode = true;
        var nodeVer = process.versions.node.split('.').map(Number);
        if (nodeVer[0] === 0 && nodeVer[1] <= 10) {
            supportsProcessExitCode = false;
        }
        if (supportsProcessExitCode) {
            process.exitCode = exitStatus;
        } else if (exitStatus !== 0) {
            process.exit(exitStatus);
        }
    }
}


// ---- mainline

function main(argv) {
    try {
        var opts = parser.parse(process.argv);
    } catch (e) {
        console.error('grr: error: %s', e.message);
        process.exit(1);
    }

    if (opts.help) {
        usage();
        process.exit(0);
    } else if (opts.version) {
        console.log('grr ' + pkg.version);
        console.log(pkg.homepage);
        process.exit(0);
    }

    if (opts.verbose) {
        log.level('trace');
        log.src = true;
    }

    var issueArg;
    if (opts._args.length) {
        issueArg = opts._args.shift();
    }
    if (opts._args.length) {
        console.error('grr: error: extraneous arguments: %s', opts._args);
        process.exit(1);
    }

    if (opts['delete']) {
        grr.grrDelete({
            log: log,
            issueArg: issueArg,
            dryRun: opts.dry_run
        }, mainFinish);
    } else if (opts['list']) {
        grr.grrList({log: log}, mainFinish);
    } else {
        grr.grrUpdateOrCreate({
            log: log,
            issueArg: issueArg,
            parenthetical: opts.parenthetical,
            dryRun: opts.dry_run,
            commit: opts.commit,
            update: opts.update
        }, mainFinish);
    }
}


// ---- exports

module.exports = {
    main: main
};

// vim: set softtabstop=4 shiftwidth=4:
