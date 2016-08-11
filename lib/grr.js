/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * `grr` library functionality.
 */

var assert = require('assert-plus');
var forkExecWait = require('forkexec').forkExecWait;
var request = require('request');
var strsplit = require('strsplit');
var vasync = require('vasync');
var VError = require('verror').VError;

var common = require('./common');
var config = require('./config');


// ---- globals and constants

// For now I'm assuming 'master' is always the reference/production branch.
var MASTER = 'master';

// Hardcoded for Joyent eng usage right now.
var JIRA_URL = 'https://devhub.joyent.com/jira';


// ---- internal support functions

function stepGetGrrConfig(arg, cb) {
    try {
        arg.grrConfig = config.loadConfigSync({log: arg.log});
    } catch (e) {
        cb(e);
        return;
    }
    cb();
}

function stepGetGrrCache(arg, cb) {
    try {
        arg.grrCache = config.loadCacheSync({log: arg.log});
    } catch (e) {
        cb(e);
        return;
    }
    cb();
}


/*
 * The gerrit user name is needed in the proper 'cr' remote URL. We take it
 * from the config (if set manually) or detect and cache it if we can.
 */
function stepGetGerritUsername(arg, cb) {
    if (arg.grrConfig.gerrit && arg.grrConfig.gerrit.username) {
        arg.gerritUsername = arg.grrConfig.gerrit.username;
        arg.log.trace({gerritUsername: arg.gerritUsername},
            'gerritUsername from config');
        cb();
        return;
    } else if (arg.grrCache.gerritUsername) {
        arg.gerritUsername = arg.grrCache.gerritUsername;
        arg.log.trace({gerritUsername: arg.gerritUsername},
            'gerritUsername from cache');
        cb();
        return;
    }

    /*
     * Attempt to guess it from 'ssh cr.joyent.us' which can have this stderr:
     *
     *   ****    Welcome to Gerrit Code Review    ****
     *
     *   Hi Trent Mick, you have successfully connected over SSH.
     *
     *   Unfortunately, interactive shells are disabled.
     *   To clone a hosted Git repository, use:
     *
     *   git clone ssh://trentm@cr.joyent.us/REPOSITORY_NAME.git
     */
    forkExecWait({
        argv: ['ssh', '-q', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-p', '29418', 'cr.joyent.us']
    }, function (err, res) {
        if (res && res.stderr) {
            var re = /ssh:\/\/(.*?)@cr.joyent.us\/REPOSITORY_NAME.git/;
            var match = re.exec(res.stderr);
            if (match) {
                arg.gerritUsername = match[1];
                arg.log.trace({gerritUsername: arg.gerritUsername},
                    'gerritUsername from ssh');
                arg.grrCache['gerritUsername'] = arg.gerritUsername;
                config.saveCacheSync({
                    log: arg.log,
                    cache: arg.grrCache
                });
                cb();
                return;
            }
        }

        cb(new VError(
            'cannot determine your gerrit username, please add this to "%s":\n'
            + '        [gerrit]\n'
            + '        username = "<your gerrit/github username>"',
            config.CONFIG_FILE));
    });
}

/*
 * $ git symbolic-ref HEAD
 * refs/heads/master
 *
 * We want the 'master' part. Assert the lead is 'refs/heads', else I don't
 * grok something about git branches. `grr` doesn't work on a detached head.
 */
function stepGetGitBranch(arg, cb) {
    assert.object(arg.log, 'arg.log');

    forkExecWait({
        argv: ['git', 'symbolic-ref', 'HEAD']
    }, function (err, res) {
        if (err) {
            cb(new VError(err, 'cannot determine current git branch '
                + '(grr does not work on a detached HEAD)'));
            return;
        }
        var ref = res.stdout.trim();
        var match = /^refs\/heads\/(.*)$/.exec(ref);
        if (!match) {
            cb(new VError('unexpected git symbolic-ref: %s', ref));
            return;
        }
        arg.gitBranch = match[1];
        arg.log.trace({gitBranch: arg.gitBranch}, 'gitBranch');
        cb();
    });
}

function stepGetGitRemotes(arg, cb) {
    forkExecWait({
        argv: ['git', 'remote']
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        arg.gitRemotes = res.stdout.trim().split(/\n/g);
        arg.log.trace({gitRemotes: arg.gitRemotes}, 'gitRemotes');
        cb();
    });
}

function stepGetGitRemoteUrlCr(arg, cb) {
    if (arg.gitRemotes.indexOf('cr') === -1) {
        arg.gitRemoteUrlCr = null;
        cb();
        return;
    }

    forkExecWait({
        argv: ['git', 'remote', 'get-url', 'cr']
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        arg.gitRemoteUrlCr = res.stdout.trim();
        arg.log.trace({gitRemoteUrlCr: arg.gitRemoteUrlCr}, 'gitRemoteUrlCr');
        cb();
    });
}


function stepGetGitRemoteUrlOrigin(arg, cb) {
    forkExecWait({
        argv: ['git', 'remote', 'get-url', 'origin']
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        arg.gitRemoteUrlOrigin = res.stdout.trim();
        arg.log.trace({gitRemoteUrlOrigin: arg.gitRemoteUrlOrigin},
            'gitRemoteUrlOrigin');
        cb();
    });
}

/*
 * Infer this from the 'origin' remote URL. Examples:
 *
 *      https://github.com/joyent/sdc-imgapi.git
 *      git@github.com:joyent/sdc-imgapi.git
 */
function stepGetRepoName(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitRemoteUrlOrigin, 'arg.gitRemoteUrlOrigin');

    var patterns = [
        new RegExp('github\.com:([^:]+)\.git$'),
        new RegExp('github\.com\/(.+)\.git$')
    ];

    for (var i = 0; i < patterns.length; i++) {
        var match = patterns[i].exec(arg.gitRemoteUrlOrigin);
        if (match) {
            arg.repoName = match[1];
            arg.log.trace({repoName: arg.repoName}, 'repoName');
            cb();
            return;
        }
    }

    cb(new VError('could not determine repo name from origin URL: %s',
        arg.gitRemoteUrlOrigin));
}

