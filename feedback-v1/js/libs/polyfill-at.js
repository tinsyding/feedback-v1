/**
 * Polyfill for Array.prototype.at, String.prototype.at, and %TypedArray%.prototype.at (ECMAScript 2022)
 *
 * 规范参考: https://tc39.es/ecma262/#sec-array.prototype.at
 * 支持环境: Chrome 92+, Safari 15.4+, Node 16.6+ 原生支持
 * 本脚本用于向后兼容 Chrome 86 (如 360安全浏览器、QQ浏览器旧版双核等)、旧版 Safari 等环境。
 */
(function () {
    'use strict';
    function at(n) {
        if (this == null) {
            throw new TypeError('Cannot call at on ' + this);
        }
        var O = Object(this);
        var len = O.length >>> 0;
        var k = Math.trunc(n) || 0;
        if (k < 0) k += len;
        return (k < 0 || k >= len) ? undefined : O[k];
    }

    var targets = [Array.prototype];
    if (typeof String !== 'undefined' && String.prototype) {
        targets.push(String.prototype);
    }
    if (typeof Uint8Array !== 'undefined') {
        var typedArrayProto = Object.getPrototypeOf(Uint8Array).prototype;
        if (typedArrayProto) {
            targets.push(typedArrayProto);
        }
    }

    for (var i = 0; i < targets.length; i++) {
        var proto = targets[i];
        if (proto && typeof proto.at !== 'function') {
            try {
                Object.defineProperty(proto, 'at', {
                    value: at,
                    writable: true,
                    enumerable: false,
                    configurable: true
                });
            } catch (e) {
                proto.at = at;
            }
        }
    }
})();
