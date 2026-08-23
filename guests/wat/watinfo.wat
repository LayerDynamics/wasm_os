(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32)
      (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  ;; Read iovec at 0: { buffer = 256, capacity = 128 }.
  ;; Output iovecs at 8 and 16: prefix first, then the live file contents.
  ;; Error iovec at 20: { buffer = 512, length = 32 }.
  (data (i32.const 0)
    "\00\01\00\00\80\00\00\00"
    "\80\01\00\00\0c\00\00\00"
    "\00\01\00\00\00\00\00\00"
    "\00\02\00\00\20\00\00\00")

  (data (i32.const 128) "/proc/uptime")
  (data (i32.const 384) "WAT uptime: ")
  (data (i32.const 512) "WAT could not read /proc/uptime\n")

  (func $write_error
    (i32.const 1)
    (i32.const 20)
    (i32.const 1)
    (i32.const 28)
    call $fd_write
    drop
    (i32.const 1)
    call $proc_exit
  )

  (func (export "_start")
    (local $errno i32)
    (local $fd i32)
    (local $nread i32)

    ;; path_open(3, 0, "/proc/uptime", 12, 0, FD_READ, 0, 0, &fd)
    (i32.const 3)
    (i32.const 0)
    (i32.const 128)
    (i32.const 12)
    (i32.const 0)
    (i64.const 2)
    (i64.const 0)
    (i32.const 0)
    (i32.const 24)
    call $path_open
    local.tee $errno
    if
      call $write_error
    end
    (i32.load (i32.const 24))
    local.set $fd

    ;; fd_read(fd, &read_iovec, 1, &bytes_read)
    local.get $fd
    (i32.const 0)
    (i32.const 1)
    (i32.const 28)
    call $fd_read
    local.tee $errno
    if
      local.get $fd
      call $fd_close
      drop
      call $write_error
    end

    ;; Set output_iovec[1].length to the number of bytes read.
    i32.const 28
    i32.load
    local.set $nread
    i32.const 16
    local.get $nread
    i32.store offset=4

    ;; fd_write(1, output_iovecs, 2, &bytes_written)
    (i32.const 1)
    (i32.const 8)
    (i32.const 2)
    (i32.const 28)
    call $fd_write
    local.set $errno

    local.get $fd
    call $fd_close
    drop

    local.get $errno
    if
      (i32.const 1)
      call $proc_exit
    end
    (i32.const 0)
    call $proc_exit
  )
)
