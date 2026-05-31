/** @module Interface wasmos:abi/control@0.1.0 **/
export function boot(features: FeatureReport): BootStatus;
export function mount(path: string, on: Backend): void;
export function fsWrite(path: string, bytes: Uint8Array): void;
export function fsRead(path: string): Uint8Array;
export function fsList(path: string): Array<string>;
export function fsDelete(path: string): void;
export function listProcs(): Array<ProcInfo>;
/**
 * # Variants
 * 
 * ## `"tmpfs"`
 * 
 * ## `"opfs"`
 * 
 * ## `"idb"`
 */
export type Backend = 'tmpfs' | 'opfs' | 'idb';
export interface ProcInfo {
  pid: number,
  name: string,
  state: string,
}
export interface FeatureReport {
  sharedArrayBuffer: boolean,
  crossOriginIsolated: boolean,
  opfs: boolean,
  jspi: boolean,
  tier: string,
}
export interface BootStatus {
  ready: boolean,
  bootMillis: number,
  features: FeatureReport,
}
export type FsError = FsErrorNotFound | FsErrorIoFailure | FsErrorBadPath;
export interface FsErrorNotFound {
  tag: 'not-found',
}
export interface FsErrorIoFailure {
  tag: 'io-failure',
  val: string,
}
export interface FsErrorBadPath {
  tag: 'bad-path',
  val: string,
}
