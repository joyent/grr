#!/bin/bash

#
# This is a proof of concept script to allow us to have a CLI squash and merge
# process that will:
#
# 1. elide interim "code review commits" from the final commit message
#    (basically anything other than ^PROJECT-1234 lines)
# 2. trawl the PR to add Reviewed By: comments based on who's actually
#    reviewed the change
#
# It is *only* a proof of concept so far, because hub(1) doesn't work the way
# we expect (see the XXX later) and because we're playing fast & loose with
# json and it's highly likely this will blow us up
#

PR=$1

if [[ -z "$PR" ]]; then
    echo 'Usage: add-reviewers <PR number>'
    exit 2
fi

if [[ -z "$EDITOR" ]]; then
    EDITOR=vi
fi

SUBMITTER=$(hub api "/repos/{owner}/{repo}/pulls/$PR" | json user.login)
REVIEWERS=$(hub api "/repos/{owner}/{repo}/pulls/$PR/reviews" | \
    json -a user.login | uniq | grep -v $SUBMITTER)

# get the commit messages and filter *only* ones that appear to be
# formal bugid/synopses pairs
hub api "/repos/{owner}/{repo}/pulls/$PR/commits" | \
    json -a commit.message | \
    grep "^[A-Z]+[0-9]+ " > /tmp/$$.commitmsg

for reviewer in $REVIEWERS; do
    hub api /users/$reviewer > /tmp/$$.user
    NAME=$(json -f /tmp/$$.user name 2> /dev/null)
    EMAIL=$(json -f /tmp/$$.user email 2> /dev/null)
    if [[ -n "$NAME" ]] && [[ -n "$EMAIL" ]] && [[ "$NAME" != "null" ]] && [[ "$EMAIL" != "null" ]]; then
        echo "Reviewed by: $NAME <$EMAIL>" >> /tmp/$$.commitmsg
    elif [[ -n "$EMAIL" ]] && [[ "$EMAIL" != "null" ]]; then
        echo "Reviewed by: $reviewer <$EMAIL>" >> /tmp/$$.commitmsg
    else
        echo "Reviewed by: $reviewer" >> /tmp/$$.commitmsg
    fi
    rm /tmp/$$.user
done

while [[ "$yn" != "y" ]]; do
    echo "Is the following commit message correct?"
    cat /tmp/$$.commitmsg
    echo -n "(y/n) > "
    read yn
    case $yn in
        'y')
            ;;
        'n')
            echo "Opening $EDITOR on commit message"
            sleep 1
            $EDITOR /tmp/$$.commitmsg
            ;;
        *)
            echo "unexpected answer"
    esac
done

SHA=$(hub api "/repos/{owner}/{repo}/pulls/$PR/commits" | json -a sha | tail -1)
COMMIT_HEAD=$(cat /tmp/$$.commitmsg | head -1)
COMMIT_TAIL=$(cat /tmp/$$.commitmsg | tail -n+2)

cat > /tmp/$$.merge.json <<END
{
    "merge_method": "squash",
    "sha": "$SHA",
    "commit_title": "$COMMIT_HEAD",
    "commit_message": "$COMMIT_TAIL"
}
END
cat /tmp/$$.merge.json

# XXX this is busted at the moment - hub(1) ignores the -X PUT, turns it into
# a POST and then github tells us to sod off
cat /tmp/$$.merge.json | hub api -i -X PUT "/repos/{owner}/{repo}/pulls/$PR/merge" -F -
#rm /tmp/$$.commitmsg
echo rm /tmp/$$.merge.json
