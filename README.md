This repo provides a single `grr` CLI tool to help with using Joyent's code
review (CR) tool, Gerrit, at: <https://cr.joyent.us/>.

Grr is opinionated. The expected workflow is this:

1. You call **`grr <issue>`** to tell grr to create a temporary local branch
   (`grr/<issue>`) for work on this issue (if you are currently on "master"),
   or to use your current branch (if you are already on a non-"master" branch).
   Grr will fetch issue details and remember them (in local git config).
2. You make one or more commits, **`git commit -am ...`**, for your change.
3. You call **`grr`** to create/update the CR. Grr will squash the commits (in a
   temporary `grr/auto/<issue>` branch), push the commit (with the appropriate
   commit message) to cr.joyent.us, and remember the CR number.
4. **Get approvals** for your CR, and/or cycle back to step #2.
5. When you get approval, run **`grr`** one last time to update the commit
   message with "Reviewed by" and "Approved by" lines.
6. **Integrate your change** (in the web UI, grr doesn't yet do this), then use
   **`grr -D`** to clean up (delete the `grr/<issue>` branch and switch back to
   master).

See [this example](docs/example.md) for a walk through.


## Install

    npm install -g joyent-grr

Verify that it is installed and on your PATH:

    $ grr --version
    grr 1.2.0
    https://github.com/joyent/grr


## Development Hooks

Before commiting be sure to, at least:

    make check      # lint and style checks
    make test       # run tests

A good way to do that is to install the stock pre-commit hook in your
clone via:

    make git-hooks

## License

MPL 2.0
