/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var assert = require('assert-plus');

// ---- support stuff

function objCopy(obj, target) {
    assert.object(obj, 'obj');
    assert.optionalObject(obj, 'target');

    if (target === undefined) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


function deepObjCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}


//---- exports

module.exports = {
    objCopy: objCopy,
    deepObjCopy: deepObjCopy
};

// vim: set softtabstop=4 shiftwidth=4:
