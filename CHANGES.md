# grr changelog

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
