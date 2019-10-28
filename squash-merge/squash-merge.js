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
// commented out while we test. To have the temp module auto-delete the
// tempfile for us, uncomment this
//var temp = require('temp').track();
var temp = require('temp');
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
var prNumber = 40;

// match JIRA-format ticket names, expected at the beginning of the line
var TICKET_RE = new RegExp('^[A-Z]+-[0-9]+ ');

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
 * Compute the "gituser/gitrepo" string from the repository pointed to by
 * process.env.GITREPO value. Eventually this should fall back to looking for
 * a git repository in $PWD as well, but we've not done that yet.
 *
 * returns a callback(err, standard gitHub owner/repo string )
 */
function determineGitRepo(args, cb) {
    assert.object(args, 'arg');
    assert.func(cb, 'cb');

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
            gitUser = urlElements[urlElements.length - 2];
            gitRepoName = urlElements[urlElements.length - 1];
        }
        if (gitRepoName.endsWith('.git')) {
            gitRepoName= gitRepoName.substr(0, gitRepoName.length - 4);
        }
        gitRepo = format('%s/%s', gitUser, gitRepoName);
        cb(null, gitRepo);
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
 *
 * invokes a callback(error) if any errors occur, callback() otherwise
 */
function initializeGitClient(cb) {
    assert.func(cb, 'cb');

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
// requires args.gitRepo, a github standard user/repo pair.
// returns a callback(error, submitter, title, {'ticket-id': 'ticket title', ...})
function gatherPullRequestProps(args, cb) {
    assert.object(args, 'args');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.func(cb, 'cb');

    gitClient.get(format('/repos/%s/pulls/%s', gitRepo, prNumber),
        function getPr(err, req, res, pr) {
            var tickets = {};
            if (err !== null) {
                cb(err);
                return;
            }
            submitter = pr.user.login;
            title = pr.title;
            if (TICKET_RE.test(title)) {
                tickets[(title.split(' ')[0])] = pr.title;
            }
            cb(null, submitter, title, tickets);
        }
    );
}

// Gathers commit messages from the commits pushed as part of this PR
// requires args.gitRepo, a standard github user/repo pair
//          args.tickets, any existing tickets we have
// calls a callback(error, lastCommit, object with updated ticket info for this commit, messages)
function gatherPullRequestCommits(args, cb) {
    assert.object(args, 'args');
    assert.object(args.tickets, 'args.tickets');
    assert.string(args.gitRepo, 'args.gitRepo');

    assert.func(cb, 'cb');
    gitClient.get(format('/repos/%s/pulls/%s/commits', args.gitRepo, prNumber),
        function getPr(err, req, res, commits) {
            if (err !== null) {
                cb(err);
                return;
            }
            var tickets = args.tickets;
            var messages = [];
            commits.forEach(function processCommit(obj, index) {
                var lines = obj.commit.message.split('\n');
                lastCommit = obj.sha;
                lines.forEach(function extractTickets(line) {
                    if (TICKET_RE.test(line)) {
                        // record the jira ticket and full line
                        tickets[line.split(' ')[0]] = line.trim();
                    } else {
                        messages.push(line.trim());
                    }
                });
            });
            cb(null, lastCommit, tickets, messages);
        }
    );
}

// trawl through commits to gather reviewer info
// calls a callback(error, array of reviewers)
function gatherPullRequestReviewers(args, cb) {
    assert.object(args, 'args');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.func(cb, 'cb');

    gitClient.get(format('/repos/%s/pulls/%s/reviews', args.gitRepo, prNumber),
        function getReviews(err, req, res, reviews) {
            if (err !== null) {
                cb(err);
                return;
            }
            // we don't have a format Set object, so make do with this
            var reviewers = {};
            reviews.forEach(function processReview(obj, index) {
                if (obj.user.login !== submitter) {
                    reviewers[obj.user.login] = true;
                }
            });
            cb(null, Object.keys(reviewers));
        }
    );
}

// calls a callback (err, reviewerContacts)
function gatherReviewerContacts(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfString(args.reviewers, 'args.reviewers');
    assert.func(cb, 'cb');

    var reviewerContacts = {};
    mod_vasync.forEachParallel({
        inputs: args.reviewers,
        // I commonly have a pattern in `vasync.forEach*`
        // to use `nextFoo` as my callback name.
        func: function handleOneLogin(login, nextLogin) {
            emailContactFromUsername({user: login}, function (err, contact) {
                if (err) {
                    nextLogin(err);
                } else {
                    reviewerContacts[login] = contact;
                    nextLogin();
                }
            });
        }
    }, function doneAllLogins(err) {
        cb(err, reviewerContacts);
    });
}

// Get an email contact, e.g. "John Doe <john@example.com>", from
// a GitHub username. Fall back to just the username, or the username
// with no email address.
//
// @param {Object} args.user - The github username.
// @param {Function} cb - `function (err, contact)`
function emailContactFromUsername(args, cb) {
    assert.object(args, 'args');
    assert.string(args.user, 'args.user');

    var user = args.user;

    gitClient.get('/users/' + user,
        function getUser(err, req, res, userInfo) {
            if (err) {
                cb(err);
                return;
            }
            var contact = userInfo.name || user;
            if (userInfo.email) {
                contact += ' <' + userInfo.email + '>';
            }

            cb(null, contact);
        });
}

// XXX we might want to pull ticket info directly from Jira, or use the
// commit message. In particular, for follow-ups, we might want exactly
// the line from the commit message
function gatherTicketInfo(cb) {
    ;
}

// XXX For now, this is just writing a version of commit message to a
// tempfile and returning the path we need to use mod_async.whilst,
// and have it prompt to load vi on the result
function editCommitMessage(args, cb) {
    assert.object(args, 'args')
    assert.string(args.title, 'args.title');
    assert.object(args.reviewerContacts, 'args.reviewerContacts');
    assert.arrayOfString(args.messages, 'args.messages');
    assert.func(cb, 'cb');

    temp.open({suffix: '.txt'}, function(err, info) {
        if (err) {
            cb(err);
            return;
        }
        fs.writeSync(info.fd, args.title + '\n\n');
        fs.writeSync(info.fd, args.messages.join("\n"));
        fs.writeSync(info.fd, '\n');
        Object.keys(args.reviewerContacts).sort().forEach(function(reviewer, index) {
                fs.writeSync(info.fd, format(
                    'Reviewed by: %s\n', args.reviewerContacts[reviewer]));
        });
        fs.close(info.fd, function(err) {
          if (err) {
              cb(err);
              return;
          }
          cb(null, info.path);
        });
    });

}
        // XXX just placeholder code for now
        // // before doing this, we'll want some sort of 'is this message ok?' loop
        // function fireUpEditor(arg, next) {
        //     var editor = process.env.EDITOR || 'vi';
        //     // this will eventually be editing a proper tmpfile containing
        //     // the commit message we've built up.
        //     var child = child_process.spawnSync(editor, ['/tmp/commitmsg.txt'], {
        //         stdio: 'inherit'
        //     });

        //     child.on('exit', function (e, code) {
        //         log.info('editor exited ' + code);
        //         if (code === null) {
        //             next();
        //         } else {
        //             console.log('editor didn\'t exit 0!');
        //         }
        //     });
        // },
        // // yes it is ok, now squash and merge
        // function doMerge(arg, next) {
        //     squashMerge(next);
        // }

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
            if (err) {
                cb(err);
                return;
            }
            cb();
        });
}