/*
 * Ensure this repo has a 'cr' remote pointing to cr.joyent.us as appropriate.
 */
function stepEnsureCrRemote(arg, cb) {
    assert.optionalString(arg.gitRemoteUrlCr, 'arg.gitRemoteUrlCr');
    assert.string(arg.gerritUsername, 'arg.gerritUsername');
    assert.string(arg.repoName, 'arg.repoName');

    var expectedCrRemote = arg.gerritUsername + '@cr.joyent.us:'
        + arg.repoName + '.git';

    if (arg.gitRemoteUrlCr === null) {
        // No 'cr' remote: git remote add cr ...
        console.log('Adding "cr" git remote: %s', expectedCrRemote);
        forkExecWait({
            argv: ['git', 'remote', 'add', 'cr', expectedCrRemote]
        }, function (err, res) {
            cb(err);
        });
    } else if (arg.gitRemoteUrlCr === '') {
        // Empty 'cr' URL: git remote set-url cr ...
        console.log('Setting "cr" git remote url: %s', expectedCrRemote);
        forkExecWait({
            argv: ['git', 'remote', 'cr', 'set-url', expectedCrRemote]
        }, function (err, res) {
            cb(err);
        });
    } else if (arg.gitRemoteUrlCr !== expectedCrRemote) {
        cb(new VError(
            'unexpected "cr" remote url: "%s" (expected it to be "%s")',
            arg.gitRemoteUrlCr, expectedCrRemote));
    } else {
        cb();
    }
}


function getBranchConfigKey(key, arg, cb) {
    assert.string(key, 'key');
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    if (arg.gitBranch === MASTER) {
        // Thou shalt not have grr config on the master branch.
        cb(null, '');
        return;
    }

    forkExecWait({
        argv: ['git', 'config', '--local', 'branch.'+arg.gitBranch+'.'+key]
    }, function (err, res) {
        if (err && !(res && res.status === 1)) {
            // From `git help config`: "the section or key is invalid (ret=1),"
            cb(err);
            return;
        }
        cb(null, res.stdout.trim());
    });
}

