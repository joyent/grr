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
var prompt = require('prompt');
var restifyClients = require('restify-clients');
// commented out while we test. To have the temp module auto-delete the
// tempfile for us, uncomment this
//var temp = require('temp').track();
var temp = require('temp');
var VError = require('verror');

// the [section] of the .gitconfig where we store properties.
var CONFIG_SECTION = 'squashmerge';

// Some joyent users don't have email addresses in their github profiles.
// Fallback to this list instead. (XXX perhaps pull from a config file rather
// than baking this into the code)
var USER_EMAIL = {
};

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
// XXX timf needs better CLI arguments
log.info(process.argv)
var prNumber = process.argv[2].trim();

assert.string(prNumber, 'prNumber');

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
 * process.env.GITREPO value or process.env.PWD XXX add better feedback when
 * falling back to $PWD
 *
 * returns a callback(err, standard gitHub owner/repo string )
 */
function determineGitRepo(args, cb) {
    assert.object(args, 'arg');
    assert.func(cb, 'cb');

    var repoPath = process.env.GITREPO;
    if (!repoPath) {
        log.info('Falling back to $PWD instead of $GITREPO');
        repoPath = process.env.PWD;
    }

    var cfgPath = expandTilde(repoPath + '/.git/config');
    fs.exists(cfgPath, function(exists) {
        if (!exists) {
            cb(new VError(format('%s does not exist. ' +
                '$GITREPO or $PWD should point to a git repository', cfgPath)));
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

    var pullUrl = format(format('/repos/%s/pulls/%s', gitRepo, prNumber));
    log.info(pullUrl);
    gitClient.get(pullUrl,
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
            } else {
                if (USER_EMAIL[user]) {
                    contact += ' <' + USER_EMAIL[user] + '>';
                }
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

// Write a temporary file containing the commit title and commit message.
// returns a callback(err, path to file);
function writeCommitMessage(args, cb) {
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
        // currently enforcing a blank line between title and commit body
        fs.writeSync(info.fd, args.title + '\n\n');
        fs.writeSync(info.fd, args.messages.join("\n"));
        Object.keys(args.reviewerContacts).sort().forEach(
            function(reviewer, index) {
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

// returns a callback(err, process exit code) XXX a bit useless right now
function editCommitMessage(arg, cb) {
    assert.object(arg, 'arg');
    assert.string(arg.commitMessagePath, 'arg.commitMessagePath');
    assert.func(cb, 'cb');
    var editor = process.env.EDITOR || 'vi';
    // modify the commit message
    var child = child_process.spawnSync(editor, [arg.commitMessagePath], {
        stdio: 'inherit'
    });
    cb(null, child.status);
}

// reads the commit message from args.commitMessagePath and
// returns cb(err, commit title, commit body)
function readCommitMessage(args, cb) {
    assert.object(args, 'args');
    assert.string(args.commitMessagePath, 'args.commitMessagePath');
    assert.func(cb, 'cb');
    fs.readFile(args.commitMessagePath, function(err, data) {
        if (err) {
            cb(err);
            return;
        }
        var fullMessage = data.toString();
        var lines = fullMessage.split('\n');
        var title = lines[0];
        var msg_lines = [];
        for (var i = 1; i < lines.length; i++) {
            // skip the first blank line since that's the separator between
            // the github title, and subsequent commit message body.
            if (lines[i] === '' && i === 1) {
                continue;
            }
            msg_lines.push(lines[i]);
        }
        cb (err, title, msg_lines.join('\n'));
    });
}

// emits the current commit message, args.commitMessage and asks the user
// if it's acceptable. returns a callback(err, answer)
function yesNoPrompt(args, cb) {
    assert.object(args, 'args');
    assert.string(args.commitMessage, 'args.commitMessage');
    assert.func(cb, 'cb');

    log.info('Here is the commit message:');
    console.log(args.title);
    if (args.commitMessage) {
        console.log('\n' + args.commitMessage);
    }
    var user_question = 'Is this commit message ok?';
    var prompt_schema = {
        properties: {
            answer: {
                description: user_question,
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
                cb(new VError(
                    prompt_err,
                    'problem trying to prompt user'));
                return;
            }
            cb(null, result.answer);
    });
}

// iterate on the commit message, and invoke a
// callback(err, commit title, commit message)
function decideCommitMessage(arg, cb) {

    arg['commitMessageAccepted'] = false;
    mod_vasync.whilst(
        function guard() {
            if (!context.commitMessageAccepted) {
                log.debug('commit message has not yet been accepted');
                return true;
            }
            log.debug('commit message has been accepted');
            return false;
        },
        function loop(nextLoop) {
            mod_vasync.pipeline({
                arg: arg,
                funcs: [
                function modifyCommitMessage(arg, nextStage) {
                    editCommitMessage(arg,
                        function editedCommitMessage(err) {
                            if (err) {
                                nextStage(err);
                                return;
                            }
                            log.info('commit message has been edited');
                            nextStage();
                        });
                },
                function getCommitMessage(arg, nextStage) {
                    readCommitMessage(arg,
                        function collectCommitMessage(err, title, msg) {
                            if (err) {
                                nextStage(err);
                                return;
                            }
                            arg.title = title;
                            arg.commitMessage = msg;
                            nextStage();
                        });
                },
                function getYesNo(arg, nextStage) {
                    yesNoPrompt(arg,
                        function collectAnswer(err, answer) {
                            if (err) {
                                nextStage(err);
                                return;
                            }
                            if (answer === 'y') {
                                arg.commitMessageAccepted = true;
                            }
                            nextStage();
                        });
                }
            ]},
            function pipelineResults(err, results) {
                if (err) {
                    assert.fail(format('error: %s', err.message));
                }
                log.info('Our pipeline results are ' + JSON.stringify(results));
                nextLoop(null, context);
            });
        },
        function (err, result) {
            if (err) {
                assert.fail(format('error in loop: %s', err.message));
            }
            console.log('Finished loop ' + JSON.stringify(result));
            cb(null, arg.title, arg.commitMessage);
        });

}

// perform the squash+merge
function squashMerge(args, cb) {
    assert.object(args, 'args');
    assert.string(args.title, 'args.title');
    assert.string(args.lastCommit, 'args.lastCommit');
    assert.string(args.commitMessage, 'args.commitMessage');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');
    log.info({
        'merge_method': 'squash',
        'sha': args.lastCommit,
        'commit_title': args.title,
        'commit_message': args.commitMessage
    });

    gitClient.put(
        format('/repos/%s/pulls/%s/merge', args.gitRepo, args.prNumber),
        {
            'merge_method': 'squash',
            'sha': args.lastCommit,
            'commit_title': args.title,
            'commit_message': args.commitMessage
        },
        function putResp(err, req, res, obj) {
            if (err) {
                cb(err);
                return;
            }
            log.info(obj);
            cb(null, obj);
        }
    );
}

var context = {'prNumber': prNumber};
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
        function getCommitMessage(arg, nextStage) {
            writeCommitMessage(arg,
                function collectCommitMessagePath(err, path) {
                    if (err) {
                        nextStage(err);
                        return;
                    }
                    arg.commitMessagePath = path;
                    log.info('commit message is at ' + path);
                    nextStage();
                });
        },
        function validateCommitMessage(arg, next) {
            decideCommitMessage(arg,
                function gatherCommitMessage(err, title, msg) {
                    if (err) {
                        next(err);
                        return;
                    }
                    arg.title = title;
                    arg.commitMessage = msg;
                    next();
                });
        },
        function squashAndMerge(arg, next) {
            squashMerge(arg, function collectResult(err, result) {
                if (err) {
                    next(err);
                    return;
                }
                log.info('we did it');
                log.info(result);
                next();
            });
        }
    ]
}, function (err, results) {
        if (err) {
            assert.fail(format('error: %s', err.message));
        }
       log.info(JSON.stringify(results));
});