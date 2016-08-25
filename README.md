# grr

A `grr` CLI tool to help with using Joyent's code review (CR) tool, Gerrit, at:
<https://cr.joyent.us/>

## Install

**Not published yet.** For now you'll have to clone this repo and put the "bin"
dir on your PATH.

Verify that it is installed and on your PATH:

    $ grr --version
    Joyent grr 1.0.0


### Bash completion

XXX


## Usage

See [the example](docs/example.md) for now.


## Development Hooks

Before commiting be sure to, at least:

    make check      # lint and style checks
    make test       # run tests

A good way to do that is to install the stock pre-commit hook in your
clone via:

    make git-hooks

## License

MPL 2.0


## RFEs

- support GH issues
- support an option (in config and per branch) to push to a remote GH branch
  as well for every `grr`. Then have some of the GH branch utilities
  (nicer full diff, seeing individual commits as they were made, ability to
  use jenkins.joyent.us `TRY_BRANCH`)
- support pulling ticket title from smartos.org/bugview for public issues
  (then don't have to be internal Joyent Eng to use `grr`)
- perhaps add draft support: `git push origin HEAD:refs/drafts/master`
  This makes a "Draft" CR that only those added as reviewers can see. I
  don't know if there are other implications.