/*
 * grr stores per-branch config in local .git/config in a git repo. Get
 * the config for the current `gitBranch`. It looks like this:
 *
 * [branch "grr/TOOLS-1516"]
 *     issue = TOOLS-1516
 *     title = testing 1 2 3 grr
 *
 * Get the stored 'issue' for this branch, if any.
 */
function stepGetBranchConfigIssue(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    getBranchConfigKey('issue', arg, function (err, val) {
        if (err) {
            cb(err);
        } else {
            arg.branchConfigIssue = val;
            arg.log.trace({branchConfigIssue: arg.branchConfigIssue},
                'branchConfigIssue');
            cb();
        }
    });
}

function stepGetBranchConfigTitle(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    getBranchConfigKey('title', arg, function (err, val) {
        if (err) {
            cb(err);
        } else {
            arg.branchConfigTitle = val;
            arg.log.trace({branchConfigTitle: arg.branchConfigTitle},
                'branchConfigTitle');
            cb();
        }
    });
}

function stepGetBranchConfigParenthetical(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    getBranchConfigKey('parenthetical', arg, function (err, val) {
        if (err) {
            cb(err);
        } else {
            arg.branchConfigParenthetical = val;
            arg.log.trace(
                {branchConfigParenthetical: arg.branchConfigParenthetical},
                'branchConfigParenthetical');
            cb();
        }
    });
}

function stepGetBranchConfigLastPushedSha(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    getBranchConfigKey('lastPushedSha', arg, function (err, val) {
        if (err) {
            cb(err);
        } else {
            arg.branchConfigLastPushedSha = val;
            arg.log.trace(
                {branchConfigLastPushedSha: arg.branchConfigLastPushedSha},
                'branchConfigLastPushedSha');
            cb();
        }
    });
}

function stepGetBranchConfigCr(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    getBranchConfigKey('cr', arg, function (err, val) {
        if (err) {
            cb(err);
        } else {
            arg.branchConfigCr = val;
            arg.log.trace(
                {branchConfigCr: arg.branchConfigCr},
                'branchConfigCr');
            cb();
        }
    });
}


function setBranchConfigKey(key, val, arg, cb) {
    assert.string(key, 'key');
    assert.object(arg.log, 'arg.log');
    assert.string(arg.issueBranch, 'arg.issueBranch');

    forkExecWait({
        argv: ['git', 'config', '--local',
            'branch.' + arg.issueBranch + '.' + key, val]
    }, function (err, res) {
        if (err) {
            cb(err);
        } else {
            arg.log.trace({branch: arg.issueBranch, key: key, val: val},
                'setBranchConfigKey');
            cb();
        }
    });
}

function stepSetBranchConfigCr(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigIssue, 'arg.branchConfigIssue');
    assert.string(arg.cr, 'arg.cr');

    if (arg.branchConfigCr === arg.cr) {
        cb();
        return;
    }
    arg.branchConfigCr = arg.cr;
    setBranchConfigKey('cr', arg.cr, arg, cb);
}

function stepSetBranchConfigLastPushedSha(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigIssue, 'arg.branchConfigIssue');
    assert.string(arg.lastPushedSha, 'arg.lastPushedSha');

    if (arg.branchConfigLastPushedSha === arg.lastPushedSha) {
        cb();
        return;
    }
    arg.branchConfigLastPushedSha = arg.lastPushedSha;
    setBranchConfigKey('lastPushedSha', arg.lastPushedSha, arg, cb);
}

function stepSetBranchConfigIssue(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigIssue, 'arg.branchConfigIssue');
    assert.string(arg.issue, 'arg.issue');

    if (arg.branchConfigIssue === arg.issue) {
        cb();
        return;
    }
    arg.branchConfigIssue = arg.issue;
    setBranchConfigKey('issue', arg.issue, arg, cb);
}

function stepSetBranchConfigTitle(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigTitle, 'arg.branchConfigTitle');
    assert.string(arg.issue, 'arg.issue');

    if (arg.branchConfigTitle === arg.issueTitle) {
        cb();
        return;
    }
    arg.branchConfigTitle = arg.issueTitle;
    setBranchConfigKey('title', arg.issueTitle, arg, cb);
}

