A new `grr` command to help work with gerrit a bit:

```
[trentm@danger0:~/tm/play (master)]
$ grr
grr: error: missing ISSUE argument
```

Give it a ticket to get started:

```
[trentm@danger0:~/tm/play (master)]
$ grr TOOLS-1516
Issue: TOOLS-1516 testing 1 2 3 grr
Creating branch for CR: grr-TOOLS-1516

Make commits and run `grr` in this branch to create a CR.
```

This throws you into a temporary feature branch `grr-$issue`. Make some
commits and type `grr` to update gerrit:

```
[trentm@danger0:~/tm/play (grr-TOOLS-1516)]
$ echo "feature X" >>README.md

[trentm@danger0:~/tm/play (grr-TOOLS-1516)]
$ git ci -am "added feature X"
[grr-TOOLS-1516 a0c494c] added feature X
 1 file changed, 1 insertion(+)

[trentm@danger0:~/tm/play (grr-TOOLS-1516)]
$ grr
Issue: TOOLS-1516 testing 1 2 3 grr
New commits (1):
    a0c494c added feature X
Creating CR:
    $ git checkout -t master -b grr/auto/TOOLS-1516
    Branch grr/auto/TOOLS-1516 set up to track local branch master.

    Switched to a new branch 'grr/auto/TOOLS-1516'

    $ git merge --squash grr-TOOLS-1516
    Updating a127928..a0c494c
    Fast-forward
    Squash commit -- not updating HEAD
     README.md | 1 +
     1 file changed, 1 insertion(+)

    $ git commit -m TOOLS-1516 testing 1 2 3 grr
    [grr/auto/TOOLS-1516 89bb4e2] TOOLS-1516 testing 1 2 3 grr
     1 file changed, 1 insertion(+)

    $ git push cr HEAD:refs/for/master
    remote:
    remote: Processing changes: new: 1, refs: 1
    remote: Processing changes: new: 1, refs: 1
    remote: Processing changes: new: 1, refs: 1, done
    remote:
    remote: New Changes:
    remote:   https://cr.joyent.us/275 TOOLS-1516 testing 1 2 3 grr
    remote:
    To trentm@cr.joyent.us:trentm/play.git
     * [new branch]      HEAD -> refs/for/master

CR created: 275 <https://cr.joyent.us/275>
```

It squashes all the commits (in a separate branch used only for this push)
and pushed to gerrit. Now make more commits and `grr` again to update:

```
[trentm@danger0:~/tm/play (grr-TOOLS-1516)]
$ git ci -am "fix it: call it little-x"
[grr-TOOLS-1516 0cd9100] fix it: call it little-x
 1 file changed, 1 insertion(+), 1 deletion(-)

[trentm@danger0:~/tm/play (grr-TOOLS-1516)]
$ grr
Issue: TOOLS-1516 testing 1 2 3 grr
New commits (1):
    0cd9100 fix it: call it little-x
Updating CR 275:
    $ git checkout -t master -b grr/auto/TOOLS-1516
    Branch grr/auto/TOOLS-1516 set up to track local branch master.

    Switched to a new branch 'grr/auto/TOOLS-1516'

    $ git merge --squash grr-TOOLS-1516
    Updating a127928..0cd9100
    Fast-forward
    Squash commit -- not updating HEAD
     README.md | 1 +
     1 file changed, 1 insertion(+)

    $ git commit -m TOOLS-1516 testing 1 2 3 grr
    [grr/auto/TOOLS-1516 f001bf2] TOOLS-1516 testing 1 2 3 grr
     1 file changed, 1 insertion(+)

    $ git push cr HEAD:refs/changes/275
    remote:
    remote: Processing changes: updated: 1, refs: 1
    remote: Processing changes: updated: 1, refs: 1
    remote: Processing changes: updated: 1, refs: 1, done
    remote:
    remote: Updated Changes:
    remote:   https://cr.joyent.us/275 TOOLS-1516 testing 1 2 3 grr
    remote:
    To trentm@cr.joyent.us:trentm/play.git
     * [new branch]      HEAD -> refs/changes/275

CR updated: 275 <https://cr.joyent.us/275>
```

It cached the CR number from earlier, so does the right thing on push.
If you look at <https://cr.joyent.us/275>, you'll notice that the commit
message format is handled for you.

When you are done, use `grr -D` to clean up (remove the branch) and it pops
you back to `master`:

```
[trentm@danger0:~/tm/play (grr-TOOLS-1516)]
$ grr -D
Removing grr config for branch "grr-TOOLS-1516"
Deleting local grr branch "grr-TOOLS-1516"
    $ git branch -D grr-TOOLS-1516
    Deleted branch grr-TOOLS-1516 (was 0cd9100).

[trentm@danger0:~/tm/play (master)]
$
```