var context = {'cat': 'meow'};
mod_vasync.pipeline({
    arg: context,
    funcs: [
        function getGitInfo(arg, next) {
            determineGitRepo(arg, function collectGitRepo(err, gitRepo) {
                if (err) {
                    next(err);
                    return;
                }
                arg.gitRepo = gitRepo;
                next();
            });
        },
        function setupClient(arg, next) {
            initializeGitClient(next);
        },
        function getPrProps(arg, next) {
            gatherPullRequestProps(arg,
                function collectProps(err, submitter, title, tickets) {
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.submitter = submitter;
                    arg.title = title;
                    arg.tickets = tickets;
                    next();
                });
        },
        function getPrCommits(arg, next) {
            gatherPullRequestCommits(arg,
                function collectPRCommits(err, lastCommit, tickets, msgs){
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.tickets = tickets;
                    arg.lastCommit = lastCommit;
                    arg.messages = msgs;
                    next();
            });
        },
        function getReviewers(arg, next) {
            gatherPullRequestReviewers(arg,
                function collectPRReviewers(err, reviewers){
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.reviewers = reviewers;
                    next();
                });
        },
        function getReviewerContacts(arg, next) {
            gatherReviewerContacts(arg,
                function collectReviewerContacts(err, reviewerContacts) {
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.reviewerContacts = reviewerContacts;
                    next();
                });
        },
        function getSubmitterContact(arg, next) {
            emailContactFromUsername({user: arg.submitter},
                function collectSubmitter(err, submitterContact) {
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.submitterContact = submitterContact;
                    next();
                });
        },
        function produceCommitMessage(arg, next) {
            editCommitMessage(arg, function collectCommitMessage(err, path) {
                if (err) {
                    next(err);
                    return;
                }
                arg.commitMessagePath = path;
                log.info('commit message is at ' + path);
                next();
            });
        }
    ]
}, function (err, results) {
        if (err) {
            assert.fail('error: %s', err.message);
        }
       log.info(JSON.stringify(results));
});