function stepSetBranchConfigParenthetical(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigParenthetical,
        'arg.branchConfigParenthetical');
    assert.string(arg.issue, 'arg.issue');

    if (!arg.parenthetical ||
        arg.branchConfigParenthetical === arg.parenthetical)
    {
        cb();
        return;
    }
    arg.branchConfigParenthetical = arg.parenthetical;
    setBranchConfigKey('parenthetical', arg.parenthetical, arg, cb);
}

/*
 * Example:
 *      curl -i -u trent.mick \
 *          https://devhub.joyent.com/jira/rest/api/2/issue/TOOLS-1516 | json
 */
function getJiraIssue(opts, cb) {
    assert.object(opts.log, 'opts.log');
    assert.object(opts.grrConfig, 'opts.grrConfig');
    assert.string(opts.grrConfig.jira.username, 'opts.grrConfig.jira.username');
    assert.string(opts.grrConfig.jira.password, 'opts.grrConfig.jira.password');
    assert.string(opts.issue, 'opts.issue');

    var url = JIRA_URL + '/rest/api/2/issue/' + encodeURIComponent(opts.issue);
    request.get(url, {
        auth: {
            username: opts.grrConfig.jira.username,
            password: opts.grrConfig.jira.password
        }
    }, function (err, res, body) {
        //opts.log.trace({err: err, res: res}, 'getJiraIssue response');
        if (err) {
            cb(new VError(err, 'could not retrieve issue %s info', opts.issue));
            return;
        } else if (res.statusCode === 404) {
            cb(new VError(err, 'no such issue %s', opts.issue));
            return;
        } else if (res.statusCode !== 200) {
            cb(new VError('unexpected Jira response status for issue %s: %s',
                opts.issue, res.statusCode));
            return;
        }
        try {
            var issueInfo = JSON.parse(body);
        } catch (parseErr) {
            cb(parseErr);
            return;
        }
        cb(null, issueInfo);
    });
}

/*
 * If on master, then we want to create and switch to `grr/$issue`. If that
 * exists already, then blow up.
 *
 * TODO: implement --force later (see TODO.txt scenario using --force)
 * TODO: If a parenthetical, might reasonably already have a grr branch
 *      for this ticket. If so, then incr to `grr/${issue}a`, `...b`, etc.
 *
 * Sets `arg.issueBranch`.
 */
function stepEnsureOnIssueBranch(arg, cb) {
    assert.string(arg.issue, arg.issue);

    if (arg.gitBranch !== MASTER) {
        arg.issueBranch = arg.gitBranch;
        cb();
        return;
    }

    arg.issueBranch = 'grr/' + arg.issue;
    console.log('Creating branch for CR: %s', arg.issueBranch);

    // XXX Handle case of that existing already.
    forkExecWait({
        argv: ['git', 'checkout', '-b', arg.issueBranch]
    }, function (err, res) {
        cb(err);
    });
}


function isGrrBranch(s) {
    var grrBranchRe = /^grr\/([^\/]+)$/;  // e.g. 'grr/TOOLS-123'
    return (grrBranchRe.test(s));
}

/*
 * I don't know a good way to see if this section exists before just deleting
 * it. So we will ignore the error if it doesn't exist:
 *
 *  $ git config --local --remove-section branch.grr/TOOLS-1516
 *  fatal: No such section!
 *  $ echo $?
 *  128
 */
function stepRemoveBranchConfig(arg, cb) {
    assert.string(arg.gitBranch, 'arg.gitBranch');

    console.log('Removing grr config for branch "%s"', arg.gitBranch);
    forkExecWait({
        argv: ['git', 'config', '--local', '--remove-section',
            'branch.' + arg.gitBranch]
    }, function (err, res) {
        if (err && res.stderr.indexOf('fatal: No such section!') === -1) {
            cb(err);
        } else {
            cb();
        }
    });
}

/*
 * Delete this branch and switch to master... but *only* if this is a grr/$issue
 * branch.
 */
function stepDeleteGitBranchIfGrr(arg, cb) {
    assert.string(arg.gitBranch, 'arg.gitBranch');

    if (!isGrrBranch(arg.gitBranch)) {
        cb();
        return;
    }

    console.log('Deleting local grr branch "%s"', arg.gitBranch);
    forkExecWait({
        argv: ['git', 'checkout', MASTER]
    }, function (checkoutErr) {
        if (checkoutErr) {
            cb(checkoutErr);
            return;
        }
        common.forkExecWaitAndPrint({
            argv: ['git', 'branch', '-D', arg.gitBranch],
            indent: true
        }, function (err) {
            cb(err);
        });
    });
}

function stepGetGitCommits(arg, cb) {
    forkExecWait({
        argv: ['git', 'log', '--pretty=oneline', MASTER + '..']
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        var lines = [];
        if (res.stdout.trim()) {
            lines = res.stdout.trim().split(/\n/g);
        }
        var commits = lines.map(function (line) {
            var split = strsplit(line, / /, 2);
            return {sha: split[0], title: split[1]};
        });
        arg.gitCommits = commits;
        arg.log.trace({gitCommits: arg.gitCommits}, 'gitCommits');
        cb();
    });
}

/*
 * Create or update the CR. Generally this is:
 * - create grr/auto/$issue branch
 * - determine correct commit message:
 *     (a) possibly update title from the issue (if `-u` used)
 *     (b) from local git config values
 *     (c) gathered "Reviewed by" from gerrit
 * - squash merge and/or ammend commit message, if necessary
 * - push to gerrit
 * - parse out the CR num and set local git config:
 *     grr.$branch.cr=$cr
 * - update git config branch.$branch.lastPushedSha=$sha
 * - delete grr/auto/$issue branch
 */
function stepCreateUpdateCr(arg, cb) {
    assert.object(arg, 'arg');
    assert.object(arg.log, 'arg.log');
    assert.bool(arg.dryRun, 'arg.dryRun');
    assert.string(arg.issue, 'arg.issue');
    assert.optionalString(arg.branchConfigCr, 'arg.branchConfigCr');
    assert.func(cb, 'cb');

    if (arg.dryRun) {
        cb(new VError('"dryRun" option is not yet supported'));
        return;
    }

    var grrAutoBranch = 'grr/auto/' + arg.issue;
    var commitMsg = arg.issue + ' ' + arg.issueTitle;
    if (arg.branchConfigParenthetical) {
        commitMsg += ' (' + arg.branchConfigParenthetical + ')';
    }
    var gitBranches;
    var createdNewCr = false;

    vasync.pipeline({arg: arg, funcs: [
        function getBranches(_, next) {
            forkExecWait({
                argv: ['git', 'branch', '--list']
            }, function (err, res) {
                if (err) {
                    next(err);
                } else {
                    var lines = res.stdout.trimRight().split(/\n/g);
                    gitBranches = lines.map(function (line) {
                        return line.slice(2);
                    });
                }
                arg.log.trace({gitBranches: gitBranches}, 'gitBranches');
                next();
            });
        },
        function printOpener(_, next) {
            if (arg.branchConfigCr) {
                console.log('Updating CR %s:', arg.branchConfigCr);
            } else {
                console.log('Creating CR:');
            }
            next();
        },

        function squashEm(_, next) {
            var cmds = [
                // TODO: if staged stuff, then might need a stash save/pop here
                ['git', 'checkout', '-t', MASTER, '-b', grrAutoBranch],
                ['git', 'merge', '--squash', arg.issueBranch],
                ['git', 'commit', '-m', commitMsg]
            ];
            if (gitBranches.indexOf(grrAutoBranch) !== -1) {
                cmds.unshift(['git', 'branch', '-D', grrAutoBranch]);
            }
            // TODO: after comfort with grr, make this all less verbose.
            vasync.forEachPipeline({
                inputs: cmds,
                func: function execIt(argv, next2) {
                    common.forkExecWaitAndPrint({
                        argv: argv,
                        indent: true
                    }, next2);
                }
            }, next);
        },

        function pushIt(_, next) {
            if (arg.branchConfigCr) {
                common.forkExecWaitAndPrint({
                    argv: ['git', 'push', 'cr',
                        'HEAD:refs/changes/' + arg.branchConfigCr],
                    indent: true
                }, next);
            } else {
                // Create CR and parse out and save the CR num.
                common.forkExecWaitAndPrint({
                    argv: ['git', 'push', 'cr', 'HEAD:refs/for/master'],
                    indent: true
                }, function (err, res) {
                    if (err) {
                        next(err);
                    } else {
                        /*
                         * Expect to have some stdout output including this:
                         *   remote:   https://cr.joyent.us/272 TOOLS-1516 t...
                         */
                        var re = /^remote:   https:\/\/cr\.joyent\.us\/(\d+) /m;
                        var match = re.exec(res.stderr);
                        if (!match) {
                            next(new VError('could not determine created CR '
                                + 'num from "git push" output: %s',
                                JSON.stringify(res.stderr)));
                        } else {
                            createdNewCr = true;
                            arg.cr = match[1];
                            arg.log.trace({cr: arg.cr}, 'cr');
                            stepSetBranchConfigCr(arg, next);
                        }
                    }
                });
            }
        },

        function setLastPushedSha(_, next) {
            arg.lastPushedSha = arg.gitCommits[0].sha;
            next();
        },
        stepSetBranchConfigLastPushedSha,

        function printResult(_, next) {
            console.log('CR %s: %s <https://cr.joyent.us/%s>',
                (createdNewCr ? 'created' : 'updated'),
                arg.branchConfigCr, arg.branchConfigCr);
            next();
        }
    ]}, function (err) {
        // Clean up
        vasync.forEachPipeline({
            inputs: [
                ['git', 'checkout', arg.issueBranch],
                ['git', 'branch', '-D', grrAutoBranch]
            ],
            func: function execCleanupArg(argv, next) {
                common.forkExecWaitAndLog({argv: argv, log: arg.log}, next);
            }
        }, function (cleanupErr) {
            if (err) {
                // TODO: multierror
                if (cleanupErr) {
                    arg.log.trace({err: cleanupErr}, 'cleanupErr');
                }
                cb(err);
            } else if (cleanupErr) {
                cb(cleanupErr);
            } else {
                cb();
            }
        });
    });
}

