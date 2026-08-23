/** @module Interface wasmos:abi/control@0.1.0 **/
export function boot(features: FeatureReport): BootStatus;
export function mount(path: string, on: Backend): void;
export function fsWrite(path: string, bytes: Uint8Array): void;
export function fsRead(path: string): Uint8Array;
export function fsList(path: string): Array<string>;
export function fsDelete(path: string): void;
export function fsMkdirp(path: string): void;
export function seedEntropy(seed: Uint8Array): void;
export function spawn(spec: SpawnSpec): number;
export function spawnEmulator(name: string): number;
export function accountEmulator(pid: number, ticks: bigint): void;
export function deliverNet(pid: number, ok: boolean, body: Uint8Array): Uint32Array;
export function serviceSyscall(pid: number, request: Uint8Array): SyscallOutcome;
export function deliverStdin(pid: number, bytes: Uint8Array): Uint32Array;
export function deliverInput(pid: number, bytes: Uint8Array): InputDelivery;
export function bindTerminal(pid: number): void;
export function setProcMem(pid: number, bytes: number): void;
export function setPriority(pid: number, priority: number): void;
export function exitCode(pid: number): number | undefined;
export function takeCapture(pid: number): [Uint8Array, Uint8Array];
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
  priority: number,
  cpuTicks: bigint,
  memBytes: number,
  parent: number,
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
export interface SpawnSpec {
  name: string,
  grantFsSubtree: string,
  grantSpawn: boolean,
  grantGpu: boolean,
  grantInput: boolean,
  grantSignal: boolean,
  grantNet: boolean,
}
export interface SpawnRequest {
  pid: number,
  imagePath: string,
  terminalStdin: boolean,
}
export interface NetRequest {
  pid: number,
  url: string,
}
export interface SyscallOutcome {
  reply?: Uint8Array,
  wakeups: Uint32Array,
  termOutput: Uint8Array,
  spawn?: SpawnRequest,
  reap: Uint32Array,
  net?: NetRequest,
  termMode?: number,
}
export interface InputDelivery {
  accepted: boolean,
  wakeups: Uint32Array,
}
