/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * `grr` library functionality.
 */

var assert = require('assert-plus');
var forkExecWait = require('forkexec').forkExecWait;
var format = require('util').format;
var request = require('request');
var vasync = require('vasync');
var VError = require('verror').VError;
var extsprintf = require('extsprintf').sprintf;
var prompt = require('prompt');
var mod_url = require('url');

var common = require('./common');
var config = require('./config');
var pkg = require('../package.json');


// ---- globals and constants

// For now I'm assuming 'master' is always the reference/production branch.
var MASTER = 'master';

// Hardcoded for Joyent eng usage right now.
var JIRA_URL = 'https://jira.joyent.us';

var USER_AGENT = 'grr/' + pkg.version;

// Hardcoded for Joyent eng usage right now.
var GERRIT_HOST = 'cr.joyent.us';

// ---- internal support functions

/*
 * `issueArg` is a user-given <issue> argument. Validate it and normalize
 * to these fields:
 *
 * - issue.issueType is one of "jira" or "github".
 * - issue.issueName is of the form "FOO-123" for JIRA and "account/project#123"
 *   for GitHub.
 * - issue.issueId is of the form "FOO-123" for JIRA and "123" for GitHub.
 *
 * Supported inputs:
 * - A Jira issue key:
 *      FOO-123
 * - A Jira issue URL:
 *      https://jira.joyent.us/browse/FOO-123
 * - A GitHub issue number:
 *      123
 * - A GitHub issue id:
 *      account/project#123
 * - A GitHub issue URL:
 *      https://github.com/trentm/node-bunyan/issues/426
 */
function parseIssueArg(issue, repoName, issueArg, cb) {
    assert.object(issue, 'issue');
    assert.string(repoName, 'repoName');
    assert.string(issueArg, 'issueArg');
    assert.func(cb, 'cb');

    var match;

    // FOO-123
    match = /^[A-Z]+-\d+$/.exec(issueArg);
    if (match) {
        issue.issueType = 'jira';
        issue.issueId = issue.issueName = issueArg;
        cb();
        return;
    }

    // https://jira.joyent.us/browse/FOO-123
    match = /^https:\/\/jira\.joyent\.us\/browse\/([A-Z]+-\d+)$/.exec(issueArg);
    if (match) {
        issue.issueType = 'jira';
        issue.issueId = issue.issueName = match[1];
        cb();
        return;
    }

    // 123
    match = /^\d+$/.exec(issueArg);
    if (match) {
        issue.issueType = 'github';
        issue.issueName = repoName + '#' + issueArg;
        issue.issueId = issueArg;
        cb();
        return;
    }

    // account/project#123
    match = /^([\w_-]+\/[\w_-]+)#(\d+)$/.exec(issueArg);
    if (match) {
        issue.issueType = 'github';
        issue.issueName = issueArg;
        issue.issueId = match[2];
        if (match[1] !== repoName) {
            cb(new VError(
                'project from <issue>, %s, does not match repo name, %s',
                match[1], repoName));
            return;
        }
        cb();
        return;
    }

    // https://github.com/trentm/node-bunyan/issues/426
    match = /^https:\/\/github\.com\/([\w_-]+\/[\w_-]+)\/issues\/(\d+)$/
        .exec(issueArg);
    if (match) {
        issue.issueType = 'github';
        issue.issueName = match[1] + '#' + match[2];
        issue.issueId = match[2];
        if (match[1] !== repoName) {
            cb(new VError(
                'project from <issue>, %s, does not match repo name, %s',
                match[1], repoName));
            return;
        }

        cb();
        return;
    }

    cb(new VError('invalid <issue> arg: ' + issueArg));
}

/*
 * Validate the main issue arg provided.
 */
function stepValidateIssueArg(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.optionalString(arg.issueArg, 'arg.issueArg');
    assert.string(arg.repoName, 'arg.repoName');
    assert.func(cb, 'cb');

    if (!arg.issueArg) {
        cb();
        return;
    }

    parseIssueArg(arg, arg.repoName, arg.issueArg, function (err) {
        if (err) {
            cb(err);
            return;
        }

        arg.log.trace({issueArg: arg.issueArg, issueType: arg.issueType,
            issueId: arg.issueId, issueName: arg.issueName},
            'stepValidateIssueArg');
        cb();
    });
}

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
            '-p', '29418', GERRIT_HOST]
    }, function (err, res) {
        if (res && res.stderr) {
            var re = /ssh:\/\/(.*?)@.*\/REPOSITORY_NAME.git/;
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
        argv: ['git', 'config', '--get', 'remote.cr.url']
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
        argv: ['git', 'config', '--get', 'remote.origin.url']
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
 *      https://github.com/joyent/sdc-imgapi
 *      git@github.com:joyent/sdc-imgapi
 */
function stepGetRepoName(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitRemoteUrlOrigin, 'arg.gitRemoteUrlOrigin');

    var patterns = [
        new RegExp('github\.com:([^:]+?)(\.git)?$'),
        new RegExp('github\.com\/(.+?)(\.git)?$')
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
 * [branch "grr-TOOLS-1516"]
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

function stepGetBranchConfigExtraIssues(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.gitBranch, 'arg.gitBranch');

    getBranchConfigKey('extraIssues', arg, function (err, val) {
        if (err) {
            cb(err);
            return;
        }

        if (val.trim().length === 0) {
            arg.extraIssues = [];
        } else {
            try {
                arg.extraIssues = JSON.parse(val);
            } catch (parseErr) {
                cb(new VError(parseErr, 'could not parse "extraIssues" JSON ' +
                    'val from ".git/config": %j', val));
                return;
            }
        }

        cb();
    });
}

function getIssueTitle(arg, issue, cb) {
    assert.object(arg.log, 'arg.log');
    assert.object(issue, 'issue');
    assert.func(cb, 'cb');

    if (issue.issueType === 'jira') {
        // TODO: Attempt to scrape from public bugview.

        if (!arg.grrConfig.jira || !arg.grrConfig.jira.username ||
            !arg.grrConfig.jira.password)
        {
            cb(new VError(
                'cannot retrieve issue %s info: missing config '
                    + 'in "%s":\n'
                + '    [jira]\n'
                + '    username = "<your jira username>"\n'
                + '    password = "<your jira password>"\n'
                + 'Note: Be sure to escape double-quotes and '
                    + 'backslases in your password per\n'
                + '    https://github.com/toml-lang/toml#string',
                issue.issueName, config.CONFIG_FILE));
            return;
        }

        getJiraIssue(arg, issue, function (err, issueInfo) {
            if (err) {
                cb(err);
                return;
            }
            cb(null, issueInfo.fields.summary);
        });
    } else {
        assert.equal(issue.issueType, 'github');
        getGitHubIssue(arg, issue, function (err, issueInfo) {
            if (err) {
                cb(err);
                return;
            }
            cb(null, issueInfo.title);
        });
    }
}


function stepRemoveExtraIssues(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.arrayOfString(arg.removeExtraIssueArgs, 'arg.removeExtraIssueArgs');
    assert.arrayOfObject(arg.extraIssues, 'arg.extraIssues');
    assert.func(cb, 'cb');

    var remove = [];

    arg.removeExtraIssueArgs.forEach(function (item, _) {
        remove.push({ issueId: item });
    });

    vasync.forEachPipeline({
        inputs: remove,
        func: function (issue, next) {
            parseIssueArg(issue, arg.repoName, issue.issueId, function (err) {
                if (err) {
                    next(err);
                    return;
                }

                if (issue.issueId === arg.issueId) {
                    next(new VError('cannot remove main issue ' + arg.issueId));
                    return;
                }

                arg.extraIssues = arg.extraIssues.filter(function (item) {
                    return item.issueId !== issue.issueId;
                });

                next();
            });
        }
    }, cb);
}


function stepParseExtraIssues(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.arrayOfString(arg.addExtraIssueArgs, 'arg.addExtraIssueArgs');
    assert.string(arg.issueId, 'arg.issueId');
    assert.arrayOfObject(arg.extraIssues, 'arg.extraIssues');
    assert.func(cb, 'cb');

    arg.addExtraIssueArgs.forEach(function (item, _) {
        arg.extraIssues.push({ issueId: item });
    });

    var seenAlready = {};

    vasync.forEachParallel({
        inputs: arg.extraIssues, func: function (issue, next) {
            parseIssueArg(issue, arg.repoName, issue.issueId, function (err) {
                if (err) {
                    next(err);
                    return;
                }

                if (issue.issueId === arg.issueId) {
                    next(new VError('cannot add main issue ' + arg.issueId +
                        ' as an extra issue'));
                    return;
                }

                if (seenAlready.hasOwnProperty(issue.issueId)) {
                    next(new VError('duplicate extra issue ' + issue.issueId));
                    return;
                }

                seenAlready[issue.issueId] = true;

                getIssueTitle(arg, issue, function (err2, title) {
                    if (err2) {
                        next(err2);
                        return;
                    }

                    issue.issueTitle = title;
                    arg.log.trace({extraIssue: issue}, 'extraIssue');
                    next();
                });
            });
        }
    }, cb);
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

    common.forkExecWaitAndLog({
        argv: ['git', 'config', '--local',
            'branch.' + arg.issueBranch + '.' + key, val],
        log: arg.log
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
    assert.func(cb, 'cb');

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
    assert.string(arg.issueId, 'arg.issueId');

    if (arg.branchConfigIssue === arg.issueId) {
        cb();
        return;
    }
    arg.branchConfigIssue = arg.issueId;
    setBranchConfigKey('issue', arg.issueId, arg, cb);
}

function stepSetBranchConfigTitle(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigTitle, 'arg.branchConfigTitle');
    assert.string(arg.issueTitle, 'arg.issueTitle');

    if (arg.branchConfigTitle === arg.issueTitle) {
        cb();
        return;
    }
    arg.branchConfigTitle = arg.issueTitle;
    setBranchConfigKey('title', arg.issueTitle, arg, cb);
}

function stepSetBranchConfigExtraIssues(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.array(arg.extraIssues, 'arg.extraIssues');
    assert.func(cb, 'cb');

    if (arg.extraIssues.length > 0) {
        arg.branchConfigExtraIssues = JSON.stringify(arg.extraIssues);
        setBranchConfigKey('extraIssues', arg.branchConfigExtraIssues, arg, cb);
    } else {
        cb();
    }
}

function stepSetBranchConfigParenthetical(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.branchConfigParenthetical,
        'arg.branchConfigParenthetical');
    assert.optionalString(arg.parenthetical, 'arg.parenthetical');

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
 *          https://jira.joyent.us/rest/api/2/issue/TOOLS-1516 | json
 */
function getJiraIssue(opts, issue, cb) {
    assert.object(opts.log, 'opts.log');
    assert.object(opts.grrConfig, 'opts.grrConfig');
    assert.string(opts.grrConfig.jira.username, 'opts.grrConfig.jira.username');
    assert.string(opts.grrConfig.jira.password, 'opts.grrConfig.jira.password');
    assert.string(issue.issueId, 'issue.issueId');

    var url = JIRA_URL + '/rest/api/2/issue/'
        + encodeURIComponent(issue.issueId);
    request.get(url, {
        auth: {
            username: opts.grrConfig.jira.username,
            password: opts.grrConfig.jira.password
        }
    }, function (err, res, body) {
        //opts.log.trace({err: err, res: res}, 'getJiraIssue response');
        if (err) {
            cb(new VError(err, 'could not retrieve JIRA issue %s info',
                opts.issueId));
            return;
        } else if (res.statusCode === 404) {
            cb(new VError(err, 'no such JIRA issue %s', issue.issueId));
            return;
        } else if (res.statusCode !== 200) {
            cb(new VError('unexpected JIRA response status for issue %s: %s',
                issue.issueId, res.statusCode));
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
 * Example: https://api.github.com/repos/trentm/play/issues/6
 */
function getGitHubIssue(opts, issue, cb) {
    assert.object(opts.log, 'opts.log');
    assert.string(opts.repoName, 'opts.repoName');
    assert.equal(issue.issueType, 'github');
    assert.string(issue.issueId, 'issue.issueId');
    assert.string(issue.issueName, 'issue.issueName');

    var url = 'https://api.github.com/repos/'
        + opts.repoName + '/issues/' + issue.issueId;
    request.get(url, {
        headers: {
            // https://developer.github.com/v3/#user-agent-required
            'user-agent': USER_AGENT
        }
    }, function (err, res, body) {
        opts.log.trace({err: err, res: res}, 'getGitHubIssue response');
        if (err) {
            cb(new VError(err, 'could not retrieve GitHub issue %s info',
                issue.issueName));
            return;
        } else if (res.statusCode === 404) {
            cb(new VError(err, 'no such GitHub issue %s', issue.issueName));
            return;
        } else if (res.statusCode !== 200) {
            cb(new VError('unexpected GitHub response status for issue %s: %s',
                issue.issueName, res.statusCode));
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
 * If on master, then we want to create and switch to `grr-$issue`. If that
 * exists already, then blow up.
 *
 * TODO: implement --force later (see TODO.txt scenario using --force)
 * TODO: If a parenthetical, might reasonably already have a grr branch
 *      for this ticket. If so, then incr to `grr-${issue}a`, `...b`, etc.
 *
 * Sets `arg.issueBranch`.
 */
function stepEnsureOnIssueBranch(arg, cb) {
    assert.string(arg.issueId, arg.issueId);

    if (arg.gitBranch !== MASTER) {
        arg.issueBranch = arg.gitBranch;
        cb();
        return;
    }

    arg.issueBranch = 'grr-' + arg.issueId;
    console.log('Creating branch for CR: %s', arg.issueBranch);

    // TODO Handle case of that existing already.
    forkExecWait({
        argv: ['git', 'checkout', '-b', arg.issueBranch]
    }, function (err, res) {
        cb(err);
    });
}


function isGrrBranch(s) {
    // 'grr-TOOLS-123'
    // 'grr/TOOLS-123' (the old form)
    var grrBranchRe = /^grr[-\/]([^\/]+)$/;
    return grrBranchRe.test(s);
}

/*
 * I don't know a good way to see if this section exists before just deleting
 * it. So we will ignore the error if it doesn't exist:
 *
 *  $ git config --local --remove-section branch.grr-TOOLS-1516
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
 * Delete this branch and switch to master... but *only* if this is a grr-$issue
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

/*
 * "medium" is:
 *
 *      commit $sha
 *      Author: $author
 *      Date:   $date
 *      $blankline
 *          $message
 *      $blankline
 *      ...
 */
function stepGetGitCommits(arg, cb) {
    forkExecWait({
        argv: ['git', 'log', '--pretty=medium', MASTER + '..']
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        var lines = [];
        if (res.stdout.trim()) {
            lines = res.stdout.trim().split(/\n/g);
        }

        var commits = [];
        var commit = null;
        var pushCommit = function () {
            if (commit) {
                commit.message = commit.message.join('\n');
                commits.push(commit);
            }
        };
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trimRight();
            if (line.slice(0, 7) === 'commit ') {
                pushCommit();
                commit = {
                    sha: line.split(/ /)[1],
                    message: [],
                    meta: {}
                };
            } else if (! line.trim()) {
                continue;
            } else if (line.slice(0, 4) === '    ') {
                commit.message.push(line.slice(4));
            } else {
                var idx = line.indexOf(':');
                commit.meta[line.slice(0, idx)] = line.slice(idx + 1).trim();
            }
        }
        pushCommit();

        arg.gitCommits = commits;
        arg.log.trace({gitCommits: arg.gitCommits}, 'gitCommits');
        cb();
    });
}

/*
 * ssh cr gerrit query --current-patch-set --format=JSON $crNumber
 *      | head -1 | json patchSets.-1.number
 */
function stepGetCurrentCr(arg, cb) {
    assert.optionalString(arg.branchConfigCr, 'arg.branchConfigCr');
    assert.string(arg.gerritUsername, 'arg.gerritUsername');

    if (!arg.branchConfigCr) {
        // Haven't created a CR for this branch yet.
        arg.currentCr = null;
        cb();
        return;
    }

    common.forkExecWaitAndLog({
        argv: ['ssh', '-q', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', '-p', '29418',
            arg.gerritUsername + '@cr.joyent.us',
            'gerrit', 'query', '--current-patch-set',
            '--format=JSON', arg.branchConfigCr],
        log: arg.log
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }

        var firstLine = res.stdout.trim().split(/\n/g)[0];
        try {
            var hit = JSON.parse(firstLine);
        } catch (parseErr) {
            cb(new VError(parseErr,
                'unexpected first line response from "gerrit query" for CR %s',
                arg.branchConfigCr));
            return;
        }

        // Sanity checks on this hit (given this circuitous route to CR info.
        if (hit.project !== arg.repoName) {
            cb(new VError(
                'gerrit query for CR %s returned a hit for project %s',
                arg.branchConfigCr, hit.project));
            return;
        } else if (hit.number !== arg.branchConfigCr) {
            cb(new VError(
                'gerrit query for CR %s returned a hit for CR %s',
                arg.branchConfigCr, hit.number));
            return;
        }

        arg.currentCr = hit;
        arg.log.trace({number: arg.branchConfigCr, currentCr: arg.currentCr},
            'currentCr');
        cb();
    });
}

/*
 * Put together the intended commit message.
 * This includes automatically added lines for approvals:
 *      Reviewed by: ...
 *      Approved by: ...
 */
function stepGetCommitMessage(arg, cb) {
    assert.string(arg.issueName, 'arg.issueName');
    assert.string(arg.issueTitle, 'arg.issueTitle');
    assert.optionalString(arg.branchConfigParenthetical,
        'arg.branchConfigParenthetical');
    assert.optionalObject(arg.currentCr, 'arg.currentCr');
    assert.arrayOfObject(arg.extraIssues, 'arg.extraIssues');
    assert.func(cb, 'cb');

    var msg = arg.issueName + ' ' + arg.issueTitle;
    if (arg.branchConfigParenthetical) {
        msg += ' (' + arg.branchConfigParenthetical + ')';
    }

    arg.extraIssues.forEach(function (item, _) {
        msg += '\n' + item.issueName + ' ' + item.issueTitle;
    });

    var approvals = (arg.currentCr && arg.currentCr.currentPatchSet &&
        arg.currentCr.currentPatchSet.approvals);
    if (approvals) {
        var approvalMsgs = [];
        approvals.forEach(function (a) {
            // Avoid a "-1" with `a.value === '-1'`.
            if (a.type === 'Code-Review' && a.value === '1') {
                approvalMsgs.push(format('Reviewed by: %s <%s>',
                    a.by.name, a.by.email));
            }
        });

        approvals.forEach(function (a) {
            if (a.type === 'Integration-Approval' && a.value == '1') {
                approvalMsgs.push(format('Approved by: %s <%s>',
                    a.by.name, a.by.email));
            }
        });
        if (approvalMsgs.length > 0) {
            msg += '\n' + approvalMsgs.join('\n');
        }
    }

    arg.commitMessage = msg;
    cb();
}

/*
 * Create or update the CR. Generally this is:
 * - create grr/auto/$issue branch
 * - determine correct commit message:
 *     (a) possibly update title from the issue (if `-u` used)
 *     (b) from local git config values
 *     (c) look up any extra issues
 *     (d) gather "Reviewed by" from gerrit
 * - squash merge and/or ammend commit message, if necessary
 * - push to gerrit
 * - parse out the CR num and set local git config:
 *     grr.$branch.cr=$cr
 * - update git config branch.$branch.lastPushedSha=$sha
 * - delete grr/auto/$issue branch
 *
 * This sets the following properties on `arg`:
 * - `arg.crAction`: The action taken on a CR. One of 'none', 'create',
 *   'update', 'updateCommitMessage'.
 */
function stepCreateUpdateCr(arg, cb) {
    assert.object(arg, 'arg');
    assert.object(arg.log, 'arg.log');
    assert.optionalBool(arg.dryRun, 'arg.dryRun');
    assert.string(arg.issueId, 'arg.issueId');
    assert.string(arg.issueName, 'arg.issueName');
    assert.string(arg.commitMessage, 'arg.commitMessage');
    assert.arrayOfObject(arg.gitCommits, 'arg.gitCommits');
    assert.optionalArrayOfObject(arg.commitsToPush, 'arg.commitsToPush');
    assert.optionalString(arg.branchConfigParenthetical,
        'arg.branchConfigParenthetical');
    assert.optionalString(arg.branchConfigCr, 'arg.branchConfigCr');
    assert.func(cb, 'cb');

    if (arg.dryRun) {
        cb(new VError('"dryRun" option is not yet supported'));
        return;
    }

    /*
     * Conditions to create/update the CR:
     * - we have commits (either create or update the CR)
     * - there is already a CR, but the commit message has changed (either
     *   from the issue title changing, or approvals changing on the CR)
     */
    if (arg.commitsToPush && arg.commitsToPush.length > 0) {
        if (arg.currentCr) {
            arg.crAction = 'update';
        } else {
            arg.crAction = 'create';
        }
    } else if (arg.currentCr && arg.currentCr.commitMessage.trim()
            !== arg.commitMessage.trim()) {
        arg.log.trace({currCommitMessage: arg.currentCr.commitMessage.trim(),
            targCommitMessage: arg.commitMessage.trim()},
            'commitMessage diff');
        arg.crAction = 'updateCommitMessage';
    } else {
        arg.crAction = 'none';
        cb();
        return;
    }

    var grrAutoBranch = 'grr/auto/' + arg.issueId;
    var gitBranches;
    var commitAuthor = arg.gitCommits[0].meta.Author;
    assert.string(commitAuthor, 'commitAuthor');

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
            switch (arg.crAction) {
            case 'update':
                console.log('Updating CR %s:', arg.branchConfigCr);
                break;
            case 'updateCommitMessage':
                console.log('Updating CR %s commit message:',
                    arg.branchConfigCr);
                break;
            case 'create':
                console.log('Creating CR:');
                break;
            default:
                throw new VError('unexpected crAction: ' + arg.crAction);
            }
            next();
        },

        function squashEm(_, next) {
            var cmds = [
                // TODO: if staged stuff, then might need a stash save/pop here
                ['git', 'checkout', '-t', MASTER, '-b', grrAutoBranch],
                ['git', 'merge', '--squash', arg.issueBranch],
                // TODO: dry-run: ['git', 'commit', '--dry-run', ...
                ['git', 'commit', '--author', commitAuthor,
                    '-m', arg.commitMessage]
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
                    // TODO: dry-run:
                    //      argv: ['git', 'push', '--dry-run', 'cr',
                    argv: ['git', 'push', 'cr',
                        'HEAD:refs/changes/' + arg.branchConfigCr],
                    indent: true
                }, next);
            } else {
                // Create CR and parse out and save the CR num.
                common.forkExecWaitAndPrint({
                    // TODO: dry-run:
                    //      argv: ['git', 'push', '--dry-run', 'cr',
                    argv: ['git', 'push', 'cr',
                        'HEAD:refs/for/master'],
                    log: arg.log,
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
                            arg.cr = match[1];
                            arg.log.trace({cr: arg.cr}, 'cr');
                            stepSetBranchConfigCr(arg, next);
                        }
                    }
                });
            }
        },

        function setLastPushedSha(_, next) {
            // TODO: dry-run: Skip this line.
            arg.lastPushedSha = arg.gitCommits[0].sha;
            next();
        },
        stepSetBranchConfigLastPushedSha,

        stepGetCurrentCr,

        /*
         * Add a comment for the added commits.
         *
         * Dev Note: watch for double quoting going on here (ssh, then line
         * parsing on the Gerrit server). Example:
         *      $ ssh cr gerrit 'review  -m "hi
         *      there
         *      this is
         *      multiple
         *      lines" 368,2'
         *
         * Gerrit comment formatting: one leading space is enough to get a
         * code block.
         */
        function addCommitMessagesToCr(_, next) {
            assert.string(arg.gerritUsername, 'arg.gerritUsername');

            if (!arg.commitsToPush) {
                next();
                return;
            }

            var comment = ['New commits:'];
            arg.commitsToPush.forEach(function (c) {
                comment.push('    ');
                comment.push('    commit ' + c.sha);
                comment.push('    ');
                comment.push(common.indent(c.message, '    '));
            });
            comment = comment.join('\n');

            var gerritCmd = 'review -m "' + comment + '" '
                + arg.branchConfigCr + ','
                + arg.currentCr.currentPatchSet.number;

            common.forkExecWaitAndLog({
                argv: ['ssh', '-q', '-o', 'StrictHostKeyChecking=no',
                    '-o', 'UserKnownHostsFile=/dev/null',
                    '-p', '29418', arg.gerritUsername + '@cr.joyent.us',
                    'gerrit', gerritCmd],
                log: arg.log
            }, next);
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

/*
 * List at most 500 open code reviews for the current repository.
 */
function stepListCRs(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.string(arg.repoName, 'arg.repoName');
    assert.string(arg.gerritUsername, 'arg.gerritUsername');
    assert.func(cb, 'cb');

    common.forkExecWaitAndLog({
        argv: ['ssh', '-q', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', '-p', '29418',
            arg.gerritUsername + '@' + GERRIT_HOST, '-p', '29418',
            'gerrit', 'query', '--format=JSON',
            'project:' + arg.repoName, 'status:open',
            'limit:500'],
        log: arg.log
    }, function (err, query_res) {
        if (err) {
            cb(err);
            return;
        }
        var lines = query_res.stdout.trim().split(/\n/g);
        if (lines.length == 1) {
            console.log(
                'No outstanding code reviews for ' + arg.repoName + '.');
            return;
        }

        var fmt = '%-26s%-27s%-30s%s';
        console.log(extsprintf(fmt, 'CREATED', 'URL', 'AUTHOR', 'SYNOPSIS'));
        for (var i = 0; i < lines.length; i++) {
            var element = lines[i];
            try {
                var gerrit_res = JSON.parse(element);
            } catch (parseErr) {
                cb(new VError(parseErr,
                    'invalid json response from "gerrit query" for project:%s',
                    arg.repoName));
                return;
            }
            // the last bit of js from gerrit is a row-count + status
            if (gerrit_res.url === undefined) {
                continue;
            }
            var created = new Date(0);
            created.setUTCSeconds(gerrit_res.createdOn);
            var subject = gerrit_res.subject;
            var SUBJ_LIMIT = 80;
            if (subject.length > SUBJ_LIMIT) {
                subject = subject.slice(0, SUBJ_LIMIT) + '...';
            }
            // Some test gerrit instances don't have emails set for
            // all users.
            if (gerrit_res.owner['email'] === null) {
                gerrit_res.owner['email'] = '<unknown>';
            }
            console.log(
                extsprintf(
                    fmt, created.toISOString(), gerrit_res.url,
                    gerrit_res.owner['email'], subject));
        }
    });
}

/*
 * Search for open code reviews for *any* repository that match our issue
 */
function stepQueryCRs(arg, cb) {
    assert.object(arg.log, 'arg.log');
    assert.optionalBool(arg.dryRun, 'arg.dryRun');
    assert.optionalBool(arg.verbose, 'arg.verbose');
    assert.string(arg.issueArg, 'arg.issueArg');
    assert.string(arg.gerritUsername, 'arg.gerritUsername');
    assert.object(arg.grrConfig, 'arg.grrConfig');
    assert.func(cb, 'cb');

    arg.grrReviews = [];
    common.forkExecWaitAndLog({
        argv: ['ssh', '-q', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', '-p', '29418',
            arg.gerritUsername + '@' + GERRIT_HOST,
            'gerrit', 'query', '--format=JSON',
            '--all-approvals', '--current-patch-set',
            'status:open',
            'intopic:' + arg.issueArg, 'OR', 'message:' + arg.issueArg],
        log: arg.log
    }, function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        var lines = res.stdout.trim().split(/\n/g);
        if (lines.length == 1) {
            console.log(
                'No outstanding code reviews matching ' + arg.issueArg + '.');
            return;
        }
        for (var i = 0; i < lines.length; i++) {
            var element = lines[i];
            try {
               var crRes = JSON.parse(element);
            } catch (parseErr) {
                cb(new VError(parseErr,
                    'unexpected json from "gerrit query": %s',
                    element));
                return;
            }
            // the last bit of js from gerrit is a row-count + status which
            // has an empty url field.
            if (!crRes.hasOwnProperty('url')) {
                continue;
            } else if (!crRes.open) {
                // despite the status:open query, our gerrit server returns
                // open:false results when --all-approvals is passed as a
                // query parameter.
                continue;
            } else {
                arg.grrReviews.push(crRes);
            }
        }
        cb();
    });
}

/*
 * Work through each of the given grrReviews
 */
function stepReviewCRs(arg, cb) {
    assert.object(arg.grrReviews);
    assert.string(arg.reviewArg, 'arg.reviewArg');
    assert.optionalBool(arg.diffArg, 'arg.diffArg');
    assert.optionalBool(arg.dryRun, 'arg.dryRun');

    if (arg.grrReviews.length === 0) {
        console.log('No outstanding matching code reviews found.');
        cb();
        return;
    }

    var first = true;
    var fmt = '%-26s%-26s%-27s%-25s%-4s%-4s%s';
    console.log(extsprintf(
        fmt, 'CREATED', 'PROJECT', 'URL', 'AUTHOR', 'CR', 'IA', 'SUBJECT'));

    // Start a pipeline iterating over all reviews, prompting for user feedback
    vasync.forEachPipeline({
        inputs: arg.grrReviews,
        func: function processReview(argv, next) {
            var crRes = argv;
            // gather data on the code reviews for this ticket (if any)
            var created = new Date(0);
            created.setUTCSeconds(crRes.createdOn);
            var subject = crRes.subject;
            var SUBJ_LIMIT = 80;
            var cr = 'no';
            var ia = 'no';
            if (subject.length > SUBJ_LIMIT) {
                subject = subject.slice(0, SUBJ_LIMIT) + '...';
            }
            var approvals = crRes.currentPatchSet.approvals;
            if (approvals !== undefined) {
                for (var j = 0; j < approvals.length; j++) {
                    var approve = approvals[j];
                    if (approve.type == 'Integration-Approval' &&
                        approve.value == 1) {
                        ia = 'yes';
                    } else if (approve.type == 'Code-Review' &&
                        approve.value == 1) {
                        cr = 'yes';
                    }
                }
            }

            var review_summary = extsprintf(
                fmt, created.toISOString(), crRes.project, crRes.url,
                crRes.owner['email'], cr, ia, subject);
            if (!first && arg.diffArg) {
                // Give some separation between reviews, when not just listing
                // them all.
                console.log('\n');
            } else {
                first = false;
            }
            console.log(review_summary);

            if (!arg.diffArg) {
                // We explicity do not let users approve reviews without
                // showing them a diff, so just continue now.
                return next();
            } else {
                // Before we go further, check that if CR has not been granted,
                // do not allow an IA to be granted.
                if (arg.reviewArg == 'Integration-Approval') {
                    var has_cr = -1;
                    if (approvals !== undefined) {
                        for (var k = 0; k < approvals.length; k++) {
                            var approval = approvals[k];
                            if (approval.type == 'Code-Review') {
                                has_cr = approval.value;
                            }
                        }
                    }
                    if (has_cr === -1) {
                        return next(new VError(
                            'cannot grant IA when CR has not been granted'));
                    }
                }

                var revision = crRes.currentPatchSet.revision;
                var url = mod_url.parse(crRes.url);
                var gerrit_url = url.protocol + '//' + url.host;
                var patch_url = gerrit_url + '/changes/' + crRes.number +
                    '/revisions/' + revision + '/patch?download';
                request.get(patch_url, {
                    auth: {
                        username: arg.gerritUsername,
                        password: arg.grrConfig.jira.password
                    }
                }, function (err, res, body) {
                    if (err) {
                        next(new VError(err,
                            'could not retrieve gerrit patch %s', patch_url));
                        return;
                    } else if (res.statusCode === 404) {
                        next(new VError(err, 'no such gerrit patch %s',
                           patch_url));
                        return;
                    } else if (res.statusCode !== 200) {
                        next(new VError(
                            'unexpected gerrit response code for patch %s: %s',
                            patch_url, res.statusCode));
                        return;
                    }

                    var buf = Buffer.from(body, 'base64');
                    console.log('\n' + common.indent(buf.toString('utf8')));

                    if (arg.dryRun) {
                        return next();
                    }

                    var review_desc = extsprintf(
                        'Do you want to give a \'%s\' +1 for this review?',
                        arg.reviewArg);
                    // prompt for user input, and apply CR
                    var prompt_schema = {
                        properties: {
                            answer: {
                                description: review_desc,
                                pattern: /^[yn]$/,
                                message: 'y or n will do!',
                                required: true
                            }
                        }
                    };
                    prompt.colors = false;
                    prompt.message = '';
                    prompt.start();
                    prompt.get(
                        prompt_schema,
                        function user_input(prompt_err, result) {
                            if (prompt_err) {
                                next(new VError(
                                    prompt_err,
                                    'problem trying to prompt user'));
                                return;
                            }
                            if (result.answer == 'y') {
                                console.log(extsprintf(
                                    'Granting a \'%s\' +1 to this review',
                                    arg.reviewArg));
                                common.forkExecWaitAndLog({
                                    argv: ['ssh', '-q',
                                        '-o', 'StrictHostKeyChecking=no',
                                        '-o', 'UserKnownHostsFile=/dev/null',
                                        '-p', '29418',
                                        arg.gerritUsername + '@cr.joyent.us',
                                        'gerrit', 'review',
                                        '--project', crRes.project,
                                        '--label', arg.reviewArg + '=+1',
                                        crRes.currentPatchSet.revision
                                    ],
                                    log: arg.log
                                // eslint-disable-next-line no-unused-vars
                                }, function (fork_err, review_res) {
                                    if (fork_err) {
                                        next(fork_err);
                                        return;
                                    } else {
                                        next();
                                    }
                                });
                            } else {
                                console.log('Skipping this review.');
                                next();
                            }
                    });
                });
            }
        }
    }, function finish(pipelineErr) {
        cb(pipelineErr);
    });
}
// ---- exports

/*
 * Clean up grr branch config details for the current branch and, if it is
 * a "grr-$issue" feature branch, then delete it and switch back to master.
 */
function grrDelete(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalBool(opts.dryRun, 'opts.dryRun');
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
        stepGetGitRemoteUrlOrigin,
        stepGetRepoName,
        stepValidateIssueArg,

        stepGetGrrConfig,
        stepGetGitBranch,

        function notOnMaster(arg, next) {
            if (arg.gitBranch === MASTER) {
                next(new VError('cannot grr -D on branch ' + MASTER));
            } else {
                next();
            }
        },

        stepGetBranchConfigIssue,

        function checkIssue(arg, next) {
            if (arg.issueId && arg.branchConfigIssue &&
                arg.issueId !== arg.branchConfigIssue) {
                next(new VError('issue conflict: "%s" does not match the '
                    + 'stored issue (%s) for the current branch (%s)',
                    arg.issueId, arg.branchConfigIssue, arg.gitBranch));
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

/*
 * List open CRs for the current repository. Intended for use by engineers
 * who want to help cleaning up any CR backlog that may exist.
 */
function grrList(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    var context = {
        log: opts.log
    };

    vasync.pipeline({arg: context, funcs: [
        stepGetGrrConfig,
        stepGetGrrCache,
        stepGetGitRemoteUrlOrigin,
        stepGetGerritUsername,
        stepGetRepoName,
        stepListCRs
    ]}, cb);
}

function grrReview(opts, cb) {
    /*
     * Search for a grr issue, and add CR/IA flags to all issues
     */
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');
    assert.string(opts.issueArg, 'opts.issueArg');
    assert.string(opts.reviewArg, 'opts.reviewArg');
    assert.optionalBool(opts.dryRun, 'opts.dryRun');

    var context = {
        log: opts.log,
        issueArg: opts.issueArg,
        dryRun: opts.dryRun,
        diffArg: opts.diffArg,
        reviewArg: opts.reviewArg
    };

    vasync.pipeline({arg: context, funcs: [
        stepGetGrrConfig,
        stepGetGrrCache,
        stepGetGerritUsername,
        stepQueryCRs,
        stepReviewCRs
    ]}, cb);
}

function grrUpdateOrCreate(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.issueArg, 'opts.issueArg');
    assert.optionalArrayOfString(opts.addExtraIssueArgs,
        'opts.addExtraIssueArgs');
    assert.optionalArrayOfString(opts.removeExtraIssueArgs,
        'opts.removeExtraIssueArgs');
    assert.optionalString(opts.parenthetical, 'opts.parenthetical');
    assert.optionalBool(opts.dryRun, 'opts.dryRun');
    assert.optionalBool(opts.commit, 'opts.commit');
    assert.optionalBool(opts.update, 'opts.update');
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
        dryRun: opts.dryRun,
        issueArg: opts.issueArg,
        extraIssues: [],
        addExtraIssueArgs: opts.addExtraIssueArgs || [],
        removeExtraIssueArgs: opts.removeExtraIssueArgs || [],
        parenthetical: opts.parenthetical
    };

    vasync.pipeline({arg: context, funcs: [
        stepGetGitRemoteUrlOrigin,
        stepGetRepoName,
        stepValidateIssueArg,

        stepGetGrrConfig,
        stepGetGrrCache,
        stepGetGitBranch,

        // TODO: guard if gitBranch is a 'grr/auto/...' branch. indicates e
        //      arlier failure

        stepGetBranchConfigIssue,
        stepGetBranchConfigExtraIssues,

        stepGetGerritUsername,
        stepGetGitRemotes,
        stepGetGitRemoteUrlCr,

        /*
         * `issueId` et al will be set if an `issueArg` was given. If not,
         * then we need one from `branchConfigIssue`, else we error out.
         * Also ensure they match if we have both.
         */
        function ensureIssueId(arg, next) {
            if (arg.issueId && arg.branchConfigIssue &&
                arg.issueId !== arg.branchConfigIssue) {
                next(new VError('issue conflict: "%s" does not match the '
                    + 'stored issue (%s) for the current branch (%s)',
                    arg.issueId, arg.branchConfigIssue, arg.gitBranch));
            } else if (!arg.issueId && !arg.branchConfigIssue) {
                if (arg.gitBranch === MASTER) {
                    next(new VError('missing <issue> argument'));
                } else {
                    next(new VError('grr was not setup with an <issue> for '
                        + 'this branch, use `grr <issue>`'));
                }
            } else if (!arg.issueId) {
                parseIssueArg(arg, arg.repoName, arg.branchConfigIssue, next);
            } else {
                next();
            }
        },

        stepRemoveExtraIssues,
        stepParseExtraIssues,

        stepGetBranchConfigTitle,
        stepGetBranchConfigParenthetical,
        stepGetBranchConfigLastPushedSha,
        stepGetBranchConfigCr,
        stepEnsureCrRemote,

        function stepGetIssueTitle(arg, next) {
            // We cache the main bug title normally
            if (arg.branchConfigTitle && !opts.update) {
                arg.issueTitle = arg.branchConfigTitle;
                next();
                return;
            }

            getIssueTitle(arg, arg, function (err, title) {
                if (!err) {
                    arg.issueTitle = title;
                }

                next(err);
            });
        },

        function printIssue(arg, next) {
            console.log('Issue: %s %s', arg.issueName, arg.issueTitle);
            next();
        },
        function printParenthetical(arg, next) {
            if (arg.parenthetical) {
                console.log('Parenthetical: %s', arg.parenthetical);
            }
            next();
        },

        function printExtraIssues(arg, next) {
            if (arg.extraIssues.length > 0) {
                console.log('Extra issues:');
                arg.extraIssues.forEach(function (issue) {
                    console.log('    %s %s', issue.issueId, issue.issueTitle);
                });
            }
            next();
        },

        stepEnsureOnIssueBranch,
        stepSetBranchConfigIssue,
        stepSetBranchConfigExtraIssues,
        stepSetBranchConfigTitle,
        stepSetBranchConfigParenthetical,

        // TODO: --commit

        stepGetGitCommits,
        stepGetCurrentCr,
        stepGetCommitMessage,

        function getCommitsToPush(arg, next) {
            if (arg.gitCommits.length === 0 ||
                (arg.branchConfigLastPushedSha &&
                    arg.branchConfigLastPushedSha === arg.gitCommits[0].sha))
            {
                if (arg.branchConfigCr) {
                    console.log('No new commits after %s',
                        arg.branchConfigLastPushedSha.slice(0, 12));
                }
                arg.commitsToPush = null;
                next();
                return;
            }

            arg.commitsToPush = [];
            for (var i = 0; i < arg.gitCommits.length; i++) {
                var commit = arg.gitCommits[i];
                if (arg.branchConfigLastPushedSha !== commit.sha) {
                    arg.commitsToPush.push(commit);
                } else {
                    break;
                }
            }
            console.log('New commits (%d):', arg.commitsToPush.length);
            arg.commitsToPush.forEach(function (c) {
                console.log('    %s %s', c.sha.slice(0, 7),
                    c.message.split(/\n/, 1)[0]);
            });
            next();
        },

        stepCreateUpdateCr,

        function printResult(arg, next) {
            switch (arg.crAction) {
            case 'none':
                if (arg.branchConfigCr) {
                    console.log('CR unchanged: %s <https://cr.joyent.us/%s>',
                        arg.branchConfigCr, arg.branchConfigCr);
                } else {
                    console.log('\nMake commits and run `grr` in this branch '
                        + 'to create a CR.');
                }
                break;
            case 'updateCommitMessage':
                console.log('CR commit message updated: %s patchset %s '
                        + '<https://cr.joyent.us/%s>',
                    arg.branchConfigCr,
                    arg.currentCr.currentPatchSet.number,
                    arg.branchConfigCr);
                break;
            case 'create':
                console.log('CR created: %s patchset %s '
                        + '<https://cr.joyent.us/%s>',
                    arg.branchConfigCr,
                    arg.currentCr.currentPatchSet.number,
                    arg.branchConfigCr);
                break;
            case 'update':
                console.log('CR updated: %s patchset %s '
                        + '<https://cr.joyent.us/%s>',
                    arg.branchConfigCr,
                    arg.currentCr.currentPatchSet.number,
                    arg.branchConfigCr);
                break;
            default:
                throw new VError('invalid crAction: ' + arg.crAction);
            }
            next();
        }
    ]}, cb);
}


module.exports = {
    grrDelete: grrDelete,
    grrList: grrList,
    grrReview: grrReview,
    grrUpdateOrCreate: grrUpdateOrCreate
};

// vim: set softtabstop=4 shiftwidth=4:
