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
var format = require('util').format;
var fs = require('fs');
var mod_vasync = require('vasync');
var mod_util = require('util');
var parseGitConfig = require('parse-git-config');
var restifyClients = require('restify-clients');
var VError = require('verror');

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

// XXX read from ~/.github-api-token instead
gitClient.basicAuth('timfoster', 'sjgdhfjfgfjgdhsfsjhfgsjhgfjsgdhfjdghsf');


// XXX timf: it feels wrong setting globals here and having our async.pipeline
// set these values. There must be a better way.
var submitter = null;
var title = null;

// We're using this object's keys to gather the set of tickets for this PR.
var tickets = {};
var reviewers = {};
var msgs = [];
var gitRepo = null;
// XXX timf hardcoding 10 for now
var prNumber = 10;

// match JIRA-format ticket names, expected at the beginning of the line
var ticketRE = new RegExp('^[A-Z]+-[0-9]+ ');

/*
 * return a "gituser/gitrepo" string from the repository pointed to by
 * process.env.GITREPO value. Eventually this shuold fall back to using $PWD
 */
function determineGitRepo(cb) {
    assert.string(process.env.GITREPO, 'Missing $GITREPO in environment');

    var cfgPath = process.env.GITREPO + '/.git/config';
    fs.exists(cfgPath, function(exists) {
        if (!exists) {
            cb(format('%s does not exist, check $GITREPO', cfgPath));
        }
        var gitConfig = parseGitConfig.sync({'path': cfgPath});
        if (gitConfig['remote "origin"'] === undefined) {
            cb('unable to determine git origin for ' + cfgPath);
        }
        var url = gitConfig['remote "origin"'].url;
        var gitUser = '';
        var gitRepoName = '';
        log.warn(url);
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

// gets miscellaneous properties from this PR, so far, the submitter and
// PR title. Hopefully the first commit also includes the primary ticket
// for this PR, but let's not take any chances..
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
                log.info(obj.author.login);
                log.warn(obj.commit.message);
                var lines = obj.commit.message.split('\n');
                lines.forEach(function extractTickets(line) {
                    if (ticketRE.test(line)) {
                        tickets[line.split(' ')[0]] = line;
                    } else {
                        log.warn('no match for line ', line);
                    }
                });
            });
            cb();
        }
    );
}

// get as much info about a reviewer user as we can, in order to fill out
// "Reviewed by: [First] [Last] <email address>"
// or fall back to:
// "Reviewed by: [username] <email address>"
// or finally
// "Reviewed by: [username]"
function gatherReviewerNameInfo(cb) {
    ;
}

// trawl through commits to gather reviewer info
function gatherReviewerInfo(cb) {
    ;
}

// XXX we might want to pull ticket info directly from Jira, or use the
// commit message. In particular, for follow-ups, we might want exactly
// the line from the commit message
function gatherTicketInfo(cb) {
    ;
}

mod_vasync.pipeline({
    'funcs': [
        function getGitInfo(_, next) {
            determineGitRepo(next);
        },
        function getPrProps(_, next) {
            gatherPullRequestProps(next);
        },
        function getPrCommits(_, next) {
            gatherPullRequestCommits(next);
        }
    ]
}, function (err, results) {
        if (err) {
            log.error('error: %s', err.message);
        }
        log.info('submitter is ' + submitter);
        log.info('title is ' + title);
        log.info('tickets are ' + Object.keys(tickets).join(', '));
});

