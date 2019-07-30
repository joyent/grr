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


// ---- custom option type (from dashdash/examples/)

function parseCommaSepStringNoEmpties(option, optstr, arg) {
    // JSSTYLED
    return arg.trim().split(/\s*,\s*/g)
        .filter(function (part) { return part; });
}

dashdash.addOptionType({
    name: 'commaSepString',
    takesArg: true,
    helpArg: 'STRING',
    parseArg: parseCommaSepStringNoEmpties
});

dashdash.addOptionType({
    name: 'arrayOfCommaSepString',
    takesArg: true,
    helpArg: 'STRING',
    parseArg: parseCommaSepStringNoEmpties,
    array: true,
    arrayFlatten: true
});


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
            + 'used for followup commits on an issue already commited to.',
        helpArg: 'STR'
    },
    {
        names: ['update', 'u'],
        type: 'bool',
        help: 'Re-check cached issue info. This is useful if the issue title '
            + 'was changed.',
        'default': false
    },
    {
        names: ['add-issues', 'a'],
        type: 'arrayOfCommaSepString',
        help: 'Add the given comma-separated list of issues to the commit.',
        helpArg: 'ISSUES'
    },
    {
        names: ['remove-issues', 'r'],
        type: 'arrayOfCommaSepString',
        // JSSTYLED
        help: 'Remove the given comma-separated list of issues from the commit.',
        helpArg: 'ISSUES'
    },
    // TODO
    //{
    //    names: ['commit', 'c'],
    //    type: 'bool',
    //    help: 'Commit local changes.',
    //    'default': false
    //},
    {
        group: 'When done with your CR'
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
        help: 'List outstanding code reviews for this repository.'
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
        '    grr [<options>] [<issue> [<extra-issues>]]',
        '                     # start or update a CR',
        '    grr -D           # delete feature branch, switch to master',
        '    grr -L           # list outstanding CRs for this repo',
        '',
        'Options:',
        help,
        '',
        'Where <issue> is a JIRA issue (the PROJ-123 name or the full URL) or a',
        'GitHub issue (the number, account/repo#num, or full URL).',
        '',
        'Examples:',
        '    grr TOOLS-123    # Start or update a branch and CR for this issue',
        //'    grr --commit TOOLS-123    # ... also commit uncommited changes',
        '    grr              # Update the current CR (using the cached issue)',
	'    grr -a TOOLS-124 # Add an extra issue to the current CR',
	'    grr -r TOOLS-124 # Remove an extra issue from the current CR',
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

function fatal(errmsg) {
    console.error('grr: error: %s', errmsg);
    process.exit(1);
}


// ---- mainline

function main(argv) {
    // 'actions' is plural because coming "submit" work might allow multiple.
    var actions = [];
    var issueArg;
    var addExtraIssueArgs;
    var removeExtraIssueArgs;
    var opts;

    try {
        opts = parser.parse(process.argv);
    } catch (e) {
        fatal(e.message);
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

    if (opts._args.length > 0 || opts.update || opts.add_issues ||
        opts.remove_issues)
    {
        actions.push('update-or-create');
        if (opts._args.length > 0) {
            issueArg = opts._args.shift();
        }
        addExtraIssueArgs = opts._args.slice();
        if (opts.add_issues) {
            addExtraIssueArgs = addExtraIssueArgs.concat(opts.add_issues);
        }
        if (opts.remove_issues) {
            removeExtraIssueArgs = opts.remove_issues;
        }
    }

    if (opts['delete']) {
        if (actions.length) {
            fatal('cannot delete (-D) when creating/updating a CR');
        }
        actions.push('delete');
    }

    if (opts.list) {
        if (actions.length) {
            fatal('cannot list (-L) when deleting (-D) or '
                + 'creating/updating a CR');
        }
        actions.push('list');
    }

    if (actions.length === 0) {
        actions.push('update-or-create');
    }

    // Only one action at a time for now.
    assert.equal(actions.length, 1,
        'incorrect number of actions: ' + JSON.stringify(actions));

    switch (actions[0]) {
        case 'list':
            grr.grrList({log: log}, mainFinish);
            break;
        case 'delete':
            grr.grrDelete({
                log: log,
                dryRun: opts.dry_run
            }, mainFinish);
            break;
        case 'update-or-create':
            grr.grrUpdateOrCreate({
                log: log,
                issueArg: issueArg,
                parenthetical: opts.parenthetical,
                addExtraIssueArgs: addExtraIssueArgs,
                removeExtraIssueArgs: removeExtraIssueArgs,
                dryRun: opts.dry_run,
                commit: opts.commit,
                update: opts.update
            }, mainFinish);
            break;
        default:
            fatal('what action is this? ' + actions[0]);
            break;
    }
}


// ---- exports

module.exports = {
    main: main
};

// vim: set softtabstop=4 shiftwidth=4:
