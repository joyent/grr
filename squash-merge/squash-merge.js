/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * This walks through the given github pull request, collecting ticket/synopses
 * and eventually fires the squash/merge PUT api with a commit message that
 * has "Reviewed by:" lines generated from the reviewers of the pull request.
 *
 * The expectation is that it'll write a commit message file to disk, fire up
 * $EDITOR, ask "is this commit message ok" (in a loop till you
 * say 'y') and then merge+squash the change
 *
 * In future we might also choose to cross-check that the supplied Github
 * ticket synopsis matches the actual Jira synopsis, modulo '(fix build)' etc.
 * commits.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process');
var format = require('util').format;
var fs = require('fs');
var mod_vasync = require('vasync');
var parseGitConfig = require('parse-git-config');
var restifyClients = require('restify-clients');
var VError = require('verror');

// the [section] of the .gitconfig where we store properties.
var CONFIG_SECTION = 'squashmerge';

var log = bunyan.createLogger({
    name: 'squash-merge',
    serializers: bunyan.stdSerializers,
    stream: process.stdout
});

if (process.env.TRACE && process.env.TRACE !== '0') {
    log.level(bunyan.TRACE);
}

var gitClient = restifyClients.createJsonClient({
    log: log,
    url: 'https://api.github.com'
});

// XXX it feels wrong setting globals here and having our async.pipeline
// set these values. There must be a better way.
var submitter = null;
var submitterName = null;
var title = null;
// the most recent commit for this PR, needed when doing the squash+merge call
var lastCommit = null;

// We're using this object's keys to gather the set of tickets for this PR.
// XXX perhaps this will eventually need to be of the form
// { ticket1: ['synopsis', [message1, message2, ...]],
// { ticket2: ['synopsis', [message1, message2, ...]] }
var tickets = {};
// longer form messages describing a commit
var reviewers = {};
var gitRepo = null;
// XXX timf hardcoding 10 for now
var prNumber = 10;

// match JIRA-format ticket names, expected at the beginning of the line
var ticketRE = new RegExp('^[A-Z]+-[0-9]+ ');

/*
 * Rudimentary ~ directory expansion. This doesn't work for user-relative paths
 * such as "~timf/foo"
 */
function expandTilde(path) {
    if (path.indexOf('~/') === 0) {
        if (process.env.HOME !== undefined) {
            return path.replace('~/', process.env.HOME + '/');
        }
    }
    // give up.
    return path;
}

/*
 * set gitRepo to a "gituser/gitrepo" string from the repository pointed to by
 * process.env.GITREPO value. Eventually this should fall back to looking for
 * a git repository in $PWD as well, but we've not done that yet.
 */
function determineGitRepo(cb) {
    assert.string(process.env.GITREPO, 'Missing $GITREPO in environment');

    var cfgPath = expandTilde(process.env.GITREPO + '/.git/config');
    fs.exists(cfgPath, function(exists) {
        if (!exists) {
            cb(format('%s does not exist, check $GITREPO', cfgPath));
        }
        var gitConfig = parseGitConfig.sync({'path': cfgPath});
        if (gitConfig['remote "origin"'] === undefined) {
            cb(new VError('unable to determine git origin for ' + cfgPath));
        }
        var url = gitConfig['remote "origin"'].url;
        var gitUser = '';
        var gitRepoName = '';

        if (url.indexOf('http') !== 0 && url.indexOf('@') !== 0) {
            var repoPair = url.split(':')[1].split('/');
            gitUser = repoPair[0];
            gitRepoName = repoPair[1];
        } else {
            var urlElements = url.split('/');
            gitUser = urlElements[urlElements - 2];
            gitRepoName = urlElements[urlElements - 1];
        }
        if (gitRepoName.endsWith('.git')) {
            gitRepoName= gitRepoName.substr(0, gitRepoName.length - 4);
        }
        gitRepo = format('%s/%s', gitUser, gitRepoName);
        cb();
    });
}

/*
 * Get github credentials either from ~/.gitconfig e.g.
 * [squashmerge]
 *     githubUser = timfoster
 *     githubApiTokenFile = ~/.github_api_token_file
 *
 * Or via $GITHUB_USER and $GITHUB_API_TOKEN_FILE environment variables.
 * With this information, initialize our restifyClient.
 */
function initializeGitClient(cb) {
    // Get GitHub login credentials, and initialize our restifyClient
    var gitUserConfig = parseGitConfig.sync(
        {'path': expandTilde('~/.gitconfig')});
    var gitHubLoginUser = process.env.GITHUB_USER;
    if (gitHubLoginUser === undefined) {
        if (gitUserConfig[CONFIG_SECTION] !== undefined) {
            gitHubLoginUser = gitUserConfig[CONFIG_SECTION].githubUser;
        }
        if (gitHubLoginUser === undefined) {
            cb(new VError('unable to determine username from .gitconfig ' +
                'or $GITHUB_USER'));
            return;
        }
    }
    var tokenFile = process.env.GITHUB_API_TOKEN_FILE;
    if (process.env.GITHUB_API_TOKEN_FILE === undefined) {
        if (gitUserConfig[CONFIG_SECTION] !== undefined) {
            tokenFile = gitUserConfig[CONFIG_SECTION].githubApiTokenFile;
        }
    }
    if (tokenFile === undefined) {
        tokenFile = '~/.github-api-token';
    }
    tokenFile = expandTilde(tokenFile);
    fs.readFile(tokenFile, 'utf8', function(err, data) {
        if (err) {
            cb(new VError('failed to read %s: %s', tokenFile, err));
            return;
        }
        var gitHubAPIToken = data.trim();
        gitClient.basicAuth(gitHubLoginUser, gitHubAPIToken);
        cb();
    });
}

// gets miscellaneous properties from this PR, so far, the submitter and
// PR title. Hopefully the first commit also includes the primary ticket
// for this PR, but let's not take any chances in case it's only in the title.
function gatherPullRequestProps(cb) {
    gitClient.get(format('/repos/%s/pulls/%s', gitRepo, prNumber),
        function getPr(err, req, res, pr) {
            if (err !== null) {
                cb(err);
                return;
            }
            submitter = pr.user.login;
            title = pr.title;
            if (ticketRE.test(title)) {
                tickets[(title.split(' ')[0])] = pr.title;
            }
            cb();
        }
    );
}

// Gathers commit messages from the commits pushed as part of this PR
function gatherPullRequestCommits(cb) {
    gitClient.get(format('/repos/%s/pulls/%s/commits', gitRepo, prNumber),
        function getPr(err, req, res, commits) {
            if (err !== null) {
                cb(err);
                return;
            }
            commits.forEach(function processCommit(obj, index) {
                var lines = obj.commit.message.split('\n');
                lastCommit = obj.sha;
                lines.forEach(function extractTickets(line) {
                    if (ticketRE.test(line)) {
                        // record the jira ticket and full line
                        tickets[line.split(' ')[0]] = line.trim();
                    } else {
                        // not gathering long-form commit data yet, but we'll
                        // want to if commits start following long-form git
                        // commit message format.
                        log.warn('no match for line ', line);
                    }
                });
            });
            cb();
        }
    );
}

// trawl through commits to gather reviewer info
function gatherPullRequestReviewers(cb) {
    gitClient.get(format('/repos/%s/pulls/%s/reviews', gitRepo, prNumber),
        function getReviews(err, req, res, reviews) {
            if (err !== null) {
                cb(err);
                return;
            }
            reviews.forEach(function processReview(obj, index) {
                if (obj.user.login !== submitter) {
                    log.info('review username: ' + obj.user.login);
                    gatherUserNameInfo(
                        // invoke the cb() only when we've processed the
                        // final reviewer. XXX this isn't right. We're not
                        // always calling this on repeated runs of this program.
                        // I still don't get async js :-(
                        function cbOnLast(){
                            console.log(index);
                            if (index === reviews.length - 1) {
                                cb();
                            }
                        },
                        obj.user.login, function setName(name){
                            reviewers[obj.user.login] = name;
                        }
                    );
                }
            });
        }
    );
}

