# grr changelog

## 1.1.1 (not yet released)

(nothing yet)


## 1.1.0

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
