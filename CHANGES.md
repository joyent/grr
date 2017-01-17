# grr changelog

## not yet released

## 1.5.0

- When pushing new commits the author of the latest commit will be used, rather
  than necessarily you. That means you can make a slight tweak to someone
  else's CR, commit your tweak with `git commit --author="The Other Guy
  <guy@example.com>" ...` and then run `grr` without steal credit for all the
  real work.

## 1.4.0

- Change to using 'grr-$issue' instead of 'grr/$issue' for the created working
  branch, because the '/' might cause issues with Joyent `TRY_BRANCH` builds.

## 1.3.2

- Release 1.3.1 broke things. Fix that.

## 1.3.1

- Allow the origin git URL to not have trailing ".git".

## 1.3.0

- `grr -p PARENTHETICAL` to add a parenthetical to the commit message. Usage:

        $ grr -p "fix make check" ISSUE
        ...
        $ git commit -am "..."
        $ grr

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
