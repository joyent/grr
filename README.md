# grr

A `grr` CLI tool to help with using Joyent's code review (CR) tool, Gerrit, at:
<https://cr.joyent.us/>

## Install

    npm install -g joyent-grr

Verify that it is installed and on your PATH:

    $ grr --version
    Joyent grr 1.1.0


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
