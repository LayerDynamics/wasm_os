/** @module Interface wasmos:abi/sys-store@0.1.0 **/
export function get(key: string): Uint8Array | undefined;
export function put(key: string, value: Uint8Array): boolean;
export function listKeys(prefix: string): Array<string>;
export { _delete as delete };
function _delete(key: string): boolean;
