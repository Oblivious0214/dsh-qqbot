/** Model text has only one input: the explicitly permitted projection. */
import type { ModelProjection } from './types.ts';
export declare const UPDATE_TOOL = "qqbot_update_state";
export declare const STATE_GUIDANCE = "\u4F9D\u636E\u5F53\u524D\u72B6\u6001\u548C\u5DF2\u751F\u6548\u8BBE\u5B9A\u56DE\u5E94\u3002";
export declare const UPDATE_DESCRIPTION = "\u4F9D\u636E\u5F53\u524D\u72B6\u6001\u548C\u5DF2\u751F\u6548\u8BBE\u5B9A\u56DE\u5E94\u3002\u6309\u5B57\u6BB5\u66F4\u65B0\u89C4\u5219\uFF0C\u7528 qqbot_update_state \u63D0\u4EA4\u672C\u8F6E\u53D8\u5316\u540E\u7684\u503C\uFF1B\u66F4\u65B0\u4ECE\u4E0B\u4E00\u8F6E\u751F\u6548\u3002";
export declare function renderModelProjection(projection: ModelProjection): string;
export declare const UPDATE_PARAMETERS: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["changes"];
    readonly properties: {
        readonly changes: {
            readonly type: "array";
            readonly minItems: 1;
            readonly maxItems: 32;
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["name", "value"];
                readonly properties: {
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly value: {
                        readonly oneOf: readonly [{
                            readonly type: "number";
                        }, {
                            readonly type: "string";
                        }, {
                            readonly type: "boolean";
                        }];
                    };
                };
            };
        };
    };
};