// get as much info about a reviewer user as we can, in order to fill out
// "Reviewed by: [First] [Last] <email address>"
// or fall back to:
// "Reviewed by: [username] <email address>"
// or finally
// "Reviewed by: [username]"
// Takes a callback, a user to lookup, and a function setName(full_name) which
// gets called with the result of the user lookup.
function gatherUserNameInfo(cb, user, setName) {
    gitClient.get('/users/' + user,
        function getUser(err, req, res, userInfo) {
            if (err !== null) {
                cb(err);
                return;
            }
            var fullName = null;
            var email = '';

            if (userInfo.name !== null) {
                fullName = userInfo.name;
            } else {
                fullName = user;
            }
            if (userInfo.email !== null) {
                email = ' <' + userInfo.email + '>';
            }
            setName(fullName + email);
            cb();
        });
}

// XXX we might want to pull ticket info directly from Jira, or use the
// commit message. In particular, for follow-ups, we might want exactly
// the line from the commit message
function gatherTicketInfo(cb) {
    ;
}

// actually perform the squash+merge
function squashMerge(cb) {
    // XXX intentionally forcing this to 404 for now
    gitClient.put(format('/reposXXX/%s/pulls/%s/merge', gitRepo, prNumber),
        {
            'merge_method': 'squash',
            'sha': lastCommit,
            'commit_title': title,
            'commit_message': 'XXX'
        },
        function putResp(err, req, res, obj) {
            if (err !== null) {
                cb(err);
                return;
            }
            cb();
        });
}

mod_vasync.pipeline({
    'funcs': [
        function getGitInfo(_, next) {
            determineGitRepo(next);
        },
        function setupClient(_, next) {
            initializeGitClient(next);
        },
        function getPrProps(_, next) {
            gatherPullRequestProps(next);
        },
        function getPrCommits(_, next) {
            gatherPullRequestCommits(next);
        },
        function getReviewers(_, next) {
            gatherPullRequestReviewers(next);
        },
        // XXX timf: sigh, this is also not working, This time, we tried to have
        // the previous pipeline step just populate reviewers with a set of names,
        // intending to have this pipeline stage fill in the user details.
        // This time we never seem to call next() at all :-/
        // function getReviewerInfo(_, next) {
        //     mod_vasync.forEachParallel({
        //         'func': function gatherReviewerInfo(reviewer) {
        //                 gatherUserNameInfo(_, reviewer, function setReviewer(name) {
        //                     reviewers[reviewer] = name;
        //             });
        //         },
        //         'inputs': Object.keys(reviewers)
        //     }, function (err, results) {
        //         console.log('error: %s', err.message);
        //         console.log('results: %s', JSON.stringify(results));
        //         next();
        //     });
        // },
        function getSubmitter(_, next, submitter) {
            if (submitter !== null) {
                gatherUserNameInfo(next, submitter,
                    function setSubmitter(name) {
                        submitterName = name;
                    });
            } else {
                next();
            }
        },
        // before doing this, we'll want some sort of 'is this message ok?' loop
        function fireUpEditor(_, next) {
            var editor = process.env.EDITOR || 'vi';
            // this will eventually be editing a proper tmpfile containing
            // the commit message we've built up.
            var child = child_process.spawnSync(editor, ['/tmp/commitmsg.txt'], {
                stdio: 'inherit'
            });

            child.on('exit', function (e, code) {
                log.info('editor exited ' + code);
                if (code === null) {
                    next();
                } else {
                    console.log('editor didn\'t exit 0!');
                }
            });
        },
        // yes it is ok, now squash and merge
        function doMerge(_, next) {
            squashMerge(next);
        }
    ]
}, function (err, results) {
        if (err) {
            assert.fail('error: %s', err.message);
        }
        log.info(format('submitter is %s (%s)', submitterName, submitter));
        Object.keys(reviewers).forEach(function(reviewer, index) {
            log.info('reviewer: ' + reviewers[reviewer]);
        });
        log.info('title is ' + title);
        log.info('tickets are ' + Object.keys(tickets).join(', '));
});