# grr changelog

## 1.2.4

- Correct `gerritUsername` in the fix in 1.2.3.


## 1.2.3

**Bad release. Use 1.2.4.**

- Need to use the gerritUsername (that was determined earlier) when doing "ssh
  cr.joyent.us".


## 1.2.2

- Fix `grr` in a branch with a stored JIRA issue. (This was broken in v1.1.0).


## 1.2.1

- Fix `grr -D` assert on `opts.dryRun`.


## 1.2.0

- `grr` will update the commit message to include "Reviewed by" and
  "Approved by" lines according to approvals on the latest patchset.


## 1.1.1

- Fix `AssertionError: opts.dryRun (bool) is required` error for every
  invocation.

## 1.1.0

**Bad release. Use 1.1.1.**

- Support GitHub issues.

- The `<issue>` CLI argument supports a few forms (e.g. the full URL) to simplify
  cutting and pasting:

        grr TOOLS-1531
        grr https://devhub.joyent.com/jira/browse/TOOLS-1531
        grr 6
        grr https://github.com/joyent/sdc-triton/issues/6
        grr joyent/sdc-triton#6

- Added commit messages are posted as a review message on the CR.

## 1.0.0

First working version.