// ---- exports

/*
 * XXX doc this properly
 */
function grrDeleteBranches(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.bool(opts.dryRun, 'opts.dryRun');
    assert.func(cb, 'cb');

    if (opts.dryRun) {
        cb(new VError('"dryRun" option is not yet supported'));
        return;
    }

    var context = {
        log: opts.log,
        dryRun: opts.dryRun
    };

    vasync.pipeline({arg: context, funcs: [
        stepGetGrrConfig,
        stepGetGitBranch,

        function notOnMaster(arg, next) {
            if (arg.gitBranch === MASTER) {
                next(new VError('cannot grr -D on branch ' + MASTER));
            } else {
                next();
            }
        },

        // TODO: abort if there are unpushed commits (lastPushedSha)
        //          stepGetBranchConfigLastPushedSha,
        //      Then want --force or -y to force.
        // TODO: find the CR, if any, for this branch and confirm it is closed
        stepRemoveBranchConfig,
        stepDeleteGitBranchIfGrr
    ]}, cb);
}

function grrUpdateOrCreate(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.issue, 'opts.issue');
    assert.bool(opts.dryRun, 'opts.dryRun');
    assert.bool(opts.commit, 'opts.commit');
    assert.bool(opts.update, 'opts.update');
    assert.func(cb, 'cb');

    if (opts.commit) {
        cb(new VError('"commit" option is not yet supported'));
        return;
    }
    if (opts.dryRun) {
        cb(new VError('"dryRun" option is not yet supported'));
        return;
    }

    var context = {
        log: opts.log,
        dryRun: opts.dryRun
    };

    vasync.pipeline({arg: context, funcs: [
        stepGetGrrConfig,
        stepGetGrrCache,
        stepGetGitBranch,

        // TODO: guard if gitBranch is a 'grr/auto/...' branch. indicates e
        //      arlier failure

        stepGetBranchConfigIssue,

        function checkIssue(arg, next) {
            if (opts.issue && arg.branchConfigIssue &&
                opts.issue !== arg.branchConfigIssue) {
                next(new VError('issue conflict: %s does not match the '
                    + 'stored issue (%s) for the current branch (%s)',
                    opts.issue, arg.branchConfigIssue, arg.gitBranch));
            } else if (!opts.issue && !arg.branchConfigIssue) {
                if (arg.gitBranch === MASTER) {
                    next(new VError('missing ISSUE argument'));
                } else {
                    next(new VError('grr was not setup with an ISSUE for this '
                        + 'branch, use `grr ISSUE`'));
                }
            } else {
                arg.issue = opts.issue || arg.branchConfigIssue;
                next();
            }
        },

        stepGetBranchConfigTitle,
        stepGetBranchConfigParenthetical,
        stepGetBranchConfigLastPushedSha,
        stepGetBranchConfigCr,

        // Ensure have proper 'cr' remote.
        stepGetGerritUsername,
        stepGetGitRemotes,
        stepGetGitRemoteUrlCr,
        stepGetGitRemoteUrlOrigin,
        stepGetRepoName,
        stepEnsureCrRemote,

        function getIssueTitle(arg, next) {
            if (arg.branchConfigTitle && !opts.update) {
                arg.issueTitle = arg.branchConfigTitle;
                next();
                return;
            }

            // Need to retrieve this from the issue tracker.
            // XXX assuming jira for now, TODO: validate "ISSUE" format
            if (!arg.grrConfig.jira || !arg.grrConfig.jira.username ||
                !arg.grrConfig.jira.password)
            {
                next(new VError(
                    'cannot retrieve issue %s info: missing config in "%s":\n'
                    + '        [jira]\n'
                    + '        username = "<your jira username>"\n'
                    + '        password = "<your jira password>"',
                    arg.issue, config.CONFIG_FILE));
                return;
            }

            getJiraIssue(arg, function (err, issueInfo) {
                if (err) {
                    next(err);
                    return;
                }
                arg.issueTitle = issueInfo.fields.summary;
                // XXX want this here *or* `printIssue`?
                //console.log('Issue: %s %s', arg.issue, arg.issueTitle);
                next();
            });
        },
        function printIssue(arg, next) {
            console.log('Issue: %s %s', arg.issue, arg.issueTitle);
            next();
        },

        stepEnsureOnIssueBranch,
        stepSetBranchConfigIssue,
        stepSetBranchConfigTitle,
        stepSetBranchConfigParenthetical,

        // TODO: if we have no commits to push, then print a helpful message
        //      \n
        //      Commit changes and run `grr` again to create a Gerrit CR.

        // TODO: --commit

        stepGetGitCommits,

        function pushIfHaveCommits(arg, next) {
            if (arg.gitCommits.length === 0 ||
                (arg.branchConfigLastPushedSha &&
                    arg.branchConfigLastPushedSha === arg.gitCommits[0].sha))
            {
                if (arg.branchConfigCr) {
                    console.log('No new commits after %s',
                        arg.branchConfigLastPushedSha.slice(0, 12));
                    console.log('CR unchanged: %s <https://cr.joyent.us/%s>',
                        arg.branchConfigCr, arg.branchConfigCr);
                } else {
                    console.log('\nMake commits and run `grr` in this branch '
                        + 'to create a CR.');
                }
                next();
                return;
            }

            var newCommits = [];
            for (var i = 0; i < arg.gitCommits.length; i++) {
                var commit = arg.gitCommits[i];
                if (arg.branchConfigLastPushedSha !== commit.sha) {
                    newCommits.push(commit);
                } else {
                    break;
                }
            }
            console.log('New commits (%d):', newCommits.length);
            newCommits.forEach(function (c) {
                console.log('    %s %s', c.sha.slice(0, 7),
                    c.title.split(/\n/, 1)[0]);
            });

            // Else we need to create or update the CR.
            stepCreateUpdateCr(arg, next);
        }
    ]}, cb);
}


module.exports = {
    grrDeleteBranches: grrDeleteBranches,
    grrUpdateOrCreate: grrUpdateOrCreate
};

// vim: set softtabstop=4 shiftwidth=4:
