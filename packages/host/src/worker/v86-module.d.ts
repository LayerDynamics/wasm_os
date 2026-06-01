// Minimal ambient types for the vendored v86 ESM build (third_party/v86/libv86.mjs,
// GPLv2). v86 ships full types in its package; this declares just the surface the
// emulator worker uses so `tsc --noEmit` type-checks the import.
declare module "*/libv86.mjs" {
  export interface V86Image {
    url?: string;
    buffer?: ArrayBuffer | Uint8Array;
    async?: boolean;
    size?: number;
  }
  export interface V86Options {
    wasm_path?: string;
    bios?: V86Image;
    vga_bios?: V86Image;
    bzimage?: V86Image;
    initrd?: V86Image;
    cmdline?: string;
    autostart?: boolean;
    disable_keyboard?: boolean;
    disable_speaker?: boolean;
    memory_size?: number;
    vga_memory_size?: number;
    filesystem?: { fs?: unknown; basefs?: unknown; baseurl?: string };
    bzimage_initrd_from_filesystem?: boolean;
  }
  export class V86 {
    constructor(options: V86Options);
    run(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    restart(): void;
    add_listener(event: string, listener: (arg: never) => void): void;
    remove_listener(event: string, listener: (arg: never) => void): void;
    serial0_send(data: string): void;
    keyboard_send_text(text: string): void;
    keyboard_send_scancodes(codes: number[]): void;
  }
